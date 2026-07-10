import { W, visitedSpawns } from "../world/state.js";
import { manhattan, key } from "../utils/math.js";
import { DIRS, samePos } from "../utils/directions.js";
import { isCrateMap } from "../world/mapAnalysis.js";
import { aStar, planExactPathToTarget } from "./astar.js";
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
  deliveryPreferredCarryTarget,
  missionNeedsMorePickup,
} from "../llm/mission-policies.js";

let forcedDeliveryTarget = null;
let forcedDeliveryBlacklistWaits = 0;
let currentSpawnPatrolTarget = null;
let currentExploreTarget = null;

const VISION_RADIUS = 5;
const NEAR_PARCEL_DIST = CFG.REACT_NEAR_PARCEL_DIST ?? 3;
const HARD_CARRY_LIMIT = CFG.REACT_HARD_CARRY_LIMIT ?? 15;
const DELIVERY_OCCUPIED_PENALTY = CFG.DELIVERY_OCCUPIED_PENALTY ?? 1000;

function tileEq(a, b) {
  return !!a && !!b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y);
}

function tileInList(tile, list = []) {
  return list.some((t) => tileEq(tile, t));
}

function hasFinite(v) {
  if (v === null || v === undefined || v === "") return false;
  return Number.isFinite(Number(v));
}

function hasRealMissionConstraint(policy = null) {
  if (!policy) return false;
  // count-capped missions need deliberate(), not baseline carry heuristics
  if (policy?.wait?.mustWait) return true;
  if (policy?.wait?.trafficLight) return true;
  if (policy?.movement?.moveTo) return true;
  if (policy?.movement?.meetTarget) return true;
  if (Number.isFinite(policy?.movement?.meetRow)) return true;
  if (Number.isFinite(policy?.movement?.meetColumn)) return true;
  if (policy?.pickup?.enabled === false) return true;
  if (policy?.delivery?.enabled === false) return true;
  if (hasFinite(policy?.pickup?.minCarry)) return true;
  if (hasFinite(policy?.pickup?.exactCarry)) return true;
  if (hasFinite(policy?.pickup?.maxCarry)) return true;
  if (policy?.pickup?.opportunisticOnly) return true;
  if (hasFinite(policy?.pickup?.minParcelScore)) return true;
  if (hasFinite(policy?.pickup?.maxParcelScore)) return true;
  if ((policy?.pickup?.forbiddenTiles ?? []).length > 0) return true;
  if ((policy?.pickup?.preferredTiles ?? []).length > 0) return true;
  if (hasFinite(policy?.delivery?.exactCount)) return true;
  if (hasFinite(policy?.delivery?.minCount)) return true;
  if (hasFinite(policy?.delivery?.maxCount)) return true;
  if (hasFinite(policy?.delivery?.minExclusiveCount)) return true;
  if (hasFinite(policy?.delivery?.maxExclusiveCount)) return true;
  if (hasFinite(policy?.delivery?.minParcelScore)) return true;
  if (hasFinite(policy?.delivery?.maxParcelScore)) return true;
  if (hasFinite(policy?.delivery?.minTotalScore)) return true;
  if (hasFinite(policy?.delivery?.maxTotalScore)) return true;
  if ((policy?.delivery?.preferredTiles ?? []).length > 0) return true;
  if ((policy?.delivery?.forbiddenTiles ?? []).length > 0) return true;
  if ((policy?.delivery?.zeroRewardTiles ?? []).length > 0) return true;
  if ((policy?.delivery?.multipliers ?? []).length > 0) return true;
  if (policy?.meta?.dropRule?.region) return true;
  if ((policy?.meta?.dropRule?.targetTiles ?? []).length > 0) return true;
  if (policy?.meta?.handoffBonus) return true;
  if ((policy?.movement?.avoidRules ?? []).length > 0) return true;
  if ((policy?.movement?.avoidTiles ?? []).length > 0) return true;
  if ((policy?.movement?.preferTiles ?? []).length > 0) return true;
  return false;
}

function hasScoreBasedMissionConstraint(policy = null) {
  if (!policy) return false;
  if (hasFinite(policy?.pickup?.minParcelScore)) return true;
  if (hasFinite(policy?.pickup?.maxParcelScore)) return true;
  if (hasFinite(policy?.delivery?.minParcelScore)) return true;
  if (hasFinite(policy?.delivery?.maxParcelScore)) return true;
  return false;
}

function countOnlyDeliveryMission(policy = null) {
  if (!policy) return false;
  const hasCountRule = hasFinite(policy?.delivery?.exactCount)
    || hasFinite(policy?.delivery?.minCount)
    || hasFinite(policy?.delivery?.maxCount)
    || hasFinite(policy?.delivery?.minExclusiveCount)
    || hasFinite(policy?.delivery?.maxExclusiveCount);
  return hasCountRule && !hasScoreBasedMissionConstraint(policy);
}

function hardAvoidThreshold(policy = null) {
  const v = Number(policy?.movement?.hardAvoidPenaltyThreshold ?? 50);
  return Number.isFinite(v) ? v : 50;
}

export function normalizeAvoidRules(list = []) {
  return list
    .map((t) => ({ x: Number(t?.x), y: Number(t?.y), penalty: Number(t?.penalty ?? 0) }))
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
  return avoidTiles.some((t) => tileEq(tile, t) && Number(t?.penalty ?? 0) >= threshold);
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

function otherAgentOccupiesTile(tile) {
  if (!tile) return false;
  const ax = Number(tile.x);
  const ay = Number(tile.y);
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;

  for (const agent of W.agents?.values?.() ?? []) {
    if (!agent) continue;
    const id = agent.id ?? agent.name;
    if (String(id) === String(W.me?.id ?? W.me?.name ?? "")) continue;
    if (Number(agent.x) === ax && Number(agent.y) === ay) return true;
  }

  return false;
}

export function nearestDeliveryFrom(x, y) {
  let best = null, d = Infinity;
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

// reward decays ~1pt per W.gameParams.decayInterval ms, a tile move takes
// ~movementDuration ms. comparing raw tile distance to reward assumes a 1:1
// ratio, which is way off on servers where it's more like 7 tiles/point -
// falls back to 1:1 until we've actually measured it
function tilesPerDecayPoint() {
  const { decayInterval, movementDuration } = W.gameParams ?? {};
  if (!Number.isFinite(decayInterval) || !Number.isFinite(movementDuration) || movementDuration <= 0) {
    return 1;
  }
  return decayInterval / movementDuration;
}

// tilesPerDecayPoint() is a median of observed moves, doesn't capture failed
// steps or contention - inflate it a bit so only clearly worthwhile parcels
// pass instead of marginal ones that end up at/below break-even
const DECAY_SAFETY_FACTOR = 1.3;

function decayUnits(tiles) {
  const ratio = tilesPerDecayPoint();
  return ratio > 0 ? (tiles / ratio) * DECAY_SAFETY_FACTOR : tiles;
}

function turnsUntilDeliveredFrom(parcel, deliveryTile) {
  const toParcel = manhattan(W.me.x, W.me.y, parcel.x, parcel.y);
  const toDelivery = manhattan(parcel.x, parcel.y, deliveryTile.x, deliveryTile.y);
  return decayUnits(toParcel + toDelivery);
}

function projectedRewardAtDelivery(parcel, deliveryTile) {
  const reward = Number(parcel?.reward ?? 0);
  if (!Number.isFinite(reward)) return 0;
  const eta = turnsUntilDeliveredFrom(parcel, deliveryTile);
  return reward - eta;
}

// extra distance a detour to fetch `parcel` costs vs going straight to
// `deliveryTarget`, applied in decay to the whole carried batch, not just
// the new parcel - a candidate can score fine on its own and still be a net
// loss once you factor in what the detour costs everything already in the bag
function carriedDetourCost(carried, parcel, deliveryTarget) {
  if (!deliveryTarget || !carried || carried.length === 0) return 0;
  const directDist = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);
  const detourDist =
    manhattan(W.me.x, W.me.y, parcel.x, parcel.y) +
    manhattan(parcel.x, parcel.y, deliveryTarget.x, deliveryTarget.y);
  const extraDist = Math.max(0, detourDist - directDist);
  return decayUnits(extraDist) * carried.length;
}

function carriedSetCanBeDeliveredAtTarget(carried, deliveryTile, policy) {
  const threshold = Number(policy?.delivery?.minParcelScore);
  if (!Number.isFinite(threshold)) return true;
  return carried.every((p) => projectedRewardAtDelivery(p, deliveryTile) >= threshold);
}

function parcelMeetsDeliveryValueRuleAtTarget(parcel, deliveryTile, policy) {
  const threshold = Number(policy?.delivery?.minParcelScore);
  if (!Number.isFinite(threshold)) return true;
  return projectedRewardAtDelivery(parcel, deliveryTile) >= threshold;
}

function bestDeliveryTargetBaseline() {
  let best = null, bestScore = -Infinity;
  for (const z of W.deliveryTiles) {
    if (isGoalBlacklisted(z)) continue;
    let score = -manhattan(W.me.x, W.me.y, z.x, z.y);
    if (otherAgentOccupiesTile(z)) score -= DELIVERY_OCCUPIED_PENALTY;
    if (score > bestScore) {
      bestScore = score;
      best = z;
    }
  }
  return best ?? nearestDelivery();
}

function bestDeliveryTargetMission(policy, carried) {
  const avoidTiles = policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? [];
  const hardThreshold = hardAvoidThreshold(policy);
  let best = null, bestScore = -Infinity;
  for (const z of W.deliveryTiles) {
    if (isGoalBlacklisted(z)) continue;
    if (tileInList(z, policy?.delivery?.forbiddenTiles)) continue;
    if (isHardAvoidTile(z, avoidTiles, hardThreshold)) continue;
    if (!carriedSetCanBeDeliveredAtTarget(carried, z, policy)) continue;

    // don't keep selecting a delivery tile the pathfinder can't reach, or
    // it'll replan the same bad target forever on narrow/blocked maps
    if (!samePos(W.me, z)) {
      const path = planPathToTarget(z, { avoidTiles });
      if (!Array.isArray(path) || path.length === 0) continue;
    }

    const dist = manhattan(W.me.x, W.me.y, z.x, z.y);
    let score = -dist;
    if (tileInList(z, policy?.delivery?.preferredTiles)) score += 40;
    if (tileInList(z, policy?.delivery?.zeroRewardTiles)) score -= 500;
    const mult = deliveryMultiplierAt(z, policy);
    if (mult !== 1) score += (mult - 1) * 50;
    const tilePenalty = softAvoidPenaltyAt(z, avoidTiles, hardThreshold);
    if (tilePenalty === Infinity) continue;
    score -= tilePenalty;
    if (otherAgentOccupiesTile(z)) score -= DELIVERY_OCCUPIED_PENALTY;
    if (score > bestScore) {
      bestScore = score;
      best = z;
    }
  }
  return best ?? nearestDelivery();
}

function bestDeliveryTarget(policy = null, carried = carriedParcels()) {
  if (!hasRealMissionConstraint(policy)) return bestDeliveryTargetBaseline();
  // a drop_rule mission has exactly one required destination, not a scored
  // custom drop tiles override ordinary delivery-target selection
  const dropTarget = dropRuleTarget(policy);
  if (dropTarget) return dropTarget;
  return bestDeliveryTargetMission(policy, carried);
}

export function utility(parcel, policy = null, deliveryTarget = null) {
  const distToParcel = manhattan(W.me.x, W.me.y, parcel.x, parcel.y);
  const dz = deliveryTarget ?? nearestDeliveryFrom(parcel.x, parcel.y);
  const distToDelivery = dz ? manhattan(parcel.x, parcel.y, dz.x, dz.y) : 0;
  const reward = policy ? effectiveParcelReward(parcel, policy) : Number(parcel.reward ?? 0);
  if (reward <= 0) return -Infinity;
  let base = Math.pow(reward, CFG.DECAY_WEIGHT ?? 1) / (1 + decayUnits(distToParcel + 0.35 * distToDelivery));
  const threshold = Number(policy?.delivery?.minParcelScore);
  if (Number.isFinite(threshold) && dz) {
    const projected = projectedRewardAtDelivery(parcel, dz);
    if (projected < threshold) return -Infinity;
    base += Math.min(20, projected - threshold);
  }
  return base;
}

function parcelReachabilityScore(parcel, path, policy = null, deliveryTarget = null) {
  if (!path) return -Infinity;
  const pathLen = path.length;
  const reward = policy ? effectiveParcelReward(parcel, policy) : Number(parcel.reward ?? 0);
  if (reward <= 0) return -Infinity;
  const dz = deliveryTarget ?? nearestDeliveryFrom(parcel.x, parcel.y);
  // require the parcel to survive the full pickup-to-delivery route
  const distToDelivery = dz ? manhattan(parcel.x, parcel.y, dz.x, dz.y) : 0;
  const threshold = Number(policy?.delivery?.minParcelScore);
  if (Number.isFinite(threshold) && dz) {
    const projected = projectedRewardAtDelivery(parcel, dz);
    if (projected < threshold) return -Infinity;
  }
  if (!isCrateMap()) {
    if (decayUnits(pathLen + distToDelivery) + 1 >= reward) return -Infinity;
    return utility(parcel, policy, dz) - 0.05 * pathLen;
  }
  const margin = reward - (decayUnits(pathLen + distToDelivery) + 1);
  if (margin < -2) return -Infinity;
  return utility(parcel, policy, dz) + 0.15 * margin - 0.03 * pathLen;
}

export function maxParcelScoreValue(policy) {
  // pickup max-score rules affect pickup; delivery caps apply at drop time
  const pickupMax = policy?.pickup?.maxParcelScore;
  return Number.isFinite(pickupMax) ? Number(pickupMax) : null;
}

export function effectiveParcelReward(parcel, policy) {
  const rawReward = Number(parcel?.reward ?? 0);
  if (!Number.isFinite(rawReward)) return 0;
  const pickupMaxScore = maxParcelScoreValue(policy);
  if (pickupMaxScore === null) return rawReward;
  if (rawReward <= pickupMaxScore) return rawReward;
  return 0;
}

export function carriedEffectiveTotalFromParcels(carried = [], policy = null) {
  return carried.reduce((s, p) => s + effectiveParcelReward(p, policy), 0);
}

export function carriedEffectiveTotal(policy = null) {
  return carriedEffectiveTotalFromParcels(carriedParcels(), policy);
}

export function carriedHasNegativeEffectiveTotal(policy = null) {
  return carriedEffectiveTotal(policy) < 0;
}

export function parcelAllowedByMission(parcel, policy, ctx = {}) {
  return pickupAllowed(policy, {
    parcel,
    carriedCount: ctx.carriedCount ?? 0,
    isOpportunistic: !!ctx.isOpportunistic,
  });
}

export function parcelShouldBeAvoided(parcel, policy, ctx = {}) {
  if (!parcelAllowedByMission(parcel, policy, ctx)) return true;
  if (!hasScoreBasedMissionConstraint(policy)) return false;
  const effective = effectiveParcelReward(parcel, policy);
  if (effective < 0) return true;
  if (effective === 0 && !ctx.allowZeroReward) return true;
  return false;
}

export function positiveParcelsHere(policy, carriedCount = 0, ctx = {}) {
  const here = [];
  for (const p of W.parcelList ?? []) {
    if (!p) continue;
    if (Number(p.x) !== Number(W.me?.x) || Number(p.y) !== Number(W.me?.y)) continue;
    if (p.carriedBy) continue;
    if (parcelShouldBeAvoided(p, policy, {
      carriedCount,
      isOpportunistic: !!ctx.isOpportunistic,
      allowZeroReward: !!ctx.allowZeroReward,
    })) continue;
    here.push(p);
  }
  return here;
}

export function bestParcel(avoidTiles = [], mission = null, carriedCountArg = null) {
  const policy = normalizeMissionPolicy(mission);
  const hasMission = hasRealMissionConstraint(policy);

  if (!hasMission) {
    const crateMap = isCrateMap();
    const candidates = [];
    for (const p of W.parcelList) {
      if (p.carriedBy) continue;
      if (isGoalBlacklisted(p)) continue;
      if (isHardAvoidTile(p, avoidTiles)) continue;
      const mDist = manhattan(W.me.x, W.me.y, p.x, p.y);
      if (!crateMap && decayUnits(mDist) > Number(p.reward ?? 0)) continue;
      candidates.push({ parcel: p, u: utility(p), mDist });
    }
    candidates.sort((a, b) => (b.u !== a.u ? b.u - a.u : a.mDist - b.mDist));
    const limit = crateMap ? (CFG.PARCEL_CANDIDATE_LIMIT_CRATE ?? 10) : (CFG.PARCEL_CANDIDATE_LIMIT ?? 14);
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

  const crateMap = isCrateMap();
  const carried = carriedParcels();
  const effectiveCarriedCount = Number.isFinite(carriedCountArg) ? carriedCountArg : carryingCount();
  const missionAvoidTiles = policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? avoidTiles;
  const hardThreshold = hardAvoidThreshold(policy);
  const candidates = [];
  const deliveryTarget = bestDeliveryTarget(policy, carried);

  for (const p of W.parcelList ?? []) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (parcelShouldBeAvoided(p, policy, { carriedCount: effectiveCarriedCount, isOpportunistic: false, allowZeroReward: false })) continue;
    if (isHardAvoidTile(p, missionAvoidTiles, hardThreshold)) continue;
    if (deliveryTarget && !parcelMeetsDeliveryValueRuleAtTarget(p, deliveryTarget, policy)) continue;
    const reward = hasScoreBasedMissionConstraint(policy) ? effectiveParcelReward(p, policy) : Number(p.reward ?? 0);
    const mDist = manhattan(W.me.x, W.me.y, p.x, p.y);
    if (!crateMap && decayUnits(mDist) > reward) continue;
    candidates.push({ parcel: p, u: utility(p, hasScoreBasedMissionConstraint(policy) ? policy : null, deliveryTarget), mDist });
  }

  candidates.sort((a, b) => (b.u !== a.u ? b.u - a.u : a.mDist - b.mDist));
  const limit = crateMap ? (CFG.PARCEL_CANDIDATE_LIMIT_CRATE ?? 10) : (CFG.PARCEL_CANDIDATE_LIMIT ?? 14);
  let best = null, bestScore = -Infinity;
  for (const c of candidates.slice(0, limit)) {
    const path = planPathToTarget(c.parcel, { avoidTiles: missionAvoidTiles });
    const baseScore = parcelReachabilityScore(c.parcel, path, hasScoreBasedMissionConstraint(policy) ? policy : null, deliveryTarget);
    const tilePenalty = softAvoidPenaltyAt(c.parcel, missionAvoidTiles, hardThreshold);
    const score = tilePenalty === Infinity ? -Infinity : baseScore - tilePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = c.parcel;
    }
  }
  return best;
}

function bestAdjacentParcel(avoidTiles = [], mission = null, carriedCountArg = null) {
  const policy = normalizeMissionPolicy(mission);
  const hasMission = hasRealMissionConstraint(policy);
  if (!hasMission) {
    const carried = carriedParcels();
    const deliveryTarget = bestDeliveryTargetBaseline();
    let best = null, bestReward = -Infinity;
    for (const p of W.parcelList) {
      if (p.carriedBy) continue;
      if (isGoalBlacklisted(p)) continue;
      if (manhattan(W.me.x, W.me.y, p.x, p.y) !== 1) continue;
      // adjacent parcels still need to pay for delivery and detour cost
      const projected = deliveryTarget ? projectedRewardAtDelivery(p, deliveryTarget) : Number(p.reward ?? 0);
      const detourCost = carriedDetourCost(carried, p, deliveryTarget);
      const netGain = projected - detourCost;
      if (netGain <= 0) continue;
      if (netGain > bestReward) {
        bestReward = netGain;
        best = p;
      }
    }
    return best;
  }

  const carried = carriedParcels();
  const effectiveCarriedCount = Number.isFinite(carriedCountArg) ? carriedCountArg : carryingCount();
  const deliveryTarget = bestDeliveryTarget(policy, carried);
  let best = null, bestReward = -Infinity;
  for (const p of W.parcelList ?? []) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (manhattan(W.me.x, W.me.y, p.x, p.y) !== 1) continue;
    if (parcelShouldBeAvoided(p, policy, { carriedCount: effectiveCarriedCount, isOpportunistic: true, allowZeroReward: false })) continue;
    if (deliveryTarget && !parcelMeetsDeliveryValueRuleAtTarget(p, deliveryTarget, policy)) continue;
    const projected = hasScoreBasedMissionConstraint(policy)
      ? effectiveParcelReward(p, policy)
      : (deliveryTarget ? projectedRewardAtDelivery(p, deliveryTarget) : Number(p.reward ?? 0));
    const detourCost = carriedDetourCost(carried, p, deliveryTarget);
    const netGain = projected - detourCost;
    if (netGain <= 0) continue;
    if (netGain > bestReward) {
      bestReward = netGain;
      best = p;
    }
  }
  return best;
}

function bestAllowedMissionParcelFallback(policy, avoidTiles = [], carriedCountArg = 0) {
  let best = null;
  let bestReward = -Infinity;
  const hardThreshold = hardAvoidThreshold(policy);
  for (const p of W.parcelList ?? []) {
    if (!p || p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (isHardAvoidTile(p, avoidTiles, hardThreshold)) continue;
    const reward = hasScoreBasedMissionConstraint(policy) ? effectiveParcelReward(p, policy) : Number(p.reward ?? 0);
    if (!(reward > 0)) continue;
    if (Number.isFinite(policy?.pickup?.maxCarry) && carriedCountArg >= policy.pickup.maxCarry) continue;
    if (Number.isFinite(policy?.pickup?.exactCarry) && carriedCountArg >= policy.pickup.exactCarry) continue;
    if (Number.isFinite(policy?.pickup?.minParcelScore) && reward <= policy.pickup.minParcelScore) continue;
    if (Number.isFinite(policy?.pickup?.maxParcelScore) && reward > policy.pickup.maxParcelScore) continue;
    if (reward > bestReward) {
      bestReward = reward;
      best = p;
    }
  }
  return best;
}

export function bestNearbyParcel(avoidTiles = [], carriedCountArg = 0, maxDist = NEAR_PARCEL_DIST, mission = null) {
  const policy = normalizeMissionPolicy(mission);
  const hasMission = hasRealMissionConstraint(policy);

  if (!hasMission) {
    const carried = carriedParcels();
    const deliveryTarget = bestDeliveryTargetBaseline();
    let best = null, bestScore = -Infinity;
    for (const p of W.parcelList) {
      if (!p || p.carriedBy) continue;
      if (isGoalBlacklisted(p)) continue;
      if (isHardAvoidTile(p, avoidTiles)) continue;
      const d = Math.abs(W.me.x - p.x) + Math.abs(W.me.y - p.y);
      if (d === 0 || d > maxDist) continue;
      const path = planPathToTarget(p, { avoidTiles });
      if (!path || path.length > maxDist) continue;
      // account for both the trip to delivery and what the detour costs
      // everything already carried, or it'll grab a net-loss parcel just
      // because it was closest
      const projected = deliveryTarget ? projectedRewardAtDelivery(p, deliveryTarget) : Number(p.reward ?? 0);
      const detourCost = carriedDetourCost(carried, p, deliveryTarget);
      const netGain = projected - detourCost;
      if (netGain <= 0) continue;
      const tilePenalty = softAvoidPenaltyAt(p, avoidTiles);
      if (tilePenalty === Infinity) continue;
      const score = netGain * 10 - path.length - tilePenalty;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  const missionAvoidTiles = policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? avoidTiles;
  const hardThreshold = hardAvoidThreshold(policy);
  const carried = carriedParcels();
  const deliveryTarget = bestDeliveryTarget(policy, carried);
  let best = null, bestScore = -Infinity;
  for (const p of W.parcelList ?? []) {
    if (!p || p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (parcelShouldBeAvoided(p, policy, { carriedCount: carriedCountArg, isOpportunistic: true, allowZeroReward: false })) continue;
    if (isHardAvoidTile(p, missionAvoidTiles, hardThreshold)) continue;
    if (deliveryTarget && !parcelMeetsDeliveryValueRuleAtTarget(p, deliveryTarget, policy)) continue;
    const d = Math.abs(W.me.x - p.x) + Math.abs(W.me.y - p.y);
    if (d === 0 || d > maxDist) continue;
    const path = planPathToTarget(p, { avoidTiles: missionAvoidTiles });
    if (!path || path.length > maxDist) continue;
    const projected = deliveryTarget ? projectedRewardAtDelivery(p, deliveryTarget) : Number(p.reward ?? 0);
    const detourCost = carriedDetourCost(carried, p, deliveryTarget);
    const netGain = projected - detourCost;
    if (netGain <= 0) continue;
    const tilePenalty = softAvoidPenaltyAt(p, missionAvoidTiles, hardThreshold);
    if (tilePenalty === Infinity) continue;
    const score = netGain * 10 - path.length - tilePenalty;
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
  if (Number.isFinite(opts.maxExpansions)) pathPolicy.maxExpansions = opts.maxExpansions;

  if (opts.exact) {
    // exact, one-way-aware pathing (see astar.js) instead of A*'s usual
    // Manhattan-distance heuristic - guaranteed correct regardless of any
    // one-way detour required, at the cost of a full BFS instead of A*'s
    // normal quick win. reserved for rare, high-stakes queries (a
    // coordination/handoff target), not routine per-tick delivery/pickup
    // pathing, where that cost isn't worth paying every tick
    return planExactPathToTarget(W.me.x, W.me.y, target.x, target.y, pathPolicy);
  }

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
  for (const s of W.spawnTiles ?? []) {
    const dist = Math.max(Math.abs(W.me.x - s.x), Math.abs(W.me.y - s.y));
    // visited means seen; pickup value is decided elsewhere
    if (dist <= VISION_RADIUS) {
      visitedSpawns.set(`${s.x},${s.y}`, now);
    }
  }
}

// picks one stable per-cluster target: staleness minus 2x distance, so it
// favors clusters that are stale but still close. minUnseenSeconds is the
// staleness floor a cluster has to clear to even be considered
function bestSpawnClusterTarget(minUnseenSeconds) {
  if (!W.spawnAreas || W.spawnAreas.length === 0) return null;
  const now = Date.now();
  let bestTarget = null, bestClusterScore = -Infinity;
  for (const cluster of W.spawnAreas) {
    const candidateTiles = [];
    let maxTimeUnseen = 0;
    for (const t of cluster) {
      if (isGoalBlacklisted(t)) continue;
      const lastSeen = visitedSpawns.get(`${t.x},${t.y}`) || 0;
      const timeUnseenSeconds = (now - lastSeen) / 1000;
      if (timeUnseenSeconds >= minUnseenSeconds) {
        candidateTiles.push(t);
        if (timeUnseenSeconds > maxTimeUnseen) maxTimeUnseen = timeUnseenSeconds;
      }
    }
    if (candidateTiles.length === 0) continue;
    let closestUnseen = null, minDist = Infinity;
    for (const t of candidateTiles) {
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
  return bestTarget;
}

export function getOldestUnseenSpawn() {
  const bestTarget = bestSpawnClusterTarget(15);
  if (bestTarget) currentSpawnPatrolTarget = bestTarget;
  return bestTarget;
}

// single source of truth for "where to patrol/idle toward" - a stable,
// cluster-scored target instead of nearest-tile, which flip-flops and makes
// needNewPlan fire every tick. falls back to the best cluster even under the
// 15s staleness bar so idle time is spent moving, not drifting with
// fallbackMove(null)
export function nextSpawnPatrolTarget() {
  updateVisibleSpawns();
  // keep a committed patrol target until reached or blacklisted
  if (currentSpawnPatrolTarget && !isGoalBlacklisted(currentSpawnPatrolTarget)) {
    return currentSpawnPatrolTarget;
  }
  const target = getOldestUnseenSpawn() ?? bestSpawnClusterTarget(0);
  if (target) currentSpawnPatrolTarget = target;
  return target;
}

export function completeSpawnPatrol() {
  if (currentSpawnPatrolTarget) {
    visitedSpawns.set(`${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`, Date.now());
  }
  currentSpawnPatrolTarget = null;
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
  return manhattan(W.me.x, W.me.y, target.x, target.y) <= Math.max(0, Number(radius ?? 0));
}

function bestMoveToMissionTarget(target, radius = 0, avoidTiles = []) {
  if (!target || isGoalBlacklisted(target)) return null;
  if (nearTarget(target, radius)) return { x: target.x, y: target.y };
  const direct = planPathToTarget(target, { avoidTiles });
  if (direct !== null) return { x: target.x, y: target.y };
  const avoidRules = normalizeAvoidRules(avoidTiles);
  const pathPolicy = buildPathPolicy(avoidRules, target);
  const approach = bestKnownApproachTile(target.x, target.y, pathPolicy);
  return approach ? { x: approach.x, y: approach.y } : null;
}

function shouldDoTrafficLightWait(policy) {
  if (!policy?.wait?.trafficLight) return false;
  return inTrafficLightStopState({ trafficLight: policy.wait.trafficLight });
}

function bestCoordinationTarget(policy, avoidTiles = []) {
  const meet = policy?.movement?.meetTarget;
  const radius = Number(policy?.movement?.meetRadius ?? 3);
  if (meet && !isGoalBlacklisted(meet)) return bestMoveToMissionTarget(meet, radius, avoidTiles);
  const moveTo = policy?.movement?.moveTo;
  if (moveTo && !isGoalBlacklisted(moveTo)) return bestMoveToMissionTarget(moveTo, 0, avoidTiles);
  return null;
}

function dropRuleTiles(policy) {
  const rule = policy?.meta?.dropRule;
  const explicit = rule?.targetTiles;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;

  const region = String(rule?.region ?? "").trim().toLowerCase();
  const deliveryTiles = Array.isArray(W.deliveryTiles) ? W.deliveryTiles : [];
  if (!region || deliveryTiles.length === 0) return [];

  if (region.includes("leftmost") || region.includes("left-most")) {
    const minX = Math.min(...deliveryTiles.map((t) => Number(t.x)));
    return deliveryTiles.filter((t) => Number(t.x) === minX);
  }

  if (region.includes("rightmost") || region.includes("right-most")) {
    const maxX = Math.max(...deliveryTiles.map((t) => Number(t.x)));
    return deliveryTiles.filter((t) => Number(t.x) === maxX);
  }

  return [];
}


// identity of the required drop_rule tile, independent of reachability
export function dropRuleTarget(policy) {
  const tiles = dropRuleTiles(policy);
  if (!Array.isArray(tiles) || tiles.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const t of tiles) {
    const x = Number(t?.x);
    const y = Number(t?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = manhattan(W.me.x, W.me.y, x, y);
    if (d < bestDist) {
      bestDist = d;
      best = { x, y };
    }
  }
  return best;
}

// where to actually step toward the drop_rule target this tick: the exact
// tile once it's known and pathable, otherwise the closest currently-known
// walkable tile in its direction - the same "get as close as the explored
// map allows and discover the rest along the way" fallback already used for
// coordination targets (see bestMoveToMissionTarget/bestKnownApproachTile),
// so an unexplored drop tile still pulls the agent toward it tick over tick
// instead of being invisible to movement planning until it happens to be
// seen by chance
export function dropRuleMoveTarget(policy) {
  const target = dropRuleTarget(policy);
  if (!target) return null;
  if (samePos(W.me, target)) return target;
  const avoidTiles = policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? [];
  const direct = planPathToTarget(target, { avoidTiles });
  if (direct !== null) return target;
  const avoidRules = normalizeAvoidRules(avoidTiles);
  const pathPolicy = buildPathPolicy(avoidRules, target);
  const approach = bestKnownApproachTile(target.x, target.y, pathPolicy);
  return approach ? { x: approach.x, y: approach.y } : null;
}

// once handoff_bonus already has a parcel to hand off, opportunistic
// pickup would just delay the attempt for no benefit - see the matching
// check in deliberate()'s effectiveLimit computation
function blockedByHandoffFocus(policy, currentCarried) {
  return !!(policy?.meta?.handoffBonus && currentCarried >= 1);
}

export function hasOpportunisticNearbyParcel(mission = null) {
  const policy = normalizeMissionPolicy(mission);
  const currentCarried = carryingCount();
  if (currentCarried >= HARD_CARRY_LIMIT) return false;
  if (blockedByHandoffFocus(policy, currentCarried)) return false;
  const avoidTiles = hasRealMissionConstraint(policy) ? (policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? []) : [];
  return !!bestNearbyParcel(avoidTiles, currentCarried, NEAR_PARCEL_DIST, mission);
}

export function bestOpportunisticNearbyParcel(mission = null) {
  const policy = normalizeMissionPolicy(mission);
  const currentCarried = carryingCount();
  if (blockedByHandoffFocus(policy, currentCarried)) return null;
  const avoidTiles = hasRealMissionConstraint(policy) ? (policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? []) : [];
  return bestNearbyParcel(avoidTiles, currentCarried, NEAR_PARCEL_DIST, mission);
}

export function isMissionBlockingBaseline(mission = null) {
  const policy = normalizeMissionPolicy(mission);
  return hasRealMissionConstraint(policy);
}

function utilityBaseline(parcel) {
  const distToParcel = manhattan(W.me.x, W.me.y, parcel.x, parcel.y);
  const dz = nearestDeliveryFrom(parcel.x, parcel.y);
  const distToDelivery = dz ? manhattan(parcel.x, parcel.y, dz.x, dz.y) : 0;
  return Math.pow(Number(parcel.reward ?? 0), CFG.DECAY_WEIGHT ?? 1) / (1 + distToParcel + 0.35 * distToDelivery);
}

function bestAdjacentParcelBaseline() {
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

export function bestParcelBaseline(avoidTiles = []) {
  return bestParcel(avoidTiles, null, null);
}

export function bestNearbyParcelBaseline(avoidTiles = [], carriedCount = 0, maxDist = NEAR_PARCEL_DIST) {
  return bestNearbyParcel(avoidTiles, carriedCount, maxDist, null);
}

export function hasOpportunisticNearbyParcelBaseline(hint = null) {
  const carriedCount = carryingCount();
  if (carriedCount >= HARD_CARRY_LIMIT) return false;
  return !!bestNearbyParcelBaseline(hint?.avoidTiles ?? [], carriedCount, NEAR_PARCEL_DIST);
}

export function bestOpportunisticNearbyParcelBaseline(hint = null) {
  const carriedCount = carryingCount();
  return bestNearbyParcelBaseline(hint?.avoidTiles ?? [], carriedCount, NEAR_PARCEL_DIST);
}

export async function deliberateBaseline(hint = null) {
  updateVisibleSpawns();
  const avoidTiles = hint?.avoidTiles ?? [];
  const carried = carriedParcels();
  const carriedCount = carryingCount();
  const total = carried.reduce((s, p) => s + Number(p.reward ?? 0), 0);
  const softLimit = W.strategy?.carryTarget ?? 2;
  const mapArea = (W.mapWidth ?? 0) * (W.mapHeight ?? 0);
  const isLargeMap = mapArea >= 400;
  const effectiveLimit = isLargeMap ? Math.min(softLimit, 2) : softLimit;
  const deliveryTarget = bestDeliveryTargetBaseline();

  if (!carriedCount) forcedDeliveryTarget = null;
  if (hint?.mode === "WAIT") return { type: "WAIT", target: null };

  if (hint?.moveTo && !isGoalBlacklisted(hint.moveTo)) {
    const meetRadius = Number(hint?.meetRadius ?? 0);
    if (manhattan(W.me.x, W.me.y, hint.moveTo.x, hint.moveTo.y) > meetRadius) return { type: "MOVE", target: hint.moveTo };
    return { type: "WAIT", target: null };
  }

  // a genuinely worthwhile parcel one tile away is worth a quick detour even
  // mid-delivery - bestAdjacentParcelBaseline() already prices in what the
  // detour costs the rest of the carried batch, so this never overrides a
  // delivery that's actually more valuable. checked before the delivery
  // branches below, which otherwise return early every time the agent is
  // already carrying something - and unlike a parcel underfoot (handled
  // reactively regardless of what this returns), a one-tile-away parcel is
  // only ever picked up here, so skipping this check meant walking right
  // past it
  if (carriedCount < HARD_CARRY_LIMIT) {
    const adjacentParcel = bestAdjacentParcelBaseline();
    if (adjacentParcel) return { type: "PICKUP", target: adjacentParcel };
  }

  if (carriedCount > 0 && forcedDeliveryTarget) {
    if (validGoal(forcedDeliveryTarget)) {
      if (!isGoalBlacklisted(forcedDeliveryTarget)) {
        forcedDeliveryBlacklistWaits = 0;
        return { type: "DELIVER", target: forcedDeliveryTarget };
      }
      // same reasoning as the equivalent check in deliberate(): a brief
      // (~1.5s) blacklist usually just means transient contention, not a
      // dead end - wait it out rather than jumping to a farther tile
      if (forcedDeliveryBlacklistWaits < 3) {
        forcedDeliveryBlacklistWaits += 1;
        return { type: "WAIT", target: null, source: "delivery-target-contested" };
      }
    }
    forcedDeliveryTarget = null;
    forcedDeliveryBlacklistWaits = 0;
  }

  if (carriedCount > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    const d = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);
    const hardDeliver = d <= 1 || total >= 80 || carriedCount === W.parcelList.length || carriedCount >= effectiveLimit;
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

  if (carriedCount === 0) {
    const nearbyParcel = bestNearbyParcelBaseline(avoidTiles, carriedCount, NEAR_PARCEL_DIST);
    if (nearbyParcel) return { type: "PICKUP", target: nearbyParcel };
  }

  if (carriedCount < effectiveLimit) {
    const p = bestParcelBaseline(avoidTiles);
    if (p) return { type: "PICKUP", target: p };
  }

  if (carriedCount > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
    return { type: "DELIVER", target: deliveryTarget };
  }

  if (W.spawnTiles.length > 0) {
    const patrol = nextSpawnPatrolTarget();
    if (patrol && !isHardAvoidTile(patrol, avoidTiles)) return { type: "PATROL", target: patrol };
  }

  const frontiers = frontierTiles();
  if (frontiers.length > 0) {
    if (currentExploreTarget && samePos(W.me, currentExploreTarget)) currentExploreTarget = null;
    if (currentExploreTarget && !isGoalBlacklisted(currentExploreTarget)) {
      const stillValid = frontiers.some((f) => f.x === currentExploreTarget.x && f.y === currentExploreTarget.y && !isHardAvoidTile(f, avoidTiles));
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
  const idleSpawnTarget = nextSpawnPatrolTarget();
  if (idleSpawnTarget && !isHardAvoidTile(idleSpawnTarget, avoidTiles)) return { type: "PATROL", target: idleSpawnTarget };
  return { type: "EXPLORE", target: null };
}

export async function deliberate(mission = null) {
  updateVisibleSpawns();
  const policy = normalizeMissionPolicy(mission);
  const hasMission = hasRealMissionConstraint(policy);
  const avoidTiles = hasMission ? (policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? []) : [];
  const hardThreshold = hardAvoidThreshold(policy);
  const carried = carriedParcels();
  const carriedCountNow = carryingCount();
  const total = carried.reduce((s, p) => s + Number(p.reward ?? 0), 0);
  const mapArea = (W.mapWidth ?? 0) * (W.mapHeight ?? 0);
  const isLargeMap = mapArea >= 400;
  const requestedExactCount = policy?.delivery?.exactCount;
  const cappedExactCount = Number.isFinite(requestedExactCount) ? Math.min(Number(requestedExactCount), HARD_CARRY_LIMIT) : null;
  const requestedMaxCount = policy?.delivery?.maxCount;
  const cappedMaxCount = Number.isFinite(requestedMaxCount) ? Math.min(Number(requestedMaxCount), HARD_CARRY_LIMIT) : null;
  const baseSoftLimit = W.strategy?.carryTarget ?? 2;
  // "only deliver with a total score of at least N" has no count cap at all -
  // don't let the map's unrelated carryTarget heuristic stop it from still
  // seeking parcels toward that value just because it's holding a few
  // low-value ones already
  const stillNeedsTotalScore =
    Number.isFinite(policy?.delivery?.minTotalScore) && total < policy.delivery.minTotalScore;
  // once handoff_bonus has a parcel worth handing off, stop seeking more -
  // sitting at exactly 1 carried parcel is what makes it handoff-eligible in
  // the first place (executeHandoffDrop requires exactly one), so batching a
  // 2nd/3rd on top just delays the attempt without any compensating benefit.
  // applies from carry=0 too, not just once already carrying one - otherwise
  // every fresh pickup cycle after a delivery still free-for-alls up to the
  // normal soft limit before the cap ever kicks in, which is what let B run
  // off on ordinary multi-parcel delivery loops instead of engaging with an
  // already-active handoff mission. only a soft default, never overrides an
  // explicit count mission
  const handoffFocusLimit = policy?.meta?.handoffBonus ? 1 : null;
  const effectiveLimit = hasMission
    ? (Number.isFinite(cappedExactCount)
        ? cappedExactCount
        : (Number.isFinite(cappedMaxCount)
            ? cappedMaxCount
            : (stillNeedsTotalScore
                ? HARD_CARRY_LIMIT
                : (Number.isFinite(handoffFocusLimit)
                    ? handoffFocusLimit
                    : (isLargeMap ? Math.min(baseSoftLimit, 2) : baseSoftLimit)))))
    : (isLargeMap ? Math.min(baseSoftLimit, 2) : baseSoftLimit);
  const effectivePolicy = Number.isFinite(cappedExactCount)
    ? {
        ...policy,
        delivery: { ...policy.delivery, exactCount: cappedExactCount },
        pickup: {
          ...policy.pickup,
          minCarry: Number(policy?.pickup?.minCarry ?? cappedExactCount),
          maxCarry: Math.min(Number(policy?.pickup?.maxCarry ?? cappedExactCount), cappedExactCount),
        },
      }
    : policy;
  const deliveryTarget = bestDeliveryTarget(effectivePolicy, carried);

  if (!carriedCountNow) forcedDeliveryTarget = null;

  if (hasMission) {
    if (policy?.wait?.mustWait) return { type: "WAIT", target: null };
    if (shouldDoTrafficLightWait(policy)) return { type: "WAIT", target: null };

    const dropTarget = dropRuleTarget(policy);
    if (dropTarget && carriedCountNow > 0) {
      if (samePos(W.me, dropTarget)) return { type: "DELIVER", target: dropTarget };
      const dropMoveTarget = dropRuleMoveTarget(policy);
      if (dropMoveTarget) return { type: "MOVE", target: dropMoveTarget };
      // nothing known yet anywhere in the target's direction (only possible
      // very early, before any nearby tile has been explored) - fall
      // through to the rest of the mission logic below instead of stalling
      // on a MOVE with nowhere to go
    }

    const coordinationTarget = bestCoordinationTarget(policy, avoidTiles);
    if (coordinationTarget) {
      if (!nearTarget(coordinationTarget, policy?.movement?.meetRadius ?? 0)) return { type: "MOVE", target: coordinationTarget };
      return { type: "WAIT", target: null };
    }
  }

  if (carriedCountNow > 0 && forcedDeliveryTarget) {
    if (validGoal(forcedDeliveryTarget)) {
      if (!isGoalBlacklisted(forcedDeliveryTarget)) {
        forcedDeliveryBlacklistWaits = 0;
        return { type: "DELIVER", target: forcedDeliveryTarget };
      }
      // the committed delivery tile just got blacklisted - mainLoop.js only
      // does this for ~1.5s (transient contention, not a dead end), and
      // re-optimizing now can jump to a much farther tile just because it's
      // the only other option. retry the same target once it clears, but
      // not forever - that'd mean genuinely sustained contention
      if (forcedDeliveryBlacklistWaits < 3) {
        forcedDeliveryBlacklistWaits += 1;
        return { type: "WAIT", target: null, source: "delivery-target-contested" };
      }
    }
    forcedDeliveryTarget = null;
    forcedDeliveryBlacklistWaits = 0;
  }

  if (hasMission) {
    const missionReadyToDeliver = deliveryMustHappenNow(effectivePolicy, { carriedCount: carriedCountNow });
    const missionRequiresMorePickup = missionNeedsMorePickup(effectivePolicy, { carriedCount: carriedCountNow });
    const pickupMinCarry = Number.isFinite(effectivePolicy?.pickup?.minCarry) ? Number(effectivePolicy.pickup.minCarry) : null;
    const buildingExactDeliveryCount = Number.isFinite(cappedExactCount) && carriedCountNow < cappedExactCount;
    const preferredCarryTarget = deliveryPreferredCarryTarget(effectivePolicy);
    const buildingPreferredCarryTarget =
      !missionRequiresMorePickup &&
      Number.isFinite(preferredCarryTarget) &&
      carriedCountNow > 0 &&
      carriedCountNow < preferredCarryTarget;
    const buildingMinCarryTarget = Number.isFinite(pickupMinCarry) && carriedCountNow < pickupMinCarry;

    if (missionReadyToDeliver && carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
      forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
      return { type: "DELIVER", target: deliveryTarget };
    }

    const stillBuildingMissionCarry =
      buildingExactDeliveryCount ||
      buildingMinCarryTarget ||
      missionRequiresMorePickup;

    if (buildingPreferredCarryTarget && carriedCountNow < effectiveLimit) {
      const preferredAdjacent = bestAdjacentParcel(avoidTiles, effectivePolicy, carriedCountNow);
      if (preferredAdjacent) return { type: "PICKUP", target: preferredAdjacent };

      const preferredNearby = bestNearbyParcel(avoidTiles, carriedCountNow, NEAR_PARCEL_DIST, effectivePolicy);
      if (preferredNearby) return { type: "PICKUP", target: preferredNearby };
    }

    if (!stillBuildingMissionCarry && deliveryAllowed(effectivePolicy, { carriedCount: carriedCountNow }) && carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
      const d = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);
      const hardDeliver = d <= 1 || total >= 80 || carriedCountNow === W.parcelList.length || carriedCountNow >= effectiveLimit;
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

    if (stillBuildingMissionCarry && carriedCountNow < effectiveLimit) {
      const exactAdjacent = bestAdjacentParcel(avoidTiles, effectivePolicy, carriedCountNow);
      if (exactAdjacent) return { type: "PICKUP", target: exactAdjacent };

      const exactNearby = bestNearbyParcel(avoidTiles, carriedCountNow, NEAR_PARCEL_DIST, effectivePolicy);
      if (exactNearby) return { type: "PICKUP", target: exactNearby };

      const exactBest = bestParcel(avoidTiles, effectivePolicy, carriedCountNow);
      if (exactBest) return { type: "PICKUP", target: exactBest };

      const fallbackParcel = bestAllowedMissionParcelFallback(effectivePolicy, avoidTiles, carriedCountNow);
      if (fallbackParcel) return { type: "PICKUP", target: fallbackParcel };

      if (countOnlyDeliveryMission(effectivePolicy)) {
        const adjacentBaseline = bestAdjacentParcel([], null, carriedCountNow);
        if (adjacentBaseline) return { type: "PICKUP", target: adjacentBaseline };

        const nearbyBaseline = bestNearbyParcel([], carriedCountNow, NEAR_PARCEL_DIST, null);
        if (nearbyBaseline) return { type: "PICKUP", target: nearbyBaseline };

        const bestBaseline = bestParcel([], null, carriedCountNow);
        if (bestBaseline) return { type: "PICKUP", target: bestBaseline };
      }

      if (carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
        forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
        return { type: "DELIVER", target: deliveryTarget };
      }

      // still need more (count or total-score) but nothing pickable is
      // visible - a null target here hits the same fallbackMove(null)
      // drift-to-the-edge issue as the terminal EXPLORE fallback, so head
      // toward the best spawn cluster instead
      const idleSpawnTargetWhileBuilding = nextSpawnPatrolTarget();
      if (idleSpawnTargetWhileBuilding && !isHardAvoidTile(idleSpawnTargetWhileBuilding, avoidTiles, hardThreshold)) {
        return { type: "PATROL", target: idleSpawnTargetWhileBuilding };
      }
      return countOnlyDeliveryMission(effectivePolicy)
        ? { type: "EXPLORE", target: null }
        : { type: "WAIT", target: null };
    }

    const adjacentMissionParcel = bestAdjacentParcel(avoidTiles, effectivePolicy, carriedCountNow);
    if (adjacentMissionParcel && carriedCountNow < HARD_CARRY_LIMIT && !missionReadyToDeliver) return { type: "PICKUP", target: adjacentMissionParcel };

    const allowNearbyMission = isLargeMap ? true : carriedCountNow === 0 || !missionReadyToDeliver;
    if (allowNearbyMission && carriedCountNow < HARD_CARRY_LIMIT) {
      const nearbyMissionParcel = bestNearbyParcel(avoidTiles, carriedCountNow, NEAR_PARCEL_DIST, effectivePolicy);
      if (nearbyMissionParcel) return { type: "PICKUP", target: nearbyMissionParcel };
    }

    if ((missionRequiresMorePickup || buildingMinCarryTarget) && carriedCountNow < effectiveLimit) {
      const missionBestParcel = bestParcel(avoidTiles, effectivePolicy, carriedCountNow);
      if (missionBestParcel && carriedCountNow < HARD_CARRY_LIMIT) return { type: "PICKUP", target: missionBestParcel };
    }

    if (carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
      forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
      return { type: "DELIVER", target: deliveryTarget };
    }
  }

  if (carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    const d = manhattan(W.me.x, W.me.y, deliveryTarget.x, deliveryTarget.y);
    const hardDeliver = d <= 1 || total >= 80 || carriedCountNow === W.parcelList.length || carriedCountNow >= effectiveLimit;
    if (hardDeliver) {
      forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
      return { type: "DELIVER", target: deliveryTarget };
    }
    const rewardOk = total >= (CFG.DELIVER_REWARD_THRESHOLD ?? 10);
    const distOk = isLargeMap ? true : d <= (CFG.DELIVER_DIST_THRESHOLD ?? 10);
    if (rewardOk && distOk) {
      const path = planPathToTarget(deliveryTarget, { avoidTiles: [] });
      if (path && path.length > 0) {
        forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
        return { type: "DELIVER", target: deliveryTarget };
      }
    }
  }

  const adjacentParcel = bestAdjacentParcel([], null, carriedCountNow);
  if (adjacentParcel && carriedCountNow < HARD_CARRY_LIMIT) return { type: "PICKUP", target: adjacentParcel };

  if (carriedCountNow === 0) {
    const nearbyParcel = bestNearbyParcel([], carriedCountNow, NEAR_PARCEL_DIST, null);
    if (nearbyParcel) return { type: "PICKUP", target: nearbyParcel };
  }

  if (carriedCountNow < effectiveLimit) {
    const p = bestParcel([], null, carriedCountNow);
    if (p) return { type: "PICKUP", target: p };
  }

  if (carriedCountNow > 0 && deliveryTarget && !isGoalBlacklisted(deliveryTarget)) {
    forcedDeliveryTarget = { x: deliveryTarget.x, y: deliveryTarget.y };
    return { type: "DELIVER", target: deliveryTarget };
  }

  if (W.spawnTiles.length > 0) {
    const patrol = nextSpawnPatrolTarget();
    if (patrol && !isHardAvoidTile(patrol, avoidTiles, hardThreshold)) return { type: "PATROL", target: patrol };
  }

  const frontiers = frontierTiles();
  if (frontiers.length > 0) {
    if (currentExploreTarget && samePos(W.me, currentExploreTarget)) currentExploreTarget = null;
    if (currentExploreTarget && !isGoalBlacklisted(currentExploreTarget)) {
      const stillValid = frontiers.some((f) => f.x === currentExploreTarget.x && f.y === currentExploreTarget.y && !isHardAvoidTile(f, avoidTiles, hardThreshold));
      if (stillValid) return { type: "EXPLORE", target: currentExploreTarget };
    }
    let bestFrontier = null, closestDist = Infinity;
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
  const idleSpawnTarget = nextSpawnPatrolTarget();
  if (idleSpawnTarget && !isHardAvoidTile(idleSpawnTarget, avoidTiles, hardThreshold)) return { type: "PATROL", target: idleSpawnTarget };
  return { type: "EXPLORE", target: null };
}
