import { key, manhattan, R } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";
import { validGoal, canStep, canPushCrate, isCrateTrackTile } from "../world/helpers.js";
import { W } from "../world/state.js";
import { CFG } from "../config.js";

class MinHeap {
  constructor() {
    this.data = [];
  }

  push(n) {
    this.data.push(n);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p].f <= this.data[i].f) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }

  pop() {
    if (!this.data.length) return null;
    const top = this.data[0];
    const last = this.data.pop();

    if (this.data.length) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        let l = i * 2 + 1;
        let r = i * 2 + 2;
        let s = i;

        if (l < this.data.length && this.data[l].f < this.data[s].f) s = l;
        if (r < this.data.length && this.data[r].f < this.data[s].f) s = r;
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
}

function coreAStar(sx, sy, gx, gy, boxSet = W.boxPos, blockedSet = null) {
  const start = key(sx, sy);
  const goal = key(gx, gy);

  if (start === goal) return [];
  if (!validGoal({ x: gx, y: gy })) return null;

  const open = new MinHeap();
  const came = new Map();
  const gScore = new Map();
  const closed = new Set();

  open.push({
    k: start,
    x: R(sx),
    y: R(sy),
    f: manhattan(sx, sy, gx, gy)
  });
  gScore.set(start, 0);

  let expansions = 0;

  while (!open.isEmpty() && expansions++ < CFG.ASTAR_MAX_EXPANSIONS) {
    const n = open.pop();
    if (!n || closed.has(n.k)) continue;
    closed.add(n.k);

    if (n.k === goal) {
      const path = [];
      let curr = n.k;
      while (came.has(curr)) {
        const step = came.get(curr);
        path.unshift(step.dir);
        curr = step.prev;
      }
      return path;
    }

    for (const d of DIRS) {
      const nx = n.x + d.dx;
      const ny = n.y + d.dy;
      const nk = key(nx, ny);

      if (blockedSet?.has(nk) && nk !== goal) continue;
      if (!canStep(n.x, n.y, d.dir, nx, ny, goal, boxSet)) continue;

      const ng = (gScore.get(n.k) ?? Infinity) + 1;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, { prev: n.k, dir: d.dir });
        gScore.set(nk, ng);
        open.push({
          k: nk,
          x: nx,
          y: ny,
          f: ng + manhattan(nx, ny, gx, gy)
        });
      }
    }
  }

  return null;
}

function coreAStarIgnoringCrates(sx, sy, gx, gy) {
  return coreAStar(sx, sy, gx, gy, new Set());
}

export function aStar(sx, sy, gx, gy) {
  const normalPath = coreAStar(sx, sy, gx, gy, W.boxPos);
  if (normalPath) return normalPath;

  const originalBoxes = new Set(W.boxPos);
  const ghostPath = coreAStarIgnoringCrates(sx, sy, gx, gy);
  if (!ghostPath) return null;

  let currX = R(sx);
  let currY = R(sy);
  let hitCrateX = null;
  let hitCrateY = null;
  let hitCrateK = null;
  let desiredPushDir = null;

  for (const dir of ghostPath) {
    const d = DIRS.find(x => x.dir === dir);
    if (!d) return null;

    currX += d.dx;
    currY += d.dy;
    const k = key(currX, currY);

    if (originalBoxes.has(k)) {
      hitCrateX = currX;
      hitCrateY = currY;
      hitCrateK = k;
      desiredPushDir = d;
      break;
    }
  }

  if (!hitCrateK || !desiredPushDir) return null;

  const parkX = hitCrateX + desiredPushDir.dx;
  const parkY = hitCrateY + desiredPushDir.dy;
  const parkK = key(parkX, parkY);

  const pTile = W.tiles.get(parkK);
  if (!isCrateTrackTile(pTile)) return null;
  if (originalBoxes.has(parkK)) return null;
  if (W.agentPos.has(parkK)) return null;
  if (W.tempBlocked.has(parkK)) return null;

  if (!canPushCrate(
    hitCrateX - desiredPushDir.dx,
    hitCrateY - desiredPushDir.dy,
    desiredPushDir.dir,
    hitCrateX,
    hitCrateY,
    null,
    originalBoxes
  )) {
    return null;
  }

  const standX = hitCrateX - desiredPushDir.dx;
  const standY = hitCrateY - desiredPushDir.dy;
  const standK = key(standX, standY);

  const sTile = W.tiles.get(standK);
  if (!sTile || !sTile.walkable) return null;
  if (originalBoxes.has(standK)) return null;
  if (W.agentPos.has(standK)) return null;

  const blockedSet = new Set([hitCrateK]);
  const pathToStand = coreAStar(sx, sy, standX, standY, originalBoxes, blockedSet);

  if (pathToStand === null) return null;

  return [...pathToStand, desiredPushDir.dir];
}