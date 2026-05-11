import { W } from "../world/state.js";
import { manhattan, key, R } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";
import { aStar } from "./astar.js";
import { carriedParcels, isGoalBlacklisted, validGoal } from "../world/helpers.js";
import { inKnownBounds } from "../world/tiles.js";
import { CFG, debug } from "../config.js";
import { PddlDomain, PddlAction, PddlProblem, PddlExecutor, onlineSolver, Beliefset } from "../@unitn-asa/pddl-client/index.js";

//per permettere una consegna obbligata
let forcedDeliveryTarget = null;
let spawnPatrolIndex = -1;
let currentSpawnPatrolTarget = null;
export let pddlRequestInFlight = false;
export let usingPddlPath = false;

export function setUsingPddlPath(v) {
  usingPddlPath = !!v;
}

//creating variable to avoid computing frontier if non is found
let existFrontier = true;

export function nearestDeliveryFrom(x, y) {
  let best = null;
  let d = Infinity;

  for (const z of W.deliveryTiles) {
    const dist = manhattan(x, y, z.x, z.y);
    if (dist < d) {
      d = dist;
      best = z;
    }
  }

  return best;
}

export function nearestDelivery() {
  return nearestDeliveryFrom(W.me.x, W.me.y);
}

export function utility(p) {
  const distToParcel = manhattan(W.me.x, W.me.y, p.x, p.y);
  const dz = nearestDeliveryFrom(p.x, p.y);
  const distToDelivery = dz ? manhattan(p.x, p.y, dz.x, dz.y) : 0;

  return Math.pow(p.reward, CFG.DECAY_WEIGHT) /
    (1 + distToParcel + 0.35 * distToDelivery);
}

export function bestParcel() {
  let best = null;
  let bestU = -Infinity;
  
  let carriedByCount = 0;
  let blacklistedCount = 0;
  let consideredCount = 0;

  for (const p of W.parcelList) {
    if (p.carriedBy) {
      carriedByCount++;
      continue;
    }
    if (isGoalBlacklisted(p)) {
      blacklistedCount++;
      continue;
    }

    consideredCount++;
    const u = utility(p);
    
    if (u > bestU) {
      bestU = u;
      best = p;
    }
  }
  
  return best;
}

function bestAdjacentParcel() {
  let best = null;
  let bestReward = -Infinity;

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (manhattan(W.me.x, W.me.y, p.x, p.y) !== 1) continue;

    const reward = Number(p.reward ?? 0);
    if (reward > bestReward) {
      bestReward = reward;
      best = p;
    }
  }

  return best;
}

export function bestKnownApproachTile(tx, ty) {
  let best = null;
  let bestScore = Infinity;

  for (const t of W.tiles.values()) {
    const path = aStar(W.me.x, W.me.y, t.x, t.y);
    if (path === null) continue;

    const guessedPenalty = t.guessed ? 0.2 : 0;
    const score =
      path.length +
      2 * manhattan(t.x, t.y, tx, ty) +
      guessedPenalty;

    if (score < bestScore) {
      bestScore = score;
      best = { x: t.x, y: t.y, path };
    }
  }

  return best;
}

export function frontierTiles() {
  const arr = [];

  for (const t of W.tiles.values()) {
    let frontier = false;

    for (const d of DIRS) {
      const nx = t.x + d.dx;
      const ny = t.y + d.dy;
      const nk = key(nx, ny);

      if (!inKnownBounds(nx, ny)) continue;
      if (!W.tiles.has(nk) && !W.tempBlocked.has(nk)) {
        frontier = true;
        break;
      }
    }

    if (frontier) arr.push({ x: t.x, y: t.y });
  }

  return arr;
}

//togli async se non tornano i risultati
export async function planPathToTarget(target) {

  if (!target) return [];
  if (isGoalBlacklisted(target)) return null;
  if (!validGoal(target)) return null;

  const direct = aStar(W.me.x, W.me.y, target.x, target.y);
  const directHitsBox = Array.isArray(direct) && direct.length > 0 && pathHitsBox(W.me.x, W.me.y, direct);
  debug('[DBG] Direct A* path:', Array.isArray(direct) ? direct.length + ' steps' : 'null', 'hitsBox=', directHitsBox);

  if (direct !== null && !directHitsBox) return direct;

  // Skip PDDL if there are no boxes to move (PDDL only useful when boxes block paths)
  if (!W.boxPos || W.boxPos.size === 0) {
    debug('[DBG] No boxes in world, skipping PDDL and using fallback approach');
    const approach = bestKnownApproachTile(target.x, target.y);
    if (approach && Array.isArray(approach.path) && approach.path.length > 0) {
      return approach.path;
    }
    return null;
  }

  if (directHitsBox) {
    debug('[DBG] A* path crosses a known box, forcing PDDL fallback');
  } else {
    debug('[DBG] A* failed to find path to target. Checking PDDL fallback...');
  }

  const pddlPlan = await generatePddlPlanWithBoxHandling(W.me, target);
  if (Array.isArray(pddlPlan) && pddlPlan.length > 0) return pddlPlan;

  const approach = bestKnownApproachTile(target.x, target.y);
  if (approach && Array.isArray(approach.path) && approach.path.length > 0) {
    return approach.path;
  }

  return null;
}

// Count boxes (from W.boxPos set of keys) within Manhattan radius of target
export function countBoxesNear(target, radius = 6) {
  if (!target) return 0;
  if (!W.boxPos || W.boxPos.size === 0) return 0;

  let cnt = 0;
  for (const k of W.boxPos) {
    const [sx, sy] = k.split(',').map(Number);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    const d = manhattan(sx, sy, target.x, target.y);
    if (d <= radius) cnt++;
  }
  return cnt;
}

function pathHitsBox(startX, startY, path) {
  let x = R(startX);
  let y = R(startY);

  for (const dir of path) {
    const delta = DIRS.find(d => d.dir === dir);
    if (!delta) return false;
    

    const nx = x + delta.dx;
    const ny = y + delta.dy;
    const nk = key(nx, ny);


    if (W.boxPos?.has(nk)) {
      debug('[DBG] A* step would cross box at', nk, 'dir=', dir);
      return true;
    }

    x = nx;
    y = ny;
  }

  return false;
}

// PDDL plan generation: build a small local problem and call the online solver.
// The function constructs a limited-area graph of nodes named `n_x_y`, declares
// adjacency and `free`/`at` facts, then asks the online solver for a plan.
// Only `move` actions are supported by the executor here — plans containing other
// actions (e.g. push) are rejected because the runtime cannot push boxes.
export async function generatePddlPlanWithBoxHandling(agent, target) {
  try {
    if (!agent || !target) return null;

    const ax = R(agent.x);
    const ay = R(agent.y);
    const tx = R(target.x);
    const ty = R(target.y);

    const nodes = new Map();

    // build the full known, walkable map instead of just a local neighborhood
    for (const tile of W.tiles.values()) {
      if (!tile || !tile.walkable) continue;
      const nx = R(tile.x);
      const ny = R(tile.y);
      const nk = key(nx, ny);
      if (!inKnownBounds(nx, ny)) continue;
      nodes.set(nk, { x: nx, y: ny });
    }

    // ensure target node is present
    const tKey = key(tx, ty);
    if (!nodes.has(tKey) && W.tiles.has(tKey)) {
      const tt = W.tiles.get(tKey);
      if (tt && tt.walkable) nodes.set(tKey, { x: tx, y: ty });
    }

    if (!nodes.size) return null;

    const nodeName = (x, y) => `n_${x}_${y}`;

    const belief = new Beliefset();

    // declare adjacency and free/box/at facts
    for (const [k, v] of nodes.entries()) {
      const { x, y } = v;
      const name = nodeName(x, y);

      // mark free unless there's a box or an agent currently there
      if (!W.boxPos?.has(k) && !W.agentPos?.has(k)) {
        belief.declare(`free ${name}`);
      }

      // mark cells that can host/move boxes (type "5" or "5!")
      const tile = W.tiles.get(k);
      if (tile && (String(tile.type) === "5" || String(tile.type) === "5!")) {
        belief.declare(`isBoxCell ${name}`);
      }

      // adjacency
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        const nk = key(nx, ny);
        if (!nodes.has(nk)) continue;
        belief.declare(`adj ${name} ${nodeName(nx, ny)}`);

        // Only allow pushing the box straight ahead: agent -> box -> next cell
        // must all lie on the same direction vector.
        const bx = nx + d.dx;
        const by = ny + d.dy;
        const bk = key(bx, by);
        if (nodes.has(bk)) {
          belief.declare(`pushline ${name} ${nodeName(nx, ny)} ${nodeName(bx, by)}`);
        }
      }
    }

    // agent position
    const aKey = key(ax, ay);
    if (!nodes.has(aKey)) {
      // if agent is outside the bounded nodes, abort
      return null;
    }
    belief.declare(`at ${nodeName(ax, ay)}`);

    // optionally declare boxes as boxAt (not used by move but included)
    let bi = 0;
    for (const bkey of W.boxPos ?? []) {
      const [bx, by] = bkey.split(",").map(Number);
      const bk = key(bx, by);
      if (!nodes.has(bk)) continue;
      belief.declare(`boxAt b${bi} ${nodeName(bx, by)}`);
      bi++;
    }

    // create domain: regular `move` plus `movebox` for entering a box cell
    // while the box advances into the next box-capable free cell.
    const move = new PddlAction(
      'move',
      '?from ?to',
      'and (at ?from) (adj ?from ?to) (free ?to)',
      'and (at ?to) (not (at ?from)) (not (free ?to)) (free ?from)',
      async () => {}
    );

    const moveBox = new PddlAction(
      'movebox',
      '?agentFrom ?boxFrom ?boxTo ?box',
      'and (at ?agentFrom) (boxAt ?box ?boxFrom) (pushline ?agentFrom ?boxFrom ?boxTo) (isBoxCell ?boxFrom) (isBoxCell ?boxTo) (free ?boxTo)',
      'and (at ?boxFrom) (not (at ?agentFrom)) (boxAt ?box ?boxTo) (not (boxAt ?box ?boxFrom)) (free ?agentFrom) (not (free ?boxFrom)) (not (free ?boxTo))',
      async () => {}
    );

    const domain = new PddlDomain('nav', move, moveBox);

    const objectsStr = belief.objects.join(' ');
    const initStr = belief.toPddlString();
    const goalStr = `at ${nodeName(tx, ty)}`;

    const problem = new PddlProblem('nav', objectsStr, initStr, goalStr);

    // Ensure only one solver request is active at a time.
    if (pddlRequestInFlight) {
      debug('[PDDL] Request already in flight, skipping new request');
      return null;
    }

    pddlRequestInFlight = true;
    let plan = null;
    try {
      // call remote solver with strings (do not save files)
      plan = await onlineSolver(domain.toPddlString(), problem.toPddlString());
    } finally {
      pddlRequestInFlight = false;
      usingPddlPath = true;
    }

    if (!plan || !Array.isArray(plan) || plan.length === 0) return null;

    debug('[PDDL] raw plan:', plan.map(s => ({ action: s.action, args: s.args })));

    const stepsOut = [];
    for (const step of plan) {
      if (!step || (step.action !== 'move' && step.action !== 'movebox')) {
        // we only support move/movebox plans here
        return null;
      }

      const args = step.args || [];
      if (step.action === 'move' && args.length < 2) return null;
      if (step.action === 'movebox' && args.length < 4) return null;

      const parseNode = (n) => {
        const parts = String(n).split('_');
        if (parts.length !== 3) return null;
        const xi = Number(parts[1]);
        const yi = Number(parts[2]);
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) return null;
        return { x: xi, y: yi };
      };

      const from = step.action === 'move' ? parseNode(args[0]) : parseNode(args[0]);
      const to = step.action === 'move' ? parseNode(args[1]) : parseNode(args[1]);
      const boxFrom = step.action === 'movebox' ? parseNode(args[1]) : null;
      const boxTo = step.action === 'movebox' ? parseNode(args[2]) : null;
      if (!from || !to) return null;

      const dx = to.x - from.x;
      const dy = to.y - from.y;

      const dir = DIRS.find(d => d.dx === dx && d.dy === dy)?.dir ?? null;
      if (!dir) return null;

      debug('[PDDL] step parsed:', step.action, 'dir=', dir, 'from=', from, 'to=', to);

      if (step.action === 'move') {
        stepsOut.push({ type: 'move', dir });
      } else {
        if (!boxFrom || !boxTo) return null;
        stepsOut.push({
          type: 'movebox',
          dir,
          agentFrom: from,
          boxFrom,
          boxTo,
          boxId: args[3] ?? null
        });
      }
    }

    return stepsOut;
  } catch (err) {
    console.error('PDDL planning error:', err);
    return null;
  }
}

// Target failure tracking to avoid getting stuck on impossible goals REMOVE IF IT DOESNT WORK
//making it really really simple
function nextSpawnPatrolTarget() {
  const spawns = W.spawnTiles;
  const n = spawns.length;
  if (n === 0) return null;

  // If current target exists, is valid, and not blacklisted, return it without changing index
  if (currentSpawnPatrolTarget && !isGoalBlacklisted(currentSpawnPatrolTarget)) {
    return currentSpawnPatrolTarget;
  }

  // Otherwise advance to next spawn
  if (spawnPatrolIndex < 0 || spawnPatrolIndex >= n) {
    spawnPatrolIndex = 0;
  }

  const s = spawns[spawnPatrolIndex];
  currentSpawnPatrolTarget = { x: s.x, y: s.y };
  spawnPatrolIndex = (spawnPatrolIndex + 1) % n;
  
  return currentSpawnPatrolTarget;

}

export function completeSpawnPatrol() {
  currentSpawnPatrolTarget = null;
}

//Decide what to do next: pick up, deliver, explore, or patrol

export function deliberate() {

  const carried = carriedParcels();
  const total = carried.reduce((s, p) => s + p.reward, 0);
  const dz = nearestDelivery();

  if (!carried.length) {
    forcedDeliveryTarget = null;
  }

  // Priority rule: if a free parcel is adjacent, go pick it up even when
  // delivery threshold logic would normally force delivery.
  const adjacentParcel = bestAdjacentParcel();
  if (adjacentParcel) {
    forcedDeliveryTarget = null;
    //console.log('[DBG] Adjacent parcel priority:', adjacentParcel.id, 'reward:', adjacentParcel.reward);
    return { type: "PICKUP", target: adjacentParcel };
  }

  // Sticky deliver mode: once threshold is reached, keep delivering
  // until all carried parcels are dropped.
  if (carried.length && forcedDeliveryTarget) {
    const lockedValid =
      validGoal(forcedDeliveryTarget) && !isGoalBlacklisted(forcedDeliveryTarget);

    if (lockedValid) {
      return { type: "DELIVER", target: forcedDeliveryTarget };
    }else{
      forcedDeliveryTarget = null; //reset if target becomes invalid for some reason (e.g. blacklisted)
    }

  }

  // Only consider DELIVER when actually carrying something
  if (carried.length && dz && !isGoalBlacklisted(dz)) {
    const d = manhattan(W.me.x, W.me.y, dz.x, dz.y);

    // If we are basically on the delivery tile or if we have many parcels, deliver

    if (d <= 1 || total >= 80 || carried.length == W.parcelList.length) {
      forcedDeliveryTarget = { x: dz.x, y: dz.y };
      return { type: "DELIVER", target: dz };
    }

    // Otherwise, make sure there is a path before committing
    const path =  aStar(dz.x, dz.y, W.me.x, W.me.y);
    if (path && path.length > 0 &&
      total >= CFG.DELIVER_REWARD_THRESHOLD &&
      d <= CFG.DELIVER_DIST_THRESHOLD) {
      return { type: "DELIVER", target: dz };
    }
  }

  const p = bestParcel();
  if (p && p != 0){
    //console.log('[DBG] bestParcel selected:', p.id, 'reward:', p.reward);
    return { type: "PICKUP", target: p };
  } 

  if (W.spawnTiles.length > 0) {
    //console.log('[DBG NOW] No parcels or frontier. Patrolling spawn area...');
    const patrol = nextSpawnPatrolTarget();
    if (patrol) {
      return { type: "PATROL", target: patrol };
    }
  }

  return { type: "EXPLORE", target: null };
}