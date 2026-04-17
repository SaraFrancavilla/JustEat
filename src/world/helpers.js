import { W } from "./state.js";
import { key, R, targetToken } from "../utils/math.js";
import { inKnownBounds } from "./tiles.js";
import { CFG } from "../config.js";

export function isSpawnTile(tile) {
  if (!tile) return false;
  const t = String(tile.type ?? "").trim();
  return t === "1";
}

export function carriedParcels() {
  return W.parcelList.filter(
    p => p.carriedBy === W.me?.id || W.carrying.has(p.id)
  );
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
    p => !p.carriedBy && key(p.x, p.y) === here
  );
}

// Simple "exists and not blocked" check; does NOT enforce one-way
export function isWalkable(x, y, goalKey = null) {
  const k = key(x, y);

  if (!inKnownBounds(x, y)) return false;
  const tile = W.tiles.get(k);
  if (!tile) return false;
  if (!tile.walkable) return false;

  if (k !== goalKey && W.boxPos.has(k)) return false;
  if (k !== goalKey && W.agentPos.has(k)) return false;
  if (W.tempBlocked.has(k)) return false;

  return true;
}

function allowsExit(tile, dir) {
  if (!tile) return true;

  // One-way semantics from tiles.js/classifyTileType
  if (tile.oneWay) {
    return tile.oneWay === dir;
  }

  return true;
}

export function canStep(fromX, fromY, dir, toX, toY, goalKey = null) {
  const fromK = key(fromX, fromY);
  const toK = key(toX, toY);

  if (!inKnownBounds(toX, toY)) return false;

  const toTile = W.tiles.get(toK);
  if (!toTile) return false;
  if (!toTile.walkable) return false;

  if (toK !== goalKey && W.boxPos.has(toK)) return false;
  if (toK !== goalKey && W.agentPos.has(toK)) return false;
  if (W.tempBlocked.has(toK)) return false;

  const fromTile = W.tiles.get(fromK);
  if (fromTile && !allowsExit(fromTile, dir)) return false;

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