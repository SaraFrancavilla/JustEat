import { W } from "../world/state.js";
import { manhattan, key, R } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";
import { aStar } from "./astar.js";
import { carriedParcels, isGoalBlacklisted, validGoal } from "../world/helpers.js";
import { inKnownBounds } from "../world/tiles.js";
import { CFG } from "../config.js";

//per permettere una consegna obbligata
let forcedDeliveryTarget = null;
//REMOVE IF IT DOESNT WORK: to avoid getting stuck on impossible delivery targets, we track failures and blacklist after a threshold
let spawnPatrolIndex = -1;

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

  console.log('[DBG] bestParcel scanning:', W.parcelList.length, 'parcels');
  
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
    console.log('[DBG] Parcel', p.id, 'at', p.x, p.y, 'reward:', p.reward, 'utility:', u.toFixed(2));
    
    if (u > bestU) {
      bestU = u;
      best = p;
    }
  }
  
  if (best) {
    console.log('[DBG] BEST parcel:', best.id, 'at', best.x, best.y, 'utility:', bestU.toFixed(2));
  } else {
    console.log('[DBG] NO BEST PARCEL FOUND');
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

  return best;e
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

export function bestFrontierTarget() {

  console.log('[DBG] frontierTiles count:', frontierTiles().length);

  let best = null;
  let bestScore = Infinity;

  for (const t of frontierTiles()) {
    if (isGoalBlacklisted(t)) continue;

    const path = aStar(W.me.x, W.me.y, t.x, t.y);
    if (path === null) continue;

    const score = path.length;

    if (score < bestScore) {
      bestScore = score;
      best = { x: t.x, y: t.y, path };
    }
  }

  return best;
}

export function planPathToTarget(target) {

  if (!target) return [];
  if (isGoalBlacklisted(target)) return null;
  if (!validGoal(target)) return null;

  const direct = aStar(W.me.x, W.me.y, target.x, target.y);
  if (direct !== null) return direct;

  const approach = bestKnownApproachTile(target.x, target.y);
  if (approach && Array.isArray(approach.path) && approach.path.length > 0) {
    return approach.path;
  }

  return null;
}

// Target failure tracking to avoid getting stuck on impossible goals REMOVE IF IT DOESNT WORK
//making it really really simple
function nextSpawnPatrolTarget() {
  const spawns = W.spawnTiles;
  const n = spawns.length;
  if (n === 0) return null;

  if (spawnPatrolIndex < 0 || spawnPatrolIndex >= n) {
    spawnPatrolIndex = 0;
  }

  const s = spawns[spawnPatrolIndex];
  spawnPatrolIndex = (spawnPatrolIndex + 1) % n;
  return { x: s.x, y: s.y };

}

/**
 * Decide what to do next: DELIVER, PICKUP, or EXPLORE (frontier or spawner band).
 */



export function deliberate() {

  console.log("Deliberating...");
  console.log('[DBG] W.tiles.size:', W.tiles.size, 'known bounds:', 
    W.minX !== Infinity ? `${W.minX}-${W.maxX}, ${W.minY}-${W.maxY}` : 'NOT SET');
  console.log('[DBG] Available: spawners=', W.spawnTiles.length, 
    'deliveries=', W.deliveryTiles.length,
    'parcels=', W.parcelList.length);

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
    console.log('[DBG] Adjacent parcel priority:', adjacentParcel.id, 'reward:', adjacentParcel.reward);
    return { type: "PICKUP", target: adjacentParcel };
  }

  // Sticky deliver mode: once threshold is reached, keep delivering
  // until all carried parcels are dropped.
  if (carried.length && forcedDeliveryTarget) {
    const lockedValid =
      validGoal(forcedDeliveryTarget) && !isGoalBlacklisted(forcedDeliveryTarget);

    if (lockedValid) {
      return { type: "DELIVER", target: forcedDeliveryTarget };
    }

    if (dz && !isGoalBlacklisted(dz)) {
      forcedDeliveryTarget = { x: dz.x, y: dz.y };
      return { type: "DELIVER", target: forcedDeliveryTarget };
    }

    forcedDeliveryTarget = null;
  }

  // Only consider DELIVER when actually carrying something
  if (carried.length && dz && !isGoalBlacklisted(dz)) {
    const d = manhattan(W.me.x, W.me.y, dz.x, dz.y);

    // If we are basically on the delivery tile or if we have many parcels, deliver
    //MIGLIORA PARAMETRI
    if (d <= 1 || total >= 80 ) {
      return { type: "DELIVER", target: dz };
    }

    // Otherwise, make sure there is a path before committing
    const path = planPathToTarget(dz);
    if (path && path.length > 0 &&
      total >= CFG.DELIVER_REWARD_THRESHOLD &&
      d <= CFG.DELIVER_DIST_THRESHOLD) {
      return { type: "DELIVER", target: dz };
    }
  }

  const p = bestParcel();
  if (p && p != 0){
    console.log('[DBG] bestParcel selected:', p.id, 'reward:', p.reward);
    return { type: "PICKUP", target: p };
  } 

  //computing frontier can be expensive, so we track if we found any in the last deliberation 
  // and skip if none found before
  if (existFrontier) {
    console.log('[DBG] Checking for frontier targets...');
    const frontier = bestFrontierTarget();
    if (frontier) {
      console.log('[DBG] bestFrontierTarget selected:', frontier.x, frontier.y);
      return { type: "EXPLORE", target: { x: frontier.x, y: frontier.y } };
    } else existFrontier = false; //avoid computing frontier again if none found
  }

  // No parcels and no frontier: go to spawner area
  if (W.spawnTiles.length > 0) {
    console.log('[DBG NOW] No parcels or frontier. Patrolling spawn area...');
    const patrol = nextSpawnPatrolTarget();
    if (patrol) {
      console.log('[DBG] Spawn patrol target:', patrol.x, patrol.y, 'idx=', spawnPatrolIndex);
      return { type: "EXPLORE", target: patrol };
    }
  }

  console.log('[DBG] No valid target found.');
  return { type: "EXPLORE", target: null };
}