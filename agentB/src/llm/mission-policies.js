import { key } from "../utils/math.js";
import { carriedParcels } from "../world/helpers.js";

function normalizeTileList(list = []) {
  const out = [];
  const seen = new Set();
  const items = Array.isArray(list) ? list : (Array.isArray(list?.tiles) ? list.tiles : []);
  for (const t of items) {
    const x = Number(t?.x);
    const y = Number(t?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const k = key(x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, y });
  }
  return out;
}

function normalizeMultiplierList(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list ?? []) {
    const x = Number(item?.x);
    const y = Number(item?.y);
    const multiplier = Number(item?.multiplier);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(multiplier)) continue;
    const k = key(x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, y, multiplier });
  }
  return out;
}

function normalizeAvoidRules(list = []) {
  const items = Array.isArray(list) ? list : (Array.isArray(list?.tiles) ? list.tiles : []);
  const defaultPenalty = Number(list?.penalty ?? 0);
  return items
    .map((t) => ({
      x: Number(t?.x),
      y: Number(t?.y),
      penalty: Number(t?.penalty ?? defaultPenalty),
    }))
    .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
}

function buildAvoidData(avoidRules = [], hardThreshold = 50) {
  const blockedSet = new Set();
  const penaltyMap = new Map();
  for (const t of avoidRules) {
    const k = key(t.x, t.y);
    if (t.penalty >= hardThreshold) blockedSet.add(k);
    else if (t.penalty > 0) penaltyMap.set(k, t.penalty);
  }
  return { blockedSet, penaltyMap };
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return null;
}

function effectiveDeliveryRule(d = {}) {
  const exactCount = Number.isFinite(d.exactCount) ? Number(d.exactCount) : null;
  const minCount = Number.isFinite(d.minCount) ? Number(d.minCount) : null;
  const maxCount = Number.isFinite(d.maxCount) ? Number(d.maxCount) : null;
  const maxExclusiveCount = Number.isFinite(d.maxExclusiveCount) ? Number(d.maxExclusiveCount) : null;
  const minExclusiveCount = Number.isFinite(d.minExclusiveCount) ? Number(d.minExclusiveCount) : null;

  // normalize duplicate lower-bound encodings from the LLM
  const normalizedMaxExclusiveCount =
    Number.isFinite(minCount) &&
    Number.isFinite(maxExclusiveCount) &&
    maxExclusiveCount <= minCount
      ? null
      : maxExclusiveCount;
 
  return {
    exactCount,
    minCount,
    maxCount,
    minExclusiveCount,
    maxExclusiveCount: normalizedMaxExclusiveCount,
  };
}

function countSatisfiesDeliveryRule(d, carriedCount) {
  if (!Number.isFinite(carriedCount)) return false;
  const eff = effectiveDeliveryRule(d);
  // allow delivery once the exact count is reached, even if a rule arrived late
  if (Number.isFinite(eff.exactCount)) return carriedCount >= eff.exactCount;
  if (Number.isFinite(eff.minCount) && carriedCount < eff.minCount) return false;
  // maxCount limits future pickup; delivery remains allowed to avoid deadlock
  if (Number.isFinite(eff.minExclusiveCount) && carriedCount <= eff.minExclusiveCount) return false;
  if (Number.isFinite(eff.maxExclusiveCount) && carriedCount >= eff.maxExclusiveCount) return false;
  return true;
}

function countNeedsMorePickupBeforeDelivery(d, carriedCount) {
  if (!Number.isFinite(carriedCount)) return false;

  const eff = effectiveDeliveryRule(d);

  // exact-count goals prefer collecting more before delivery
  if (Number.isFinite(eff.exactCount)) {
    return carriedCount < eff.exactCount;
  }

  if (Number.isFinite(eff.minCount)) {
    return carriedCount < eff.minCount;
  }

  if (Number.isFinite(eff.minExclusiveCount)) {
    return carriedCount <= eff.minExclusiveCount;
  }

  return false;
}

function countAlreadyAtOrPastForcedDeliveryPoint(d, carriedCount) {
  if (!Number.isFinite(carriedCount)) return false;
  const eff = effectiveDeliveryRule(d);
  if (Number.isFinite(eff.exactCount)) return carriedCount >= eff.exactCount;
  if (Number.isFinite(eff.maxCount) && carriedCount >= eff.maxCount) return true;
  if (Number.isFinite(eff.maxExclusiveCount) && carriedCount >= eff.maxExclusiveCount - 1) return true;
  return false;
}

export function normalizeMissionPolicy(mission = null) {
  const raw = mission?.policy ?? mission ?? {};
  const avoidTilesRaw = raw.avoidTiles ?? raw.movement?.avoidTiles ?? [];
  const avoidRules = normalizeAvoidRules(avoidTilesRaw);
  const rawMoveTo = raw.moveTo?.target ?? raw.moveTo ?? raw.movement?.moveTo ?? null;

  const rawDelivery = {
    enabled: raw.avoidDelivery ? false : (raw.delivery?.enabled ?? true),
    exactCount: Number.isFinite(raw.exactDeliveryCount)
      ? raw.exactDeliveryCount
      : (Number.isFinite(raw.delivery?.exactCount) ? raw.delivery.exactCount : null),
    minCount: Number.isFinite(raw.minDeliveryCount)
      ? raw.minDeliveryCount
      : (Number.isFinite(raw.delivery?.minCount) ? raw.delivery.minCount : null),
    maxCount: Number.isFinite(raw.maxDeliveryCount)
      ? raw.maxDeliveryCount
      : (Number.isFinite(raw.delivery?.maxCount) ? raw.delivery.maxCount : null),
    minExclusiveCount: Number.isFinite(raw.minExclusiveDeliveryCount)
      ? raw.minExclusiveDeliveryCount
      : (Number.isFinite(raw.delivery?.minExclusiveCount) ? raw.delivery.minExclusiveCount : null),
    maxExclusiveCount: Number.isFinite(raw.maxExclusiveDeliveryCount)
      ? raw.maxExclusiveDeliveryCount
      : (Number.isFinite(raw.delivery?.maxExclusiveCount) ? raw.delivery.maxExclusiveCount : null),
  };
  const eff = effectiveDeliveryRule(rawDelivery);

  return {
    wait: {
      mustWait: raw.mode === "WAIT" || !!raw.wait?.enabled || false,
      until: Number.isFinite(raw.wait?.until) ? raw.wait.until : null,
      trafficLight: raw.trafficLight ?? raw.wait?.trafficLight ?? null,
    },

    pickup: {
      enabled: raw.avoidPickup ? false : (raw.pickup?.enabled ?? true),
      opportunisticOnly: !!raw.pickup?.opportunisticOnly,
      exactCarry: (Number.isFinite(raw.exactCarry) && Number(raw.exactCarry) > 0)
        ? Number(raw.exactCarry)
        : (Number.isFinite(raw.pickup?.exactCarry) && Number(raw.pickup.exactCarry) > 0 ? Number(raw.pickup.exactCarry) : null),
      // zero or negative values mean "unspecified"
      maxCarry: (Number.isFinite(raw.pickup?.maxCarry) && Number(raw.pickup.maxCarry) > 0)
        ? Number(raw.pickup.maxCarry)
        : (Number.isFinite(raw.maxCarry) && Number(raw.maxCarry) > 0)
          ? Number(raw.maxCarry)
        : (Number.isFinite(eff.maxCount) && Number(eff.maxCount) > 0 ? Number(eff.maxCount) : null),
      maxParcelScore: Number.isFinite(raw.pickup?.maxParcelScore)
        ? raw.pickup.maxParcelScore
        : (Number.isFinite(raw.delivery?.maxParcelScore) ? raw.delivery.maxParcelScore : null),
      minParcelScore: firstFinite(raw.minParcelScore, raw.minAllowedParcelScore, raw.delivery?.minParcelScore),
      forbiddenTiles: normalizeTileList(raw.pickup?.forbiddenTiles ?? []),
      preferredTiles: normalizeTileList(raw.pickup?.preferredTiles ?? []),
    },

    delivery: {
      enabled: rawDelivery.enabled,
      exactCount: eff.exactCount,
      minCount: eff.minCount,
      maxCount: eff.maxCount,
      minExclusiveCount: eff.minExclusiveCount,
      maxExclusiveCount: eff.maxExclusiveCount,
      minParcelScore: firstFinite(raw.minParcelScore, raw.minAllowedParcelScore, raw.delivery?.minParcelScore),
      maxParcelScore: Number.isFinite(raw.maxAllowedParcelScore)
        ? raw.maxAllowedParcelScore
        : (Number.isFinite(raw.delivery?.maxParcelScore) ? raw.delivery.maxParcelScore : null),
      // total-score constraints apply to the whole carried batch
      minTotalScore: Number.isFinite(raw.minAllowedTotalScore)
        ? raw.minAllowedTotalScore
        : (Number.isFinite(raw.delivery?.minTotalScore) ? raw.delivery.minTotalScore : null),
      maxTotalScore: Number.isFinite(raw.maxAllowedTotalScore)
        ? raw.maxAllowedTotalScore
        : (Number.isFinite(raw.delivery?.maxTotalScore) ? raw.delivery.maxTotalScore : null),
      preferredTiles: normalizeTileList(raw.preferredDeliveryTiles ?? raw.delivery?.preferredTiles ?? []),
      forbiddenTiles: normalizeTileList(raw.forbiddenDeliveryTiles ?? raw.delivery?.forbiddenTiles ?? []),
      zeroRewardTiles: normalizeTileList(raw.zeroRewardTiles ?? raw.zeroRewardDeliveryTiles ?? raw.delivery?.zeroRewardTiles ?? []),
      multipliers: normalizeMultiplierList(raw.deliveryMultipliers ?? raw.delivery?.multipliers ?? []),
    },

    movement: {
      moveTo: rawMoveTo,
      meetTarget: raw.meetTarget ?? null,
      meetRadius: Number.isFinite(raw.meetRadius) ? raw.meetRadius : null,
      meetRow: Number.isFinite(raw.meetRow) ? raw.meetRow : null,
      meetColumn: Number.isFinite(raw.meetColumn) ? raw.meetColumn : null,
      avoidTiles: normalizeTileList(avoidTilesRaw),
      avoidRules,
      avoidData: buildAvoidData(avoidRules),
      preferTiles: normalizeTileList(raw.movement?.preferTiles ?? []),
    },

    meta: {
      handoffBonus: raw.handoffBonus ?? null,
      dropRule: raw.dropRule ?? null,
      mode: raw.mode ?? null,
      missionId: raw.missionId ?? null,
      missionSignature: raw.missionSignature ?? null,
      blockingText: raw.blockingText ?? null,
    },
  };
}

export function pickupAllowed(policy, { carriedCount = 0, parcel = null, isOpportunistic = false } = {}) {
  const p = policy?.pickup;
  if (!p?.enabled) return false;
  if (Number.isFinite(p.maxCarry) && carriedCount >= p.maxCarry) return false;
  if (Number.isFinite(p.exactCarry) && carriedCount >= p.exactCarry) return false;

  // once the total is capped, extra pickups can only violate the mission
  const maxTotalScore = policy?.delivery?.maxTotalScore;
  if (Number.isFinite(maxTotalScore)) {
    const currentTotal = carriedParcels().reduce((s, cp) => s + Number(cp?.reward ?? 0), 0);
    if (currentTotal >= maxTotalScore) return false;
  }

  if (!Number.isFinite(p.maxCarry) && !Number.isFinite(p.exactCarry)) {
    const reward = Number(parcel?.reward ?? parcel?.score ?? 0);
    if (Number.isFinite(p.minParcelScore) && reward <= p.minParcelScore) return false;
    if (Number.isFinite(p.maxParcelScore) && reward > p.maxParcelScore) return false;
    if (p.opportunisticOnly && !isOpportunistic) return false;
  }

  return true;
}

export function deliveryAllowed(policy, { carriedCount = 0, parcelScore = null } = {}) {
  const d = policy?.delivery;
  if (!d?.enabled) return false;
  if (!countSatisfiesDeliveryRule(d, carriedCount)) return false;
  if (Number.isFinite(d.maxParcelScore) && Number.isFinite(parcelScore) && parcelScore > d.maxParcelScore) return false;
  return true;
}

export function deliveryRequiredCarryTarget(policy) {
  const p = policy?.pickup ?? {};
  const d = policy?.delivery ?? {};
  if (Number.isFinite(p.exactCarry) && p.exactCarry > 0) return p.exactCarry;
  if (Number.isFinite(d.exactCount) && d.exactCount > 0) return d.exactCount;
  if (Number.isFinite(d.minCount) && d.minCount > 0) return d.minCount;
  if (Number.isFinite(d.minExclusiveCount) && d.minExclusiveCount >= 0) return d.minExclusiveCount + 1;
  return null;
}

export function deliveryPreferredCarryTarget(policy) {
  const required = deliveryRequiredCarryTarget(policy);
  if (Number.isFinite(required)) return required;
  const d = policy?.delivery ?? {};
  if (Number.isFinite(d.maxCount) && d.maxCount > 0) return d.maxCount;
  if (Number.isFinite(d.maxExclusiveCount) && d.maxExclusiveCount > 1) return d.maxExclusiveCount - 1;
  return null;
}

export function deliveryMustHappenNow(policy, { carriedCount = 0 } = {}) {
  const d = policy?.delivery;
  if (!d?.enabled) return false;
  return countAlreadyAtOrPastForcedDeliveryPoint(d, carriedCount);
}

export function hasRestrictiveParcelRules(policy) {
  return (
    policy?.pickup?.enabled === false ||
    policy?.delivery?.enabled === false ||
    Number.isFinite(policy?.pickup?.exactCarry) ||
    Number.isFinite(policy?.pickup?.maxCarry) ||
    Number.isFinite(policy?.pickup?.maxParcelScore) ||
    Number.isFinite(policy?.delivery?.exactCount) ||
    Number.isFinite(policy?.delivery?.minCount) ||
    Number.isFinite(policy?.delivery?.maxCount) ||
    Number.isFinite(policy?.delivery?.minExclusiveCount) ||
    Number.isFinite(policy?.delivery?.maxExclusiveCount) ||
    Number.isFinite(policy?.delivery?.minParcelScore) ||
    Number.isFinite(policy?.delivery?.maxParcelScore) ||
    (policy?.delivery?.forbiddenTiles?.length ?? 0) > 0 ||
    (policy?.delivery?.preferredTiles?.length ?? 0) > 0 ||
    (policy?.delivery?.zeroRewardTiles?.length ?? 0) > 0 ||
    (policy?.delivery?.multipliers?.length ?? 0) > 0
  );
}

export function missionNeedsMorePickup(policy, { carriedCount = 0 } = {}) {
  const p = policy?.pickup;
  const d = policy?.delivery;
  if (p?.enabled && Number.isFinite(p.exactCarry)) return carriedCount < p.exactCarry;
  if (d?.enabled && countNeedsMorePickupBeforeDelivery(d, carriedCount)) return true;
  // wait until the carried batch satisfies a minimum total-score rule
  if (d?.enabled && Number.isFinite(d.minTotalScore)) {
    const total = carriedParcels().reduce((s, cp) => s + Number(cp?.reward ?? 0), 0);
    if (total < d.minTotalScore) return true;
  }
  return false;
}

