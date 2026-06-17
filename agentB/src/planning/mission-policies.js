import { key } from "../utils/math.js";

function normalizeTileList(list = []) {
  const out = [];
  const seen = new Set();

  for (const t of list ?? []) {
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

function normalizeAvoidRules(list = []) {
  return list
    .map(t => ({
      x: Number(t?.x),
      y: Number(t?.y),
      penalty: Number(t?.penalty ?? 0)
    }))
    .filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
}

function buildAvoidData(avoidRules = [], target = null, hardThreshold = 50) {
  const blockedSet = new Set();
  const penaltyMap = new Map();

  for (const t of avoidRules) {
    const k = key(t.x, t.y);
    if (t.penalty >= hardThreshold) blockedSet.add(k);
    else if (t.penalty > 0) penaltyMap.set(k, t.penalty);
  }

  if (target && penaltyMap.has(key(target.x, target.y))) {
    // allow targeting soft-penalty tiles if reward justifies it
  }

  return { blockedSet, penaltyMap };
}

export function normalizeMissionPolicy(mission = null) {
  const raw = mission?.policy ?? mission ?? {};

  return {
    wait: {
      mustWait:
        raw.mode === "WAIT" ||
        !!raw.wait?.enabled ||
        false,
      until: Number.isFinite(raw.wait?.until) ? raw.wait.until : null,
      trafficLight: raw.trafficLight ?? raw.wait?.trafficLight ?? null,
    },

    pickup: {
      enabled: raw.avoidPickup ? false : (raw.pickup?.enabled ?? true),
      opportunisticOnly: !!raw.pickup?.opportunisticOnly,
      exactCarry: Number.isFinite(raw.exactCarry)
        ? raw.exactCarry
        : (Number.isFinite(raw.pickup?.exactCarry) ? raw.pickup.exactCarry : null),
      maxCarry: Number.isFinite(raw.pickup?.maxCarry) ? raw.pickup.maxCarry : null,
      maxParcelScore: Number.isFinite(raw.maxAllowedParcelScore)
        ? raw.maxAllowedParcelScore
        : (Number.isFinite(raw.pickup?.maxParcelScore) ? raw.pickup.maxParcelScore : null),
      forbiddenTiles: normalizeTileList(raw.pickup?.forbiddenTiles ?? []),
      preferredTiles: normalizeTileList(raw.pickup?.preferredTiles ?? []),
    },

    delivery: {
      enabled: raw.avoidDelivery ? false : (raw.delivery?.enabled ?? true),
      exactCount: Number.isFinite(raw.exactDeliveryCount)
        ? raw.exactDeliveryCount
        : (Number.isFinite(raw.delivery?.exactCount) ? raw.delivery.exactCount : null),
      minCount: Number.isFinite(raw.delivery?.minCount) ? raw.delivery.minCount : null,
      maxCount: Number.isFinite(raw.delivery?.maxCount) ? raw.delivery.maxCount : null,
      preferredTiles: normalizeTileList(
        raw.preferredDeliveryTiles ?? raw.delivery?.preferredTiles ?? []
      ),
      forbiddenTiles: normalizeTileList(
        raw.forbiddenDeliveryTiles ?? raw.delivery?.forbiddenTiles ?? []
      ),
      zeroRewardTiles: normalizeTileList(
        raw.zeroRewardTiles ??
        raw.zeroRewardDeliveryTiles ??
        raw.delivery?.zeroRewardTiles ??
        []
      ),
      multipliers: Array.isArray(raw.deliveryMultipliers)
        ? raw.deliveryMultipliers
        : (raw.delivery?.multipliers ?? []),
    },

    movement: {
      moveTo: raw.moveTo ?? null,
      meetTarget: raw.meetTarget ?? null,
      meetRadius: Number.isFinite(raw.meetRadius) ? raw.meetRadius : null,
      avoidTiles: normalizeTileList(raw.avoidTiles ?? raw.movement?.avoidTiles ?? []),
      preferTiles: normalizeTileList(raw.movement?.preferTiles ?? []),
    },

    meta: {
      handoffBonus: raw.handoffBonus ?? null,
      mode: raw.mode ?? null,
    }
  };
}

export function pickupAllowed(
  policy,
  { carriedCount = 0, parcel = null, isOpportunistic = false } = {}
) {
  const p = policy?.pickup;
  if (!p?.enabled) return false;

  if (Number.isFinite(p.maxCarry) && carriedCount >= p.maxCarry) return false;
  if (Number.isFinite(p.exactCarry) && carriedCount >= p.exactCarry) return false;
  if (p.opportunisticOnly && !isOpportunistic) return false;

  const reward = Number(parcel?.reward ?? 0);
  if (Number.isFinite(p.maxParcelScore) && reward > p.maxParcelScore) return false;

  return true;
}

export function deliveryAllowed(
  policy,
  { carriedCount = 0 } = {}
) {
  const d = policy?.delivery;
  if (!d?.enabled) return false;

  if (Number.isFinite(d.exactCount)) return carriedCount === d.exactCount;
  if (Number.isFinite(d.minCount) && carriedCount < d.minCount) return false;
  if (Number.isFinite(d.maxCount) && carriedCount > d.maxCount) return false;

  return true;
}

export function deliveryMustHappenNow(policy, { carriedCount = 0 } = {}) {
  const d = policy?.delivery;
  if (!d?.enabled) return false;
  if (Number.isFinite(d.exactCount) && carriedCount >= d.exactCount) return true;
  return false;
}

export function missionNeedsMorePickup(policy, { carriedCount = 0 } = {}) {
  const p = policy?.pickup;
  if (!p?.enabled) return false;
  if (Number.isFinite(p.exactCarry)) return carriedCount < p.exactCarry;
  return false;
}