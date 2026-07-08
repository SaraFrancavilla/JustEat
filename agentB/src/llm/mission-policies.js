import { key } from "../utils/math.js";

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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
  // const exactCount = Number.isFinite(d.exactCount) ? d.exactCount : null;
  // const minCount = Number.isFinite(d.minCount) ? d.minCount : null;
  // const maxCountExplicit = Number.isFinite(d.maxCount) ? d.maxCount : null;
  // const maxExclusiveCount = Number.isFinite(d.maxExclusiveCount) ? d.maxExclusiveCount : null;
  // const minExclusiveCount = Number.isFinite(d.minExclusiveCount) ? d.minExclusiveCount : null;

  // const exactIsReallyMax = Number.isFinite(exactCount) && !Number.isFinite(minCount) && !Number.isFinite(maxCountExplicit);
  // const maxCount = Number.isFinite(maxCountExplicit) ? maxCountExplicit : (exactIsReallyMax ? exactCount : null);
  // const exactForValidation = exactIsReallyMax ? null : exactCount;

  const exactCount = Number.isFinite(d.exactCount) ? Number(d.exactCount) : null;
  const minCount = Number.isFinite(d.minCount) ? Number(d.minCount) : null;
  const maxCount = Number.isFinite(d.maxCount) ? Number(d.maxCount) : null;
  const maxExclusiveCount = Number.isFinite(d.maxExclusiveCount) ? Number(d.maxExclusiveCount) : null;
  const minExclusiveCount = Number.isFinite(d.minExclusiveCount) ? Number(d.minExclusiveCount) : null;
 
  return {
    // exactCount: exactForValidation,
    exactCount,
    minCount,
    maxCount,
    minExclusiveCount,
    maxExclusiveCount,
    // exactIsReallyMax,
  };
}

function countSatisfiesDeliveryRule(d, carriedCount) {
  if (!Number.isFinite(carriedCount)) return false;
  const eff = effectiveDeliveryRule(d);
  if (Number.isFinite(eff.exactCount)) return carriedCount === eff.exactCount;
  if (Number.isFinite(eff.minCount) && carriedCount < eff.minCount) return false;
  if (Number.isFinite(eff.maxCount) && carriedCount > eff.maxCount) return false;
  if (Number.isFinite(eff.minExclusiveCount) && carriedCount <= eff.minExclusiveCount) return false;
  if (Number.isFinite(eff.maxExclusiveCount) && carriedCount >= eff.maxExclusiveCount) return false;
  return true;
}

function countCanStillBecomeValidByPickingUp(d, carriedCount) {
  if (!Number.isFinite(carriedCount)) return false;

  const eff = effectiveDeliveryRule(d);

  // "exactly 3" è un obiettivo preferito, non un blocco assoluto.
  // Se ho meno di 3 pacchi, provo a raccoglierne altri.
  if (Number.isFinite(eff.exactCount)) {
    return carriedCount < eff.exactCount;
  }

  if (Number.isFinite(eff.minCount)) {
    return carriedCount < eff.minCount;
  }

  if (Number.isFinite(eff.minExclusiveCount)) {
    return carriedCount <= eff.minExclusiveCount;
  }

  if (Number.isFinite(eff.maxCount)) {
    return carriedCount < eff.maxCount;
  }

  if (Number.isFinite(eff.maxExclusiveCount)) {
    return carriedCount < eff.maxExclusiveCount - 1;
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
      // Treat zero or non-positive values as unspecified (null)
      maxCarry: (Number.isFinite(raw.pickup?.maxCarry) && Number(raw.pickup.maxCarry) > 0)
        ? Number(raw.pickup.maxCarry)
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
      preferredTiles: normalizeTileList(raw.preferredDeliveryTiles ?? raw.delivery?.preferredTiles ?? []),
      forbiddenTiles: normalizeTileList(raw.forbiddenDeliveryTiles ?? raw.delivery?.forbiddenTiles ?? []),
      zeroRewardTiles: normalizeTileList(raw.zeroRewardTiles ?? raw.zeroRewardDeliveryTiles ?? raw.delivery?.zeroRewardTiles ?? []),
      multipliers: normalizeMultiplierList(raw.deliveryMultipliers ?? raw.delivery?.multipliers ?? []),
    },

    movement: {
      moveTo: rawMoveTo,
      meetTarget: raw.meetTarget ?? null,
      meetRadius: Number.isFinite(raw.meetRadius) ? raw.meetRadius : null,
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
  if (d?.enabled && countCanStillBecomeValidByPickingUp(d, carriedCount)) return true;
  return false;
}

export function deliveryTileForbidden(policy, tile) {
  if (!tile) return false;
  const d = policy?.delivery;
  if (!d) return false;
  const k = key(tile.x, tile.y);
  return (d.forbiddenTiles ?? []).some((t) => key(t.x, t.y) === k);
}

export function deliveryTileZeroReward(policy, tile) {
  if (!tile) return false;
  const d = policy?.delivery;
  if (!d) return false;
  const k = key(tile.x, tile.y);
  return (d.zeroRewardTiles ?? []).some((t) => key(t.x, t.y) === k);
}

export function deliveryTileMultiplier(policy, tile) {
  if (!tile) return null;
  const d = policy?.delivery;
  if (!d) return null;
  const k = key(tile.x, tile.y);
  const hit = (d.multipliers ?? []).find((t) => key(t.x, t.y) === k);
  return hit ? toFiniteNumber(hit.multiplier) : null;
}

export function tileIsAvoided(policy, tile) {
  if (!tile) return false;
  const m = policy?.movement;
  if (!m) return false;
  const k = key(tile.x, tile.y);
  return (m.avoidTiles ?? []).some((t) => key(t.x, t.y) === k);
}