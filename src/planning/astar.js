import { key, manhattan, R } from "../utils/math.js";
import { DIRS, DELTA } from "../utils/directions.js";
import {
  validGoal,
  canStep,
  canPushCrate,
  isCrateTrackTile
} from "../world/helpers.js";
import { W } from "../world/state.js";
import { CFG } from "../config.js";

class MinHeap {
  constructor() {
    this.data = [];
  }

  push(node) {
    this.data.push(node);
    let i = this.data.length - 1;

    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._leq(this.data[p], this.data[i])) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }

  pop() {
    if (this.data.length === 0) return null;

    const top = this.data[0];
    const last = this.data.pop();

    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;

      while (true) {
        let s = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;

        if (l < this.data.length && !this._leq(this.data[s], this.data[l])) s = l;
        if (r < this.data.length && !this._leq(this.data[s], this.data[r])) s = r;
        if (s === i) break;

        [this.data[i], this.data[s]] = [this.data[s], this.data[i]];
        i = s;
      }
    }

    return top;
  }

  isEmpty() {
    return this.data.length === 0;
  }

  _leq(a, b) {
    if (a.f !== b.f) return a.f <= b.f;
    if ((a.pushes ?? 0) !== (b.pushes ?? 0)) {
      return (a.pushes ?? 0) <= (b.pushes ?? 0);
    }
    return (a.g ?? 0) <= (b.g ?? 0);
  }
}

function hasAnyCrates() {
  return !!W.boxPos && W.boxPos.size > 0;
}

function serializeBoxSet(boxSet) {
  return [...boxSet].sort().join("|");
}

function dynamicStateKey(x, y, boxSet) {
  return `${key(x, y)}#${serializeBoxSet(boxSet)}`;
}

function reconstructPath(cameFrom, endKey) {
  const path = [];
  let curr = endKey;

  while (cameFrom.has(curr)) {
    const step = cameFrom.get(curr);
    path.unshift(step.dir);
    curr = step.prev;
  }

  return path;
}

function buildPushedBoxSet(boxSet, crateX, crateY, dir) {
  const delta = DELTA[dir];
  if (!delta) return null;

  const [dx, dy] = delta;
  const firstK = key(crateX, crateY);

  if (!boxSet.has(firstK)) return null;

  let checkX = crateX + dx;
  let checkY = crateY + dy;
  let checkK = key(checkX, checkY);

  while (boxSet.has(checkK)) {
    const chainedTile = W.tiles.get(checkK);
    if (!isCrateTrackTile(chainedTile)) return null;

    checkX += dx;
    checkY += dy;
    checkK = key(checkX, checkY);
  }

  const finalDestTile = W.tiles.get(checkK);
  if (!isCrateTrackTile(finalDestTile)) return null;
  if (W.agentPos.has(checkK)) return null;
  if (W.tempBlocked.has(checkK)) return null;

  const nextBoxSet = new Set(boxSet);

  const chain = [];
  let cx = crateX;
  let cy = crateY;
  let ck = key(cx, cy);

  while (boxSet.has(ck)) {
    chain.push({ x: cx, y: cy, k: ck });
    cx += dx;
    cy += dy;
    ck = key(cx, cy);
  }

  for (let i = chain.length - 1; i >= 0; i--) {
    const oldK = chain[i].k;
    const newK = key(chain[i].x + dx, chain[i].y + dy);
    nextBoxSet.delete(oldK);
    nextBoxSet.add(newK);
  }

  return nextBoxSet;
}

function coreAStar(sx, sy, gx, gy, boxSet = W.boxPos, pathPolicy = null) {
  const rsx = R(sx);
  const rsy = R(sy);
  const rgx = R(gx);
  const rgy = R(gy);

  const startK = key(rsx, rsy);
  const goalK = key(rgx, rgy);

  if (startK === goalK) return [];
  if (!validGoal({ x: rgx, y: rgy })) return null;

  const blockedSet = pathPolicy?.blockedSet ?? null;
  const penaltyMap = pathPolicy?.penaltyMap ?? null;

  const open = new MinHeap();
  const cameFrom = new Map();
  const gScore = new Map();
  const closed = new Set();

  const h0 = manhattan(rsx, rsy, rgx, rgy);

  open.push({
    k: startK,
    x: rsx,
    y: rsy,
    g: 0,
    f: h0,
    pushes: 0
  });
  gScore.set(startK, 0);

  let expansions = 0;
  const maxExpansions = CFG.ASTAR_MAX_EXPANSIONS ?? 4000;

  while (!open.isEmpty() && expansions++ < maxExpansions) {
    const curr = open.pop();
    if (!curr || closed.has(curr.k)) continue;

    const bestKnownG = gScore.get(curr.k);
    if (bestKnownG !== undefined && curr.g > bestKnownG) continue;

    closed.add(curr.k);

    if (curr.k === goalK) {
      return reconstructPath(cameFrom, curr.k);
    }

    for (const d of DIRS) {
      const nx = curr.x + d.dx;
      const ny = curr.y + d.dy;
      const nk = key(nx, ny);

      // HARD AVOID
      if (blockedSet?.has(nk) && nk !== goalK) continue;
      if (!canStep(curr.x, curr.y, d.dir, nx, ny, goalK, boxSet)) continue;

      // SOFT AVOID PENALTY
      let moveCost = 1;
      if (penaltyMap?.has(nk)) {
        moveCost += penaltyMap.get(nk);
      }

      const ng = curr.g + moveCost;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        cameFrom.set(nk, { prev: curr.k, dir: d.dir });

        open.push({
          k: nk,
          x: nx,
          y: ny,
          g: ng,
          f: ng + manhattan(nx, ny, rgx, rgy),
          pushes: 0
        });
      }
    }
  }

  return null;
}

function crateAwareAStar(sx, sy, gx, gy, initialBoxSet = W.boxPos, pathPolicy = null) {
  const rsx = R(sx);
  const rsy = R(sy);
  const rgx = R(gx);
  const rgy = R(gy);

  const startPosK = key(rsx, rsy);
  const goalK = key(rgx, rgy);

  if (startPosK === goalK) return [];
  if (!validGoal({ x: rgx, y: rgy })) return null;

  const blockedSet = pathPolicy?.blockedSet ?? null;
  const penaltyMap = pathPolicy?.penaltyMap ?? null;

  const startBoxSet = new Set(initialBoxSet);
  const startStateK = dynamicStateKey(rsx, rsy, startBoxSet);

  const open = new MinHeap();
  const cameFrom = new Map();
  const gScore = new Map();
  const closed = new Set();

  const h0 = manhattan(rsx, rsy, rgx, rgy);

  open.push({
    stateK: startStateK,
    x: rsx,
    y: rsy,
    boxSet: startBoxSet,
    g: 0,
    pushes: 0,
    f: h0
  });
  gScore.set(startStateK, 0);

  let expansions = 0;
  const maxExpansions =
    CFG.CRATE_ASTAR_MAX_EXPANSIONS ??
    Math.max((CFG.ASTAR_MAX_EXPANSIONS ?? 4000) * 3, 12000);

  const maxPushes = CFG.CRATE_ASTAR_MAX_PUSHES ?? 8;
  const pushPenalty = CFG.CRATE_PUSH_PENALTY ?? 0;

  while (!open.isEmpty() && expansions++ < maxExpansions) {
    const curr = open.pop();
    if (!curr || closed.has(curr.stateK)) continue;

    const bestKnownG = gScore.get(curr.stateK);
    if (bestKnownG !== undefined && curr.g > bestKnownG) continue;

    closed.add(curr.stateK);

    if (curr.x === rgx && curr.y === rgy) {
      return reconstructPath(cameFrom, curr.stateK);
    }

    for (const d of DIRS) {
      const nx = curr.x + d.dx;
      const ny = curr.y + d.dy;
      const nk = key(nx, ny);

      // HARD AVOID
      if (blockedSet?.has(nk) && nk !== goalK) continue;

      // SOFT AVOID PENALTY
      let moveCost = 1;
      if (penaltyMap?.has(nk)) {
        moveCost += penaltyMap.get(nk);
      }

      if (canStep(curr.x, curr.y, d.dir, nx, ny, goalK, curr.boxSet)) {
        const nextStateK = dynamicStateKey(nx, ny, curr.boxSet);
        const ng = curr.g + moveCost;

        if (ng < (gScore.get(nextStateK) ?? Infinity)) {
          gScore.set(nextStateK, ng);
          cameFrom.set(nextStateK, { prev: curr.stateK, dir: d.dir });

          open.push({
            stateK: nextStateK,
            x: nx,
            y: ny,
            boxSet: curr.boxSet,
            g: ng,
            pushes: curr.pushes,
            f: ng + manhattan(nx, ny, rgx, rgy)
          });
        }

        continue;
      }

      if (curr.pushes >= maxPushes) continue;
      if (!canPushCrate(curr.x, curr.y, d.dir, nx, ny, goalK, curr.boxSet)) continue;

      const nextBoxSet = buildPushedBoxSet(curr.boxSet, nx, ny, d.dir);
      if (!nextBoxSet) continue;

      const nextStateK = dynamicStateKey(nx, ny, nextBoxSet);
      const nextPushes = curr.pushes + 1;
      
      // Add push penalty + soft avoid penalty
      const ng = curr.g + moveCost + pushPenalty;

      if (ng < (gScore.get(nextStateK) ?? Infinity)) {
        gScore.set(nextStateK, ng);
        cameFrom.set(nextStateK, { prev: curr.stateK, dir: d.dir });

        open.push({
          stateK: nextStateK,
          x: nx,
          y: ny,
          boxSet: nextBoxSet,
          g: ng,
          pushes: nextPushes,
          f: ng + manhattan(nx, ny, rgx, rgy)
        });
      }
    }
  }

  return null;
}

export function aStar(sx, sy, gx, gy, pathPolicy = null) {
  const rsx = R(sx);
  const rsy = R(sy);
  const rgx = R(gx);
  const rgy = R(gy);

  // 1. Try normal A* first. We use W.boxPos because we don't push crates yet.
  const normalPath = coreAStar(rsx, rsy, rgx, rgy, W.boxPos, pathPolicy);
  if (normalPath !== null) return normalPath;

  // 2. If normal A* failed, and there are crates on the map, try crate-aware A*
  if (!hasAnyCrates()) return null;

  // crateAwareAStar takes W.boxPos and simulates pushing them internally
  return crateAwareAStar(rsx, rsy, rgx, rgy, new Set(W.boxPos), pathPolicy);
}

export { coreAStar, crateAwareAStar };