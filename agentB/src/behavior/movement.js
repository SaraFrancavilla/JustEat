import { api } from "../client.js";
import { DELTA, DIRS, inverseDir } from "../utils/directions.js";
import { R, key, manhattan } from "../utils/math.js";
import { inKnownBounds, seedLocalMap, setTile } from "../world/tiles.js";
import { canStep, canPushCrate, isCrateTrackTile } from "../world/helpers.js";
import { W, rememberRecentPos } from "../world/state.js";
import { CFG } from "../config.js";
import { nextSpawnPatrolTarget } from "../planning/targeting.js";

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

function applyLocalPushPreview(fromX, fromY, dir, toX, toY) {
  const nextBoxSet = buildPushedBoxSet(W.boxPos, toX, toY, dir);
  if (!nextBoxSet) return false;

  W.boxPos.clear();
  for (const k of nextBoxSet) {
    W.boxPos.add(k);
  }

  const fromTile = W.tiles.get(key(fromX, fromY));
  const pushedFromTile = W.tiles.get(key(toX, toY));

  if (fromTile) {
    fromTile.hasCrate = false;
  }

  if (pushedFromTile) {
    pushedFromTile.hasCrate = false;
  }

  for (const t of W.tiles.values()) {
    if (t?.crateTrack) {
      t.hasCrate = W.boxPos.has(key(t.x, t.y));
    }
  }

  return true;
}

function canIssueAction() {
  return W.prevActionFinished !== false;
}

function markActionIssued() {
  W.prevActionFinished = false;

  clearTimeout(W._actionFailsafe);
  W._actionFailsafe = setTimeout(() => {
    if (W.prevActionFinished === false) {
      console.warn("[FAILSAFE] Action timeout! Forcing prevActionFinished = true to unfreeze.");
      W.prevActionFinished = true;
    }
  }, 1000);
}

function finishAction() {
  W.prevActionFinished = true;
  clearTimeout(W._actionFailsafe);
}

export async function tryMoveDir(dir) {
  const delta = DELTA[dir];
  if (!delta) return false;

  if (!canIssueAction()) {
    return false;
  }

  const [dx, dy] = delta;
  const fromX = R(W.me.x);
  const fromY = R(W.me.y);
  const nx = fromX + dx;
  const ny = fromY + dy;
  const nk = key(nx, ny);

  if (!inKnownBounds(nx, ny)) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  const isPush = canPushCrate(fromX, fromY, dir, nx, ny, null, W.boxPos);

  if (!isPush && !canStep(fromX, fromY, dir, nx, ny, null, W.boxPos)) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  markActionIssued();

  let ok = false;
  try {
    ok = await api.move(dir);
  } catch (err) {
    console.error("[MOVE] api.move failed:", err);
    ok = false;
  } finally {
    finishAction();
  }

  if (!ok) {
    W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
    return false;
  }

  if (isPush) {
    applyLocalPushPreview(fromX, fromY, dir, nx, ny);
  }

  W.me.x = nx;
  W.me.y = ny;
  W.lastMove = dir;
  rememberRecentPos(nx, ny);

  W.tempBlocked.delete(nk);

  if (!W.tiles.has(nk)) {
    setTile(nx, ny, "3", false);
  }

  seedLocalMap();
  return true;
}

export function rankedDirsToward(target = null) {
  const recent = W.recentPos ?? [];

  const out = DIRS.map((d) => {
    const fromX = R(W.me.x);
    const fromY = R(W.me.y);
    const nx = fromX + d.dx;
    const ny = fromY + d.dy;
    const nk = key(nx, ny);

    let score = 0;
    const isPush = canPushCrate(fromX, fromY, d.dir, nx, ny, null, W.boxPos);

    if (!isPush && !canStep(fromX, fromY, d.dir, nx, ny, null, W.boxPos)) {
      score += 1000;
    }

    if (target) {
      score += 5 * manhattan(nx, ny, target.x, target.y);
    }

    if (W.tempBlocked.has(nk)) score += 30;
    if (W.agentPos.has(nk)) score += 8;

    if (W.boxPos.has(nk)) {
      if (isPush) score += 4;
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

    return { dir: d.dir, nx, ny, nk, score, isPush };
  });

  out.sort((a, b) => a.score - b.score);
  return out;
}

export async function fallbackMove(target = null) {
  if (!canIssueAction()) return false;

  // use patrol as the fallback target to avoid aimless momentum drift
  const effectiveTarget = target ?? nextSpawnPatrolTarget();
  const candidates = rankedDirsToward(effectiveTarget);

  if (!W.badNeighbors) W.badNeighbors = new Map();

  for (const c of candidates) {
    const fromX = R(W.me.x);
    const fromY = R(W.me.y);

    const isPush = canPushCrate(fromX, fromY, c.dir, c.nx, c.ny, null, W.boxPos);

    if (!isPush && !canStep(fromX, fromY, c.dir, c.nx, c.ny, null, W.boxPos)) continue;
    if (W.tempBlocked.has(c.nk)) continue;
    if (!canIssueAction()) return false;

    const ok = await tryMoveDir(c.dir);
    if (ok) return true;

    const cur = W.badNeighbors.get(c.nk) ?? 0;
    W.badNeighbors.set(c.nk, cur + (isPush ? 4 : 10));
  }

  return false;
}
