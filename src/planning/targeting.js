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
import {
  normalizeMissionPolicy,
  pickupAllowed,
  deliveryAllowed,
  deliveryMustHappenNow,
  missionNeedsMorePickup,
} from "../llm/mission-policies.js";

let forcedDeliveryTarget = null;
let currentSpawnPatrolTarget = null;
let currentExploreTarget = null;

const VISION_RADIUS = 5;
const NEAR_PARCEL_DIST = CFG.REACT_NEAR_PARCEL_DIST ?? 3;
const HARD_CARRY_LIMIT = CFG.REACT_HARD_CARRY_LIMIT ?? 15;

function tileEq(a, b) {
  return !!a && !!b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y);
}

function tileInList(tile, list = []) {
  return list.some((t) => tileEq(tile, t));
}

function hardAvoidThreshold(policy) {
  const v = Number(policy?.movement?.hardAvoidPenaltyThreshold ?? 50);
  return Number.isFinite(v) ? v : 50;
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
  const hardThreshold = 50;

  for (const t of avoidRules) {
    const k = key(t.x, t.y);
    if (t.penalty >= hardThreshold) {
      blockedSet.add(k);
    } else if (t.penalty > 0) {
      penaltyMap.set(k, t.penalty);
    }
  }

  if (target) {
    blockedSet.delete(key(target.x, target.y));
  }

  return { blockedSet, penaltyMap };
}

function inTrafficLightStopState(constraints) {
  const parity = constraints?.trafficLight?.rowParity;
  if (!parity || !W.me) return false;

  const y = Number(W.me.y);
  if (!Number.isFinite(y)) return false;

  const isOdd = Math.abs(y % 2) === 1;
  if (parity === "odd" && isOdd) return true;
  if (parity === "even" && !isOdd) return true;
  return false;
}

function nearTarget(target, radius = 0) {
  if (!target || !W.me) return false;
  return (
    manhattan(W.me.x, W.me.y, target.x, target.y) <=
    Math.max(0, Number(radius) || 0)
  );
}

function bestMoveToMissionTarget(target, radius = 0, avoidTiles = []) {
  if (!target || isGoalBlacklisted(target)) return null;

  if (nearTarget(target, radius)) {
    return { x: target.x, y: target.y };
  }

  const direct = planPathToTarget(target, { avoidTiles });
  if (direct !== null) {
    return { x: target.x, y: target.y };
  }

  const avoidRules = normalizeAvoidRules(avoidTiles);
  const pathPolicy = buildPathPolicy(avoidRules, target);
  const approach = bestKnownApproachTile(target.x, target.y, pathPolicy);
  return approach ? { x: approach.x, y: approach.y } : null;
}

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

function deliveryMultiplierAt(tile, policy) {
  for (const item of policy?.delivery?.multipliers ?? []) {
    if (tileEq(tile, item)) {
      const mult = Number(item.multiplier ?? 1);
      return Number.isFinite(mult) ? mult : 1;
    }
  }
  return 1;
}

function bestDeliveryTarget(policy, carried = []) {
  let best = null;
  let bestScore = -Infinity;

  for (const z of W.deliveryTiles) {
    if (isGoalBlacklisted(z)) continue;
    if (tileInList(z, policy?.delivery?.forbiddenTiles)) continue;

    const dist = manhattan(W.me.x, W.me.y, z.x, z.y);
    let score = -dist;

    if (tileInList(z, policy?.delivery?.preferredTiles)) {
      score += 40;
    }

    if (tileInList(z, policy?.delivery?.zeroRewardTiles)) {
      score -= 500;
    }

    const multiplier = deliveryMultiplierAt(z, policy);
    score += 30 * multiplier;

    const maxScore = Number(policy?.pickup?.maxParcelScore);
    if (Number.isFinite(maxScore)) {
      const violatingCount = carried.filter(
        (p) => Number(p.reward ?? 0) > maxScore
      ).length;
      score -= violatingCount * 25;
    }

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

  return (
    Math.pow(p.reward, CFG.DECAY_WEIGHT) /
    (1 + distToParcel + 0.35 * distToDelivery)
  );
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

function parcelAllowedByMission(parcel, policy, ctx = {}) {
  return pickupAllowed(policy, {
    parcel,
    carriedCount: ctx.carriedCount ?? 0,
    isOpportunistic: !!ctx.isOpportunistic,
  });
}

export function bestParcel(policy, carriedCount = 0) {
  const crateMap = isCrateMap();
  const candidates = [];
  const avoidTiles = policy?.movement?.avoidTiles ?? [];
  const hardThreshold = hardAvoidThreshold(policy);

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (
      !parcelAllowedByMission(p, policy, {
        carriedCount,
        isOpportunistic: false,
      })
    )
      continue;
    if (isHardAvoidTile(p, avoidTiles, hardThreshold)) continue;

    const mDist = manhattan(W.me.x, W.me.y, p.x, p.y);
    if (!crateMap && mDist > p.reward) continue;

    candidates.push({
      parcel: p,
      u: utility(p),
      mDist,
    });
  }

  candidates.sort((a, b) => {
    if (b.u !== a.u) return b.u - a.u;
    return a.mDist - b.mDist;
  });

  const candidateLimit = crateMap
    ? CFG.PARCEL_CANDIDATE_LIMIT_CRATE ?? 10
    : CFG.PARCEL_CANDIDATE_LIMIT ?? 14;

  let best = null;
  let bestScore = -Infinity;

  for (const c of candidates.slice(0, candidateLimit)) {
    const path = planPathToTarget(c.parcel, { avoidTiles });
    const baseScore = parcelReachabilityScore(c.parcel, path);
    const tilePenalty = softAvoidPenaltyAt(c.parcel, avoidTiles, hardThreshold);
    const score =
      tilePenalty === Infinity ? -Infinity : baseScore - tilePenalty;

    if (score > bestScore) {
      bestScore = score;
      best = c.parcel;
    }
  }

  return best;
}

function bestAdjacentParcel(policy, carriedCount = 0) {
  let best = null;
  let bestReward = -Infinity;

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (
      !parcelAllowedByMission(p, policy, {
        carriedCount,
        isOpportunistic: true,
      })
    )
      continue;
    if (manhattan(W.me.x, W.me.y, p.x, p.y) !== 1) continue;

    const reward = Number(p.reward ?? 0);
    if (reward > bestReward) {
      bestReward = reward;
      best = p;
    }
  }

  return best;
}

export function bestNearbyParcel(policy, carriedCount = 0, maxDist = NEAR_PARCEL_DIST) {
  const avoidTiles = policy?.movement?.avoidTiles ?? [];
  const hardThreshold = hardAvoidThreshold(policy);

  let best = null;
  let bestScore = -Infinity;

  for (const p of W.parcelList) {
    if (!p) continue;
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (
      !parcelAllowedByMission(p, policy, {
        carriedCount,
        isOpportunistic: true,
      })
    )
      continue;
    if (isHardAvoidTile(p, avoidTiles, hardThreshold)) continue;

    const d = Math.abs(W.me.x - p.x) + Math.abs(W.me.y - p.y);
    if (d === 0 || d > maxDist) continue;

    const path = planPathToTarget(p, { avoidTiles });
    if (!path || path.length > maxDist) continue;

    const reward = Number(p.reward ?? 0);
    const tilePenalty = softAvoidPenaltyAt(p, avoidTiles, hardThreshold);
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
  let best = null;
  let bestScore = Infinity;

  const candidates = [];
  for (const t of W.tiles.values()) {
    if (t.walkable === false) continue;

    const tk = key(t.x, t.y);
    if (pathPolicy?.blockedSet?.has(tk) && tk !== key(tx, ty)) continue;

    const dist = manhattan(t.x, t.y, tx, ty);
    candidates.push({ tile: t, dist });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  const topCandidates = candidates.slice(0, CFG.APPROACH_CANDIDATE_LIMIT ?? 24);

  for (const c of topCandidates) {
    const t = c.tile;
    const path = aStar(W.me.x, W.me.y, t.x, t.y, pathPolicy);

    if (path === null) continue;

    const guessedPenalty = t.guessed ? 0.2 : 0;
    const score = path.length + 2 * c.dist + guessedPenalty;

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
      if (!hasParcel) {
        visitedSpawns.set(`${s.x},${s.y}`, now);
      }
    }
  }
}

export function getOldestUnseenSpawn() {
  if (!W.spawnAreas || W.spawnAreas.length === 0) return null;

  const now = Date.now();
  let bestTarget = null;
  let bestClusterScore = -Infinity;

  for (const cluster of W.spawnAreas) {
    const unseenTiles = [];
    let maxTimeUnseen = 0;

    for (const t of cluster) {
      if (isGoalBlacklisted(t)) continue;
      const lastSeen = visitedSpawns.get(`${t.x},${t.y}`) || 0;
      const timeUnseenSeconds = (now - lastSeen) / 1000;

      if (timeUnseenSeconds >= 15) {
        unseenTiles.push(t);
        if (timeUnseenSeconds > maxTimeUnseen) {
          maxTimeUnseen = timeUnseenSeconds;
        }
      }
    }

    if (unseenTiles.length === 0) continue;

    let closestUnseen = null;
    let minDist = Infinity;

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

  if (bestTarget) {
    currentSpawnPatrolTarget = bestTarget;
  }

  return bestTarget;
}

function nextSpawnPatrolTarget() {
  updateVisibleSpawns();

  if (currentSpawnPatrolTarget && !isGoalBlacklisted(currentSpawnPatrolTarget)) {
    const lastSeen =
      visitedSpawns.get(
        `${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`
      ) || 0;

    if (Date.now() - lastSeen > 2000) {
      return currentSpawnPatrolTarget;
    }

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

function carriedViolatesScoreRule(carried, policy) {
  const maxScore = Number(policy?.pickup?.maxParcelScore);
  if (!Number.isFinite(maxScore)) return false;

  return carried.some((p) => Number(p.reward ?? 0) > maxScore);
}

function shouldDoTrafficLightWait(policy) {
  if (!policy?.wait?.trafficLight) return false;
  return inTrafficLightStopState({ trafficLight: policy.wait.trafficLight });
}

function bestCoordinationTarget(policy, avoidTiles) {
  const meet = policy?.movement?.meetTarget;
  const radius = Number(policy?.movement?.meetRadius ?? 3);

  if (meet && !isGoalBlacklisted(meet)) {
    return bestMoveToMissionTarget(meet, radius, avoidTiles);
  }

  const moveTo = policy?.movement?.moveTo;
  if (moveTo && !isGoalBlacklisted(moveTo)) {
    return bestMoveToMissionTarget(moveTo, 0, avoidTiles);
  }

  return null;
}

export function hasOpportunisticNearbyParcel(mission = null) {
  const policy = normalizeMissionPolicy(mission);
  const carriedCount = carryingCount();

  if (carriedCount >= HARD_CARRY_LIMIT) return false;

  return !!bestNearbyParcel(policy, carriedCount, NEAR_PARCEL_DIST);
}

export function bestOpportunisticNearbyParcel(mission = null) {
  const policy = normalizeMissionPolicy(mission);
  const carriedCount = carryingCount();
  return bestNearbyParcel(policy, carriedCount, NEAR_PARCEL_DIST);
}

export function deliberate(mission = null) {
  updateVisibleSpawns();

  const policy = normalizeMissionPolicy(mission);
  const avoidTiles = policy?.movement?.avoidTiles ?? [];
  const hardThreshold = hardAvoidThreshold(policy);

  const carried = carriedParcels();
  const carriedCount = carryingCount();
  const total = carried.reduce((s, p) => s + Number(p.reward ?? 0), 0);

  const hardLimit = HARD_CARRY_LIMIT;
  const softLimit = Number.isFinite(policy?.delivery?.exactCount)
    ? policy.delivery.exactCount
    : W.strategy?.carryTarget ?? 2;

  const deliveryTarget = bestDeliveryTarget(policy, carried);
  const missionRequiresMorePickup = missionNeedsMorePickup(policy, {
    carriedCount,
  });
  const missionReadyToDeliver = deliveryMustHappenNow(policy, { carriedCount });

  if (!carriedCount) {
    forcedDeliveryTarget = null;
  }

  if (policy?.wait?.mustWait) {
    return { type: "WAIT", target: null };
  }

  if (shouldDoTrafficLightWait(policy)) {
    return { type: "WAIT", target: null };
  }

  const coordinationTarget = bestCoordinationTarget(policy, avoidTiles);
  if (coordinationTarget) {
    if (!nearTarget(coordinationTarget, policy?.movement?.meetRadius ?? 0)) {
      return { type: "MOVE", target: coordinationTarget };
    }
    return { type: "WAIT", target: null };
  }

  const adjacentParcel = bestAdjacentParcel(policy, carriedCount);
  if (adjacentParcel && carriedCount < hardLimit && !missionReadyToDeliver) {
    forcedDeliveryTarget = null;
    return { type: "PICKUP", target: adjacentParcel };
  }

  const nearbyParcel = bestNearbyParcel(policy, carriedCount, NEAR_PARCEL_DIST);
  if (nearbyParcel && carriedCount < hardLimit && !missionReadyToDeliver) {
    forcedDeliveryTarget = null;
    return { type: "PICKUP", target: nearbyParcel };
  }

  const p = bestParcel(policy, carriedCount);
  if (missionRequiresMorePickup && p && carriedCount < hardLimit) {
    forcedDeliveryTarget = null;
    return { type: "PICKUP", target: p };
  }

  if (carriedCount > 0 && forcedDeliveryTarget) {
    const lockedValid =
      validGoal(forcedDeliveryTarget) && !isGoalBlacklisted(forcedDeliveryTarget);

    if (lockedValid) {
      return { type: "DELIVER", target: forcedDeliveryTarget };
    } else {
      forcedDeliveryTarget = null;
    }
  }

  if (
    carriedCount > 0 &&
    carriedViolatesScoreRule(carried, policy) &&
    deliveryTarget &&
    !isGoalBlacklisted(deliveryTarget)
  ) {
    forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
    return { type: "DELIVER", target: deliveryTarget };
  }

  if (
    missionReadyToDeliver &&
    carriedCount > 0 &&
    deliveryTarget &&
    !isGoalBlacklisted(deliveryTarget)
  ) {
    forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
    return { type: "DELIVER", target: deliveryTarget };
  }

  if (
    deliveryAllowed(policy, { carriedCount }) &&
    !missionRequiresMorePickup &&
    carriedCount > 0 &&
    deliveryTarget &&
    !isGoalBlacklisted(deliveryTarget)
  ) {
    const d = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);

    if (
      carriedCount >= softLimit ||
      d <= 1 ||
      total >= 80 ||
      carriedCount === W.parcelList.length
    ) {
      forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
      return { type: "DELIVER", target: deliveryTarget };
    }

    if (
      total >= CFG.DELIVER_REWARD_THRESHOLD &&
      d <= CFG.DELIVER_DIST_THRESHOLD
    ) {
      const path = planPathToTarget(deliveryTarget, { avoidTiles });
      if (path && path.length > 0) {
        forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
        return { type: "DELIVER", target: deliveryTarget };
      }
    }
  }

  if (p) {
    return { type: "PICKUP", target: p };
  }

  if (W.spawnTiles.length > 0) {
    const patrol = nextSpawnPatrolTarget();
    if (patrol && !isHardAvoidTile(patrol, avoidTiles, hardThreshold)) {
      return { type: "PATROL", target: patrol };
    }
  }

  const frontiers = frontierTiles();
  if (frontiers.length > 0) {
    if (currentExploreTarget && samePos(W.me, currentExploreTarget)) {
      currentExploreTarget = null;
    }

    if (currentExploreTarget && !isGoalBlacklisted(currentExploreTarget)) {
      const stillValid = frontiers.some(
        (f) =>
          f.x === currentExploreTarget.x &&
          f.y === currentExploreTarget.y &&
          !isHardAvoidTile(f, avoidTiles, hardThreshold)
      );

      if (stillValid) {
        return { type: "EXPLORE", target: currentExploreTarget };
      }
    }

    let bestFrontier = null;
    let closestDist = Infinity;

    for (const f of frontiers) {
      if (isGoalBlacklisted(f)) continue;
      if (isHardAvoidTile(f, avoidTiles, hardThreshold)) continue;

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