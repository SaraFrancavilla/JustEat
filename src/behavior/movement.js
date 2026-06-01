import { api } from "../client.js";
import { DELTA, DIRS, inverseDir } from "../utils/directions.js";
import { R, key, manhattan } from "../utils/math.js";
import { inKnownBounds, seedLocalMap, setTile } from "../world/tiles.js";
import { carriedParcels, canStep, canPushCrate } from "../world/helpers.js";
import { W, rememberRecentPos } from "../world/state.js";
import { debug, info, CFG } from "../config.js";

export async function tryMoveDir(dir) {
  const [dx, dy] = DELTA[dir];
  const fromX = R(W.me.x);
  const fromY = R(W.me.y);
  const nx = fromX + dx;
  const ny = fromY + dy;
  const nk = key(nx, ny);

  if (!inKnownBounds(nx, ny)) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  // Allow step if it's a valid push, otherwise rely on standard canStep
  const isPush = canPushCrate(fromX, fromY, dir, nx, ny);
  if (!isPush && !canStep(fromX, fromY, dir, nx, ny)) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  const ok = await api.move(dir);
  if (!ok) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  W.me.x = nx;
  W.me.y = ny;
  W.lastMove = dir;
  rememberRecentPos(nx, ny);

  if (!W.tiles.has(nk)) {
    setTile(nx, ny, "3", false);
  }
  seedLocalMap();

  return true;
}

export function rankedDirsToward(target = null) {
  const recent = W.recentPos ?? [];

  const out = DIRS.map(d => {
    const fromX = R(W.me.x);
    const fromY = R(W.me.y);
    const nx = fromX + d.dx;
    const ny = fromY + d.dy;
    const nk = key(nx, ny);

    let score = 0;
    const isPush = canPushCrate(fromX, fromY, d.dir, nx, ny);

    if (!isPush && !canStep(fromX, fromY, d.dir, nx, ny)) score += 1000;
    if (target) score += 5 * manhattan(nx, ny, target.x, target.y);

    if (W.tempBlocked.has(nk)) score += 30;
    if (W.agentPos.has(nk)) score += 8;

    // Penalize crates differently depending on pushability
    if (W.boxPos.has(nk)) {
      if (isPush) score += 4; // slight penalty so empty tiles are preferred
      else score += 1000;
    }

    if (W.badNeighbors?.get(nk)) score += W.badNeighbors.get(nk);

    const recentIdx = recent.lastIndexOf(nk);
    if (recentIdx !== -1) {
      const age = recent.length - 1 - recentIdx;
      score += Math.max(0, 12 - 2 * age);
    }

    if (W.lastMove && inverseDir(W.lastMove) === d.dir) {
      score += 15; 
    } else if (W.lastMove && W.lastMove === d.dir) {
      score -= 2;
    }

    const tile = W.tiles.get(nk);
    if (!tile) score += 10;
    else if (tile.guessed) score -= 0.2;

    return { dir: d.dir, nx, ny, nk, score };
  });

  out.sort((a, b) => a.score - b.score);
  return out;
}

export async function fallbackMove(target = null) {
  const candidates = rankedDirsToward(target);

  for (const c of candidates) {
    const isPush = canPushCrate(R(W.me.x), R(W.me.y), c.dir, c.nx, c.ny);
    
    if (!isPush && !canStep(R(W.me.x), R(W.me.y), c.dir, c.nx, c.ny)) continue;
    if (W.tempBlocked.has(c.nk)) continue;

    const ok = await tryMoveDir(c.dir);
    if (ok) return true;

    const cur = W.badNeighbors?.get(c.nk) ?? 0;
    if (!W.badNeighbors) W.badNeighbors = new Map();
    W.badNeighbors.set(c.nk, cur + 10);
  }

  return false;
}