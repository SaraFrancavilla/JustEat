import { W } from "./state.js";
import { key, R, targetToken } from "../utils/math.js";
import { inKnownBounds } from "./tiles.js";
import { CFG } from "../config.js";
import { DELTA } from "../utils/directions.js";

export function isSpawnTile(tile) {
  if (!tile) return false;
  const t = String(tile.type ?? "").trim();
  return t === "1";
}

export function carryingCount() {
  return W.carrying?.size ?? 0;
}

export function carriedParcels() {
  if (!W.carrying || W.carrying.size === 0) return [];

  const out = [];
  for (const rawId of W.carrying) {
    const id = String(rawId);
    const known = W.parcels.get(id);

    if (known) {
      out.push(known);
      continue;
    }

    out.push({
      id,
      x: Number(W.me?.x ?? 0),
      y: Number(W.me?.y ?? 0),
      reward: 0,
      carriedBy: W.me?.id ?? null,
    });
  }

  return out;
}

export function onDeliveryTile() {
  const rx = R(W.me.x);
  const ry = R(W.me.y);
  const k = key(rx, ry);
  const tile = W.tiles.get(k);
  return !!tile?.delivery;
}

export function parcelsHere() {
  const here = key(W.me.x, W.me.y);
  return W.parcelList.filter(
    (p) => !p.carriedBy && key(p.x, p.y) === here
  );
}

export function rebuildBoxPositionsFromTiles() {
  W.boxPos.clear();
  for (const t of W.tiles.values()) {
    if (t?.hasCrate) W.boxPos.add(key(t.x, t.y));
  }
}

export function isWalkable(x, y, goalKey = null, boxSet = W.boxPos) {
  const k = key(x, y);

  if (!inKnownBounds(x, y)) return false;

  const tile = W.tiles.get(k);
  if (!tile) return false;
  if (!tile.walkable) return false;

  if (k !== goalKey && boxSet.has(k)) return false;
  if (k !== goalKey && W.agentPos.has(k)) return false;
  if (W.tempBlocked.has(k)) return false;

  return true;
}

function allowsEntry(fromTile, toTile, dir) {
  if (!toTile) return false;
  if (!toTile.oneWay) return true;

  if (dir === toTile.oneWay) return false;

  const opposite = {
    up: "down",
    down: "up",
    left: "right",
    right: "left",
  }[toTile.oneWay];

  if (dir === opposite) return true;

  return !!fromTile?.oneWay && fromTile.oneWay === toTile.oneWay;
}

export function canStep(fromX, fromY, dir, toX, toY, goalKey = null, boxSet = W.boxPos) {
  const fromK = key(fromX, fromY);
  const toK = key(toX, toY);

  if (!inKnownBounds(toX, toY)) return false;

  const fromTile = W.tiles.get(fromK);
  const toTile = W.tiles.get(toK);

  if (!toTile) return false;
  if (!toTile.walkable) return false;

  if (!allowsEntry(fromTile, toTile, dir)) return false;

  if (toK !== goalKey && boxSet.has(toK)) return false;
  if (toK !== goalKey && W.agentPos.has(toK)) return false;
  if (W.tempBlocked.has(toK)) return false;

  return true;
}

export function isCrateTrackTile(tile) {
  return !!tile?.crateTrack;
}

export function canPushCrate(fromX, fromY, dir, toX, toY, goalKey = null, boxSet = W.boxPos) {
  const toK = key(toX, toY);

  if (toK !== goalKey && !boxSet.has(toK)) return false;

  const crateTile = W.tiles.get(toK);
  if (!isCrateTrackTile(crateTile)) return false;

  const delta = DELTA[dir];
  if (!delta) return false;
  const [dx, dy] = delta;

  let checkX = toX + dx;
  let checkY = toY + dy;
  let checkK = key(checkX, checkY);

  while (boxSet.has(checkK)) {
    const chainedTile = W.tiles.get(checkK);
    if (!isCrateTrackTile(chainedTile)) return false;

    checkX += dx;
    checkY += dy;
    checkK = key(checkX, checkY);
  }

  if (!inKnownBounds(checkX, checkY)) return false;

  const finalDestTile = W.tiles.get(checkK);
  if (!isCrateTrackTile(finalDestTile)) return false;

  if (boxSet.has(checkK)) return false;
  if (W.agentPos.has(checkK)) return false;
  if (W.tempBlocked.has(checkK)) return false;

  return true;
}

export function blacklistGoal(target, ms = CFG.NO_GOAL_MS) {
  const tok = targetToken(target);
  if (!tok) return;
  W.badGoals.set(tok, Date.now() + ms);
}

export function isGoalBlacklisted(target) {
  const tok = targetToken(target);
  if (!tok) return false;
  return (W.badGoals.get(tok) ?? 0) > Date.now();
}

export function validGoal(target) {
  if (!target) return false;
  if (!Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
  if (!inKnownBounds(target.x, target.y)) return false;

  const k = key(target.x, target.y);
  return W.tiles.has(k);
}