import { W, visitedSpawns } from "../world/state.js";
import { manhattan, key } from "../utils/math.js";
import { DIRS, samePos } from "../utils/directions.js";
import { isCrateMap } from "../world/mapAnalysis.js";
import { aStar } from "./astar.js";
import {
  carriedParcels,
  carryingCount,
  isGoalBlacklisted,
  validGoal,
} from "../world/helpers.js";
import { inKnownBounds } from "../world/tiles.js";
import { CFG } from "../config.js";

let forcedDeliveryTarget = null;
let currentSpawnPatrolTarget = null;
let currentExploreTarget = null;

const VISION_RADIUS = 5;
const NEAR_PARCEL_DIST = CFG.REACT_NEAR_PARCEL_DIST ?? 3;
const HARD_CARRY_LIMIT = CFG.REACT_HARD_CARRY_LIMIT ?? 15;

function tileEq(a, b) {
  return !!a && !!b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y);
}

export function normalizeAvoidRules(list = []) {
  return list
    .map((t) => ({
      x: Number(t?.x),
      y: Number(t?.y),
      penalty: Number(t?.penalty ?? 0),
    }))
    .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
}

export function buildPathPolicy(avoidRules = [], target = null) {
  const blockedSet = new Set();
  const penaltyMap = new Map();
  const HARD = 50;

  for (const t of avoidRules) {
    const k = key(t.x, t.y);
    if (t.penalty >= HARD) blockedSet.add(k);
    else if (t.penalty > 0) penaltyMap.set(k, t.penalty);
  }

  if (target) blockedSet.delete(key(target.x, target.y));
  return { blockedSet, penaltyMap };
}

function isHardAvoidTile(tile, avoidTiles = [], threshold = 50) {
  return avoidTiles.some(
    (t) => tileEq(tile, t) && Number(t?.penalty ?? 0) >= threshold
  );
}

function softAvoidPenaltyAt(tile, avoidTiles = [], threshold = 50) {
  for (const t of avoidTiles) {
    if (!tileEq(tile, t)) continue;
    const penalty = Number(t?.penalty ?? 0);
    if (!Number.isFinite(penalty)) return 0;
    if (penalty >= threshold) return Infinity;
    return Math.max(0, penalty);
  }
  return 0;
}

export function nearestDeliveryFrom(x, y) {
  let best = null, d = Infinity;
  for (const z of W.deliveryTiles) {
    const dist = manhattan(x, y, z.x, z.y);
    if (dist < d) { d = dist; best = z; }
  }
  return best;
}

export function nearestDelivery() {
  return nearestDeliveryFrom(W.me.x, W.me.y);
}

function bestDeliveryTarget() {
  let best = null, bestScore = -Infinity;
  for (const z of W.deliveryTiles) {
    if (isGoalBlacklisted(z)) continue;
    const score = -manhattan(W.me.x, W.me.y, z.x, z.y);
    if (score > bestScore) {
      bestScore = score;
      best = z;
    }
  }
  return best ?? nearestDelivery();
}

export function utility(p) {
  const distToParcel = manhattan(W.me.x, W.me.y, p.x, p.y);
  const dz = nearestDeliveryFrom(p.x, p.y);
  const distToDelivery = dz ? manhattan(p.x, p.y, dz.x, dz.y) : 0;
  return Math.pow(Number(p.reward ?? 0), CFG.DECAY_WEIGHT ?? 1) /
    (1 + distToParcel + 0.35 * distToDelivery);
}

function parcelReachabilityScore(parcel, path) {
  if (!path) return -Infinity;
  const pathLen = path.length;
  const reward = Number(parcel.reward ?? 0);
  if (reward <= 0) return -Infinity;

  if (!isCrateMap()) {
    if (pathLen + 1 >= reward) return -Infinity;
    return utility(parcel) - 0.05 * pathLen;
  }

  const margin = reward - (pathLen + 1);
  if (margin < -2) return -Infinity;
  return utility(parcel) + 0.15 * margin - 0.03 * pathLen;
}

export function bestParcel(avoidTiles = []) {
  const crateMap = isCrateMap();
  const candidates = [];

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (isHardAvoidTile(p, avoidTiles)) continue;
    const mDist = manhattan(W.me.x, W.me.y, p.x, p.y);
    if (!crateMap && mDist > Number(p.reward ?? 0)) continue;
    candidates.push({ parcel: p, u: utility(p), mDist });
  }

  candidates.sort((a, b) => (b.u !== a.u ? b.u - a.u : a.mDist - b.mDist));

  const limit = crateMap
    ? (CFG.PARCEL_CANDIDATE_LIMIT_CRATE ?? 10)
    : (CFG.PARCEL_CANDIDATE_LIMIT ?? 14);

  let best = null, bestScore = -Infinity;
  for (const c of candidates.slice(0, limit)) {
    const path = planPathToTarget(c.parcel, { avoidTiles });
    const baseScore = parcelReachabilityScore(c.parcel, path);
    const tilePenalty = softAvoidPenaltyAt(c.parcel, avoidTiles);
    const score = tilePenalty === Infinity ? -Infinity : baseScore - tilePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = c.parcel;
    }
  }

  return best;
}

function bestAdjacentParcel() {
  let best = null, bestReward = -Infinity;
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

export function bestNearbyParcel(avoidTiles = [], carriedCount = 0, maxDist = NEAR_PARCEL_DIST) {
  let best = null, bestScore = -Infinity;

  for (const p of W.parcelList) {
    if (!p || p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (isHardAvoidTile(p, avoidTiles)) continue;

    const d = Math.abs(W.me.x - p.x) + Math.abs(W.me.y - p.y);
    if (d === 0 || d > maxDist) continue;

    const path = planPathToTarget(p, { avoidTiles });
    if (!path || path.length > maxDist) continue;

    const reward = Number(p.reward ?? 0);
    const tilePenalty = softAvoidPenaltyAt(p, avoidTiles);
    if (tilePenalty === Infinity) continue;

    const score = reward * 10 - path.length - tilePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

export function bestKnownApproachTile(tx, ty, pathPolicy = null) {
  let best = null, bestScore = Infinity;
  const candidates = [];

  for (const t of W.tiles.values()) {
    if (t.walkable === false) continue;
    const tk = key(t.x, t.y);
    if (pathPolicy?.blockedSet?.has(tk) && tk !== key(tx, ty)) continue;
    candidates.push({ tile: t, dist: manhattan(t.x, t.y, tx, ty) });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  for (const c of candidates.slice(0, CFG.APPROACH_CANDIDATE_LIMIT ?? 24)) {
    const path = aStar(W.me.x, W.me.y, c.tile.x, c.tile.y, pathPolicy);
    if (path === null) continue;
    const guessedPenalty = c.tile.guessed ? 0.2 : 0;
    const score = path.length + 2 * c.dist + guessedPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = { x: c.tile.x, y: c.tile.y, path };
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
      if (!inKnownBounds(nx, ny)) continue;
      if (!W.tiles.has(key(nx, ny)) && !W.tempBlocked.has(key(nx, ny))) {
        frontier = true;
        break;
      }
    }
    if (frontier) arr.push({ x: t.x, y: t.y });
  }
  return arr;
}

export function planPathToTarget(target, opts = {}) {
  if (!target) return [];
  if (isGoalBlacklisted(target)) return null;
  if (!validGoal(target)) return null;

  const avoidRules = normalizeAvoidRules(opts.avoidTiles ?? []);
  const pathPolicy = buildPathPolicy(avoidRules, target);

  const direct = aStar(W.me.x, W.me.y, target.x, target.y, pathPolicy);
  if (direct !== null) return direct;

  if (isCrateMap()) return null;

  const approach = bestKnownApproachTile(target.x, target.y, pathPolicy);
  if (approach?.path?.length > 0) return approach.path;

  return null;
}

function updateVisibleSpawns() {
  if (!W.me) return;
  const now = Date.now();
  for (const s of W.spawnTiles) {
    const dist = Math.max(Math.abs(W.me.x - s.x), Math.abs(W.me.y - s.y));
    if (dist <= VISION_RADIUS) {
      const hasParcel = W.parcelList.some((p) => p.x === s.x && p.y === s.y);
      if (!hasParcel) visitedSpawns.set(`${s.x},${s.y}`, now);
    }
  }
}

export function getOldestUnseenSpawn() {
  if (!W.spawnAreas || W.spawnAreas.length === 0) return null;

  const now = Date.now();
  let bestTarget = null, bestClusterScore = -Infinity;

  for (const cluster of W.spawnAreas) {
    const unseenTiles = [];
    let maxTimeUnseen = 0;

    for (const t of cluster) {
      if (isGoalBlacklisted(t)) continue;
      const lastSeen = visitedSpawns.get(`${t.x},${t.y}`) || 0;
      const timeUnseenSeconds = (now - lastSeen) / 1000;
      if (timeUnseenSeconds >= 15) {
        unseenTiles.push(t);
        if (timeUnseenSeconds > maxTimeUnseen) maxTimeUnseen = timeUnseenSeconds;
      }
    }

    if (unseenTiles.length === 0) continue;

    let closestUnseen = null, minDist = Infinity;
    for (const t of unseenTiles) {
      const d = manhattan(W.me.x, W.me.y, t.x, t.y);
      if (d < minDist) {
        minDist = d;
        closestUnseen = t;
      }
    }

    const score = maxTimeUnseen - minDist * 2;
    if (score > bestClusterScore) {
      bestClusterScore = score;
      bestTarget = { x: closestUnseen.x, y: closestUnseen.y };
    }
  }

  if (bestTarget) currentSpawnPatrolTarget = bestTarget;
  return bestTarget;
}

function nextSpawnPatrolTarget() {
  updateVisibleSpawns();

  if (currentSpawnPatrolTarget && !isGoalBlacklisted(currentSpawnPatrolTarget)) {
    const lastSeen = visitedSpawns.get(
      `${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`
    ) || 0;
    if (Date.now() - lastSeen > 5000) return currentSpawnPatrolTarget;
    currentSpawnPatrolTarget = null;
  }

  return getOldestUnseenSpawn();
}

export function completeSpawnPatrol() {
  if (currentSpawnPatrolTarget) {
    visitedSpawns.set(
      `${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`,
      Date.now()
    );
  }
  currentSpawnPatrolTarget = null;
}

export function hasOpportunisticNearbyParcel(hint = null) {
  const carriedCount = carryingCount();
  if (carriedCount >= HARD_CARRY_LIMIT) return false;
  return !!bestNearbyParcel(hint?.avoidTiles ?? [], carriedCount, NEAR_PARCEL_DIST);
}

export function bestOpportunisticNearbyParcel(hint = null) {
  const carriedCount = carryingCount();
  return bestNearbyParcel(hint?.avoidTiles ?? [], carriedCount, NEAR_PARCEL_DIST);
}

export async function deliberate(hint = null) {
  updateVisibleSpawns();

  const avoidTiles = hint?.avoidTiles ?? [];
  const carried = carriedParcels();
  const carriedCount = carryingCount();
  const total = carried.reduce((s, p) => s + Number(p.reward ?? 0), 0);
  const softLimit = W.strategy?.carryTarget ?? 2;

  const mapArea = (W.mapWidth ?? 0) * (W.mapHeight ?? 0);
  const isLargeMap = mapArea >= 400;
  const effectiveLimit = isLargeMap ? Math.min(softLimit, 2) : softLimit;

  const deliveryTarget = bestDeliveryTarget();

  if (!carriedCount) forcedDeliveryTarget = null;

  if (hint?.mode === "WAIT") return { type: "WAIT", target: null };

  if (hint?.moveTo && !isGoalBlacklisted(hint.moveTo)) {
    const meetRadius = Number(hint?.meetRadius ?? 0);
    if (manhattan(W.me.x, W.me.y, hint.moveTo.x, hint.moveTo.y) > meetRadius)
      return { type: "MOVE", target: hint.moveTo };
    return { type: "WAIT", target: null };
  }

  if (carriedCount > 0 && forcedDeliveryTarget) {
    if (validGoal(forcedDeliveryTarget) && !isGoalBlacklisted(forcedDeliveryTarget)) {
      return { type: "DELIVER", target: forcedDeliveryTarget };
    }
    forcedDeliveryTarget = null;
  }

  if (carriedCount > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    const d = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);

    const hardDeliver =
      d <= 1 ||
      total >= 80 ||
      carriedCount === W.parcelList.length ||
      carriedCount >= effectiveLimit;

    if (hardDeliver) {
      forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
      return { type: "DELIVER", target: deliveryTarget };
    }

    const rewardOk = total >= (CFG.DELIVER_REWARD_THRESHOLD ?? 10);
    const distOk = isLargeMap ? true : d <= (CFG.DELIVER_DIST_THRESHOLD ?? 10);

    if (rewardOk && distOk) {
      const path = planPathToTarget(deliveryTarget, { avoidTiles });
      if (path && path.length > 0) {
        forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
        return { type: "DELIVER", target: deliveryTarget };
      }
    }
  }

  const adjacentParcel = bestAdjacentParcel();
  if (adjacentParcel && carriedCount < HARD_CARRY_LIMIT) {
    return { type: "PICKUP", target: adjacentParcel };
  }

  if (carriedCount === 0) {
    const nearbyParcel = bestNearbyParcel(avoidTiles, carriedCount, NEAR_PARCEL_DIST);
    if (nearbyParcel) return { type: "PICKUP", target: nearbyParcel };
  }

  if (carriedCount < effectiveLimit) {
    const p = bestParcel(avoidTiles);
    if (p) return { type: "PICKUP", target: p };
  }

  if (carriedCount > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
    return { type: "DELIVER", target: deliveryTarget };
  }

  if (W.spawnTiles.length > 0) {
    const patrol = nextSpawnPatrolTarget();
    if (patrol && !isHardAvoidTile(patrol, avoidTiles)) {
      return { type: "PATROL", target: patrol };
    }
  }

  const frontiers = frontierTiles();
  if (frontiers.length > 0) {
    if (currentExploreTarget && samePos(W.me, currentExploreTarget))
      currentExploreTarget = null;

    if (currentExploreTarget && !isGoalBlacklisted(currentExploreTarget)) {
      const stillValid = frontiers.some(
        (f) =>
          f.x === currentExploreTarget.x &&
          f.y === currentExploreTarget.y &&
          !isHardAvoidTile(f, avoidTiles)
      );
      if (stillValid) return { type: "EXPLORE", target: currentExploreTarget };
    }

    let bestFrontier = null, closestDist = Infinity;
    for (const f of frontiers) {
      if (isGoalBlacklisted(f)) continue;
      if (isHardAvoidTile(f, avoidTiles)) continue;
      const d = manhattan(W.me.x, W.me.y, f.x, f.y);
      if (d < closestDist) {
        closestDist = d;
        bestFrontier = { x: f.x, y: f.y };
      }
    }

    if (bestFrontier) {
      currentExploreTarget = bestFrontier;
      return { type: "EXPLORE", target: bestFrontier };
    }
  }

  currentExploreTarget = null;
  return { type: "EXPLORE", target: null };
}