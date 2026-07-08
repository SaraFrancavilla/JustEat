import { W } from "../world/state.js";

const TRUSTED_SENDERS = (process.env.TRUSTED_SENDERS || "ChallengeGiver,Professor")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isTrustedSender(name) {
  return TRUSTED_SENDERS.includes(String(name ?? "").trim());
}

export function missionSignature(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isMissionEndMessage(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    /\bmission\s+(is\s+)?over\b/.test(t) ||
    /\bchallenge\s+(is\s+)?over\b/.test(t) ||
    /\bmission\s+complete\b/.test(t) ||
    /\bchallenge\s+complete\b/.test(t) ||
    /\bend\s+of\s+(the\s+)?mission\b/.test(t) ||
    /\bend\s+of\s+(the\s+)?challenge\b/.test(t) ||
    /\byou\s+can\s+resume\b/.test(t) ||
    /\bresume\s+normal\b/.test(t) ||
    /\bback\s+to\s+normal\b/.test(t) ||
    /\bignore\s+the\s+previous\s+mission\b/.test(t) ||
    /\bcancel\s+the\s+previous\s+mission\b/.test(t) ||
    /\bprevious\s+mission\s+is\s+cancelled\b/.test(t) ||
    /\bmission\s+cancelled\b/.test(t) ||
    /\bchallenge\s+cancelled\b/.test(t) ||
    /\bcancelled\b/.test(t)
  );
}

function carryingCount() {
  return W.carrying?.size ?? 0;
}

export function activeGoals() {
  return Array.isArray(W.activeGoals) ? W.activeGoals : [];
}

export function activeRules() {
  return Array.isArray(W.activeRules) ? W.activeRules : [];
}

export function activeMissions() {
  return [...activeGoals(), ...activeRules()].filter(
    (m) => m?.accepted && m?.status === "active"
  );
}

// Normalises any variant (camelCase, no-separator, snake_case) -> snake_case canonical.
// Only snake_case strings are used for all internal comparisons.
function canonicalObjectiveType(type) {
  const t = String(type ?? "custom").trim().toLowerCase().replace(/_/g, "");
  const map = {
    moveto:                    "move_to",
    wait:                      "wait",
    deliverrule:               "deliver_rule",
    pickuprule:                "pickup_rule",
    droprule:                  "drop_rule",
    deliveryzonerule:          "delivery_zone_rule",
    deliveryvalueconstraint:   "delivery_value_constraint",
    avoidtile:                 "avoid_tile",
    avoidpickup:               "avoid_pickup",
    avoiddelivery:             "avoid_delivery",
    meetteammate:              "meet_teammate",
    handoffbonus:              "handoff_bonus",
    trafficlightwait:          "traffic_light_wait",
    custom:                    "custom",
  };
  return map[t] ?? "custom";
}

function missionPriority(mission) {
  if (!mission) return -Infinity;
  const type = canonicalObjectiveType(mission?.objectiveType);
  if (type === "wait")          return 100;
  if (type === "deliver_rule")  return 80;
  if (type === "pickup_rule")   return 75;
  if (type === "meet_teammate") return 70;
  if (type === "move_to")       return 60;
  if (type === "avoid_tile")    return 50;
  return 10;
}

function deliveryTilesForRegion(region) {
  const r = String(region ?? "").trim().toLowerCase();
  const deliveryTiles = Array.isArray(W.deliveryTiles) ? W.deliveryTiles : [];
  if (deliveryTiles.length === 0) return [];

  if (r.includes("leftmost") || r.includes("left-most")) {
    const minX = Math.min(...deliveryTiles.map((t) => Number(t.x)));
    return deliveryTiles
      .filter((t) => Number(t.x) === minX)
      .map((t) => ({ x: Number(t.x), y: Number(t.y) }));
  }

  if (r.includes("rightmost") || r.includes("right-most")) {
    const maxX = Math.max(...deliveryTiles.map((t) => Number(t.x)));
    return deliveryTiles
      .filter((t) => Number(t.x) === maxX)
      .map((t) => ({ x: Number(t.x), y: Number(t.y) }));
  }

  return [];
}

function dropRuleDeliveryTiles(mission, effectType) {
  const rule = mission?.policy?.dropRule;
  if (!rule) return [];

  const actualEffect = rule.scoreEffect?.type ?? "unknown";
  if (effectType && actualEffect !== effectType) return [];

  if (Array.isArray(rule.targetTiles) && rule.targetTiles.length > 0) {
    return rule.targetTiles
      .map((t) => ({ x: Number(t?.x), y: Number(t?.y) }))
      .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y));
  }

  return deliveryTilesForRegion(rule.region);
}

export function currentDeliverRuleMission() {
  const candidates = activeMissions().filter(
    (m) => canonicalObjectiveType(m?.objectiveType) === "deliver_rule"
  );
  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    const upperA = Number(
      a?.policy?.delivery?.exactCount ??
      a?.policy?.delivery?.maxCount ??
      a?.policy?.delivery?.maxExclusiveCount ??
      Infinity
    );
    const upperB = Number(
      b?.policy?.delivery?.exactCount ??
      b?.policy?.delivery?.maxCount ??
      b?.policy?.delivery?.maxExclusiveCount ??
      Infinity
    );
    return upperA - upperB;
  })[0];
}

// Returns the active pickup_rule mission with the most restrictive cap (smallest maxCarry).
export function currentPickupRuleMission() {
  const candidates = activeMissions().filter(
    (m) => canonicalObjectiveType(m?.objectiveType) === "pickup_rule"
  );
  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    const capA = Number(a?.policy?.pickup?.maxCarry ?? a?.policy?.pickup?.exactCarry ?? Infinity);
    const capB = Number(b?.policy?.pickup?.maxCarry ?? b?.policy?.pickup?.exactCarry ?? Infinity);
    return capA - capB;
  })[0];
}

export function currentMissionExactCount() {
  const mission = currentDeliverRuleMission();
  const exact = Number(mission?.policy?.delivery?.exactCount);
  return Number.isFinite(exact) && exact > 0 ? exact : null;
}

/**
 * Returns the effective carry target for the active deliver_rule mission,
 * considering exactCount, maxCount, maxExclusiveCount, and minCount in that priority order.
 * Falls back to strategy carryTarget when no mission is active.
 */
export function currentCarryTarget() {
  const mission = currentDeliverRuleMission();
  if (mission) {
    const d = mission?.policy?.delivery ?? {};
    if (Number.isFinite(d.exactCount) && d.exactCount > 0) return d.exactCount;
    if (Number.isFinite(d.maxCount) && d.maxCount > 0) return d.maxCount;
    if (Number.isFinite(d.maxExclusiveCount) && d.maxExclusiveCount > 1)
      return d.maxExclusiveCount - 1;
    if (Number.isFinite(d.minCount) && d.minCount > 0) return d.minCount;
    if (Number.isFinite(d.minExclusiveCount) && d.minExclusiveCount >= 0)
      return d.minExclusiveCount + 1;
  }
  return Math.max(1, W.strategy?.carryTarget ?? 3);
}

export function missionNeedsMorePickup() {
  const mission = currentDeliverRuleMission();
  if (!mission) return false;
  const d = mission?.policy?.delivery ?? {};
  const carrying = carryingCount();

  if (Number.isFinite(d.exactCount)) return carrying < d.exactCount;
  if (Number.isFinite(d.minCount) && carrying < d.minCount) return true;
  if (Number.isFinite(d.minExclusiveCount) && carrying <= d.minExclusiveCount) return true;
  if (Number.isFinite(d.maxCount) && carrying < d.maxCount) return true;
  if (Number.isFinite(d.maxExclusiveCount) && carrying < d.maxExclusiveCount - 1) return true;

  return false;
}

export function currentBlockingMission() {
  const missions = activeMissions();
  if (missions.length === 0) return null;
  return [...missions].sort((a, b) => missionPriority(b) - missionPriority(a))[0];
}

export function blockingMissionText() {
  return currentBlockingMission()?.text ?? "None";
}

export function archiveMission(mission, finalStatus = "completed") {
  if (!mission || mission.status !== "active") return;

  mission.status = finalStatus;
  mission.completedAt = Date.now();

  if (!Array.isArray(W.missionHistory)) {
    W.missionHistory = [];
  }

  W.missionHistory.push({ ...mission });
}

export function completeAllActiveMissions(reason = "cancelled") {
  for (const mission of activeGoals()) {
    archiveMission(mission, reason);
  }
  for (const mission of activeRules()) {
    archiveMission(mission, reason);
  }

  W.activeGoals = activeGoals().filter((m) => m?.status === "active");
  W.activeRules = activeRules().filter((m) => m?.status === "active");
}

export function pruneExpiredMissions() {
  const now = Date.now();

  for (const mission of activeGoals()) {
    if (mission?.status !== "active") continue;
    const until = Number(mission?.policy?.wait?.until ?? mission?.expiresAt ?? 0);
    if (until && now >= until) {
      archiveMission(mission, "completed");
    }
  }

  for (const mission of activeRules()) {
    if (mission?.status !== "active") continue;
    const until = Number(mission?.policy?.wait?.until ?? mission?.expiresAt ?? 0);
    if (until && now >= until) {
      archiveMission(mission, "completed");
    }
  }

  W.activeGoals = activeGoals().filter((m) => m?.status === "active");
  W.activeRules = activeRules().filter((m) => m?.status === "active");
}

export function missionNextAction() {
  pruneExpiredMissions();

  const waitMission = activeMissions().find(
    (m) => canonicalObjectiveType(m?.objectiveType) === "wait"
  );

  if (!waitMission) return null;
  return { type: "WAIT", target: null, missionId: waitMission.id };
}

function parseMissionDurationMs(text) {
  const t = String(text ?? "").toLowerCase();

  const combinedMatch = t.match(/for\s+(\d+)\s+minutes?\s+and\s+(\d+)\s+seconds?/i);
  if (combinedMatch) {
    const minutes = Number(combinedMatch[1]) || 0;
    const seconds = Number(combinedMatch[2]) || 0;
    return (minutes * 60 + seconds) * 1000;
  }

  let totalMs = 0;

  const minutesMatch = t.match(/for\s+(\d+)\s+minutes?/i);
  if (minutesMatch) {
    totalMs += Number(minutesMatch[1]) * 60 * 1000;
  }

  const secondsMatch = t.match(/for\s+(\d+)\s+seconds?/i);
  if (secondsMatch) {
    totalMs += Number(secondsMatch[1]) * 1000;
  }

  const directSecondsMatch = t.match(/\bwait\s+(\d+)\s+seconds?/i);
  if (directSecondsMatch) {
    totalMs += Number(directSecondsMatch[1]) * 1000;
  }

  const directMinutesMatch = t.match(/\bwait\s+(\d+)\s+minutes?/i);
  if (directMinutesMatch) {
    totalMs += Number(directMinutesMatch[1]) * 60 * 1000;
  }

  return totalMs > 0 ? totalMs : null;
}

export function currentMissionConstraints() {
  const missions = activeMissions();
  const blocking = currentBlockingMission();

  const maxAllowedParcelScoreValues = missions
    .map((m) => Number(m?.policy?.delivery?.maxParcelScore))
    .filter((n) => Number.isFinite(n));
  const minAllowedParcelScoreValues = missions
    .map((m) => Number(m?.policy?.delivery?.minParcelScore))
    .filter((n) => Number.isFinite(n));

  return {
    mustWait: missions.some((m) => canonicalObjectiveType(m?.objectiveType) === "wait"),
    avoidPickup: missions.some((m) => m?.policy?.avoidPickup),
    avoidDelivery: missions.some((m) => m?.policy?.avoidDelivery),

    exactDeliverCount: currentMissionExactCount(),

    minDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m?.policy?.delivery?.minCount);
      return Number.isFinite(v) ? Math.max(acc ?? v, v) : acc;
    }, null),

    maxDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m?.policy?.delivery?.maxCount);
      return Number.isFinite(v) ? Math.min(acc ?? v, v) : acc;
    }, null),

    minExclusiveDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m?.policy?.delivery?.minExclusiveCount);
      return Number.isFinite(v) ? Math.max(acc ?? v, v) : acc;
    }, null),

    maxExclusiveDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m?.policy?.delivery?.maxExclusiveCount);
      return Number.isFinite(v) ? Math.min(acc ?? v, v) : acc;
    }, null),

    moveTo: blocking?.policy?.moveTo?.target ?? blocking?.policy?.moveTo ?? null,
    trafficLight: blocking?.policy?.trafficLight ?? null,

    avoidTiles: missions.flatMap((m) => {
      const penalty = Number(m?.policy?.avoidTiles?.penalty);
      return (m?.policy?.avoidTiles?.tiles ?? []).map((t) => ({
        x: Number(t.x),
        y: Number(t.y),
        penalty: Number.isFinite(penalty) ? penalty : 0,
      }));
    }),

    preferredDeliveryTiles: missions.flatMap((m) => [
      ...(m?.policy?.delivery?.preferredTiles ?? []),
      ...dropRuleDeliveryTiles(m, "gain"),
    ]),
    zeroRewardDeliveryTiles: missions.flatMap((m) => m?.policy?.delivery?.zeroRewardTiles ?? []),
    forbiddenDeliveryTiles: missions.flatMap((m) => [
      ...(m?.policy?.delivery?.forbiddenTiles ?? []),
      ...dropRuleDeliveryTiles(m, "loss"),
    ]),
    deliveryMultipliers: missions.flatMap((m) => m?.policy?.delivery?.multipliers ?? []),

    maxAllowedParcelScore:
      maxAllowedParcelScoreValues.length > 0
        ? Math.min(...maxAllowedParcelScoreValues)
        : null,
    minAllowedParcelScore:
      minAllowedParcelScoreValues.length > 0
        ? Math.max(...minAllowedParcelScoreValues)
        : null,

    meetTarget: blocking?.policy?.meetTeammate?.target ?? null,
    meetRadius: blocking?.policy?.meetTeammate?.radius ?? null,
    handoffBonus: blocking?.policy?.handoffBonus ?? null,
    //aggiunto ora per risolvere missione leftmost
    dropRule:
      blocking?.policy?.dropRule ??
      missions.find((m) => canonicalObjectiveType(m?.objectiveType) === "drop_rule")?.policy?.dropRule ??
      // If there's no explicit drop_rule mission, but some mission constrains delivery parcel score,
      // synthesize a dropRule so downstream logic can treat it uniformly.
      (() => {
        const m = missions.find((m) => m?.policy?.delivery?.maxParcelScore != null);
        if (m) return { maxParcelScore: m.policy.delivery.maxParcelScore, missionId: m.missionId ?? null };
        return null;
      })(),
  };
}

export function enqueueTrustedMissionMessage(entry) {
  if (!Array.isArray(W.missionQueue)) W.missionQueue = [];
  W.missionQueue.push({ ...entry, queuedAt: Date.now() });
}

export async function processMissionQueue() {
  if (W.missionEvaluating) return;
  if (!Array.isArray(W.missionQueue)) W.missionQueue = [];
  W.missionEvaluating = true;

  try {
    while (W.missionQueue.length > 0) {
      const item = W.missionQueue.shift();
      try {
        await handleTrustedMissionMessage({
          callModel: item.callModel,
          runCoordinationCycle: item.runCoordinationCycle,
          missionText: item.missionText,
          replyCallback: item.replyCallback,
          senderId: item.senderId,
          socket: item.socket,
        });
      } catch (error) {
        console.error("[MISSION] Failed queued mission:", error);
      }
    }
  } finally {
    W.missionEvaluating = false;
  }
}

export function completeDeliverRuleMissionsIfSatisfied(carriedCountBeforeDrop) {
  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "deliver_rule") continue;

    const d = mission?.policy?.delivery ?? {};
    const n = carriedCountBeforeDrop;

    // persistent_rule missions stay active for the whole session
    if (mission.kind === "persistent_rule") continue;

    const satisfied =
      (Number.isFinite(d.exactCount) && n === d.exactCount) ||
      (Number.isFinite(d.minCount) && n >= d.minCount) ||
      (Number.isFinite(d.minExclusiveCount) && n > d.minExclusiveCount) ||
      (Number.isFinite(d.maxCount) && n >= 1 && n <= d.maxCount) ||
      (Number.isFinite(d.maxExclusiveCount) && n >= 1 && n < d.maxExclusiveCount) ||
      (!Number.isFinite(d.exactCount) &&
        !Number.isFinite(d.minCount) &&
        !Number.isFinite(d.minExclusiveCount) &&
        !Number.isFinite(d.maxCount) &&
        !Number.isFinite(d.maxExclusiveCount));

    if (satisfied) {
      archiveMission(mission, "completed");
      W._lastMissionId = null;
      W._lastMissionSignature = null;
      console.log("[MISSION] Delivery mission completed:", mission.text);
    }
  }

  W.activeGoals = (W.activeGoals ?? []).filter((m) => m?.status === "active");
  W.activeRules = (W.activeRules ?? []).filter((m) => m?.status === "active");
}

export function completeWaitMissionsIfExpired(now = Date.now()) {
  let completed = false;

  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "wait") continue;
    const until = Number(mission?.policy?.wait?.until ?? mission?.expiresAt ?? 0);
    if (!until || now < until) continue;

    archiveMission(mission, "completed");
    completed = true;
    console.log(`[MISSION] Wait mission completed: waited until ${new Date(until).toISOString()} (${mission.text})`);
  }

  if (completed) {
    W.activeGoals = activeGoals().filter((m) => m?.status === "active");
    W.activeRules = activeRules().filter((m) => m?.status === "active");
  }

  return completed;
}

export function completeMoveToMissionsIfReached(position = W.me) {
  if (!position) return false;
  let completed = false;

  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "move_to") continue;
    const target = mission?.policy?.moveTo?.target ?? mission?.policy?.moveTo ?? null;
    if (!target) continue;

    const radius = Math.max(0, Number(mission?.policy?.moveTo?.radius ?? 0));
    const dx = Math.abs(Number(position.x) - Number(target.x));
    const dy = Math.abs(Number(position.y) - Number(target.y));
    if (dx + dy > radius) continue;

    archiveMission(mission, "completed");
    completed = true;
    console.log(`[MISSION] Move-to mission completed: reached (${Number(target.x)},${Number(target.y)}) (${mission.text})`);
  }

  if (completed) {
    W.activeGoals = activeGoals().filter((m) => m?.status === "active");
    W.activeRules = activeRules().filter((m) => m?.status === "active");
  }

  return completed;
}

export function completeDropRuleMissionsIfSatisfied(position = W.me, droppedCount = 0) {
  if (!position || droppedCount <= 0) return false;
  let completed = false;

  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "drop_rule") continue;
    if (mission?.kind !== "achievement_once") continue;

    // const targets = mission?.policy?.dropRule?.targetTiles ?? [];
    const rule = mission?.policy?.dropRule ?? {};
    //aggiunto per risolvere leftmost mission problem
    const targets = Array.isArray(rule.targetTiles) && rule.targetTiles.length > 0 
      ? rule.targetTiles
      : deliveryTilesForRegion(rule.region);
    if (!Array.isArray(targets) || targets.length === 0) continue;

    const reached = targets.some(
      (t) => Number(t?.x) === Number(position.x) && Number(t?.y) === Number(position.y)
    );
    if (!reached) continue;

    archiveMission(mission, "completed");
    completed = true;
    console.log(`[MISSION] Drop mission completed: dropped ${droppedCount} parcel(s) at (${Number(position.x)},${Number(position.y)}) (${mission.text})`);
  }

  if (completed) {
    W.activeGoals = activeGoals().filter((m) => m?.status === "active");
    W.activeRules = activeRules().filter((m) => m?.status === "active");
  }

  return completed;
}

const ALLOWED_OBJECTIVE_TYPES = new Set([
  "move_to",
  "wait",
  "deliver_rule",
  "pickup_rule",
  "drop_rule",
  "delivery_zone_rule",
  "delivery_value_constraint",
  "avoid_tile",
  "avoid_pickup",
  "avoid_delivery",
  "meet_teammate",
  "handoff_bonus",
  "traffic_light_wait",
  "custom",
]);

function validateMissionSchema(obj) {
  if (!obj || typeof obj !== "object") return null;

  const category = obj.category;
  if (!["rule", "goal", "quiz", "end", "ignore"].includes(category)) {
    return null;
  }

  const objectiveType = canonicalObjectiveType(obj.objectiveType ?? "custom");

  if (!ALLOWED_OBJECTIVE_TYPES.has(objectiveType)) {
    return null;
  }

  const toNonNegativeInt = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };

  const toNumber = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const exactCount = toNonNegativeInt(obj.exactCount);
  const minCount = toNonNegativeInt(obj.minCount);
  const maxCount = toNonNegativeInt(obj.maxCount);
  const minExclusiveCount = toNonNegativeInt(obj.minExclusiveCount);
  const maxExclusiveCount = toNonNegativeInt(obj.maxExclusiveCount);
  const durationMs = toNonNegativeInt(obj.durationMs);
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5)));

  let scoreEffect = null;
  if (obj.scoreEffect && typeof obj.scoreEffect === "object") {
    const type = ["gain", "loss", "unknown"].includes(obj.scoreEffect.type)
      ? obj.scoreEffect.type
      : "unknown";
    const amount = toNonNegativeInt(obj.scoreEffect.amount);
    const per = ["pickup", "delivery", "answer", null].includes(obj.scoreEffect.per)
      ? obj.scoreEffect.per
      : null;
    scoreEffect = { type, amount, per };
  }

  const normPos = (p) => {
    if (!p || typeof p !== "object") return null;
    const x = Math.round(toNumber(p.x));
    const y = Math.round(toNumber(p.y));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };

  const targetPosition = normPos(obj.targetPosition);
  const targetTiles = Array.isArray(obj.targetTiles)
    ? obj.targetTiles.map(normPos).filter(Boolean)
    : null;
  const rewardMultiplier = toNumber(obj.rewardMultiplier);
  const rewardOverride = toNumber(obj.rewardOverride);
  const valueThreshold = toNumber(obj.valueThreshold);
  const radius = toNumber(obj.radius);
  const requiresCoordination = Boolean(obj.requiresCoordination);
  const persistentUntilCancelled = Boolean(obj.persistentUntilCancelled);
  const replyToSender = Boolean(obj.replyToSender);
  const region =
    typeof obj.region === "string" && obj.region.trim()
      ? obj.region.trim().slice(0, 50)
      : null;
  const rowParity = ["odd", "even"].includes(obj.rowParity) ? obj.rowParity : null;

  return {
    category,
    objectiveType,
    targetAction: ["pickup", "deliver"].includes(obj.targetAction)
      ? obj.targetAction
      : null,
    polarity: ["must", "avoid"].includes(obj.polarity) ? obj.polarity : null,
    exactCount,
    minCount,
    maxCount,
    minExclusiveCount,
    maxExclusiveCount,
    durationMs,
    targetPosition,
    targetTiles,
    rewardMultiplier,
    rewardOverride,
    valueThreshold,
    radius,
    requiresCoordination,
    persistentUntilCancelled,
    replyToSender,
    rowParity,
    region,
    scoreEffect,
    confidence,
    explanation:
      typeof obj.explanation === "string" ? obj.explanation.slice(0, 200) : "",
  };
}

function repairMissionSchema(schema, missionText) {
  if (!schema) return schema;

  const text = String(missionText ?? "").toLowerCase();
  const repaired = { ...schema };

  const hasPickupVerb = /\bpick\s*up\b|\bcollect\b|\bgrab\b/.test(text);
  const hasCountPhrase =
    /\bat\s+a\s+time\b|\bat\s+once\b/.test(text) ||
    /\bno\s+more\s+than\b|\bat\s+most\b|\bonly\s+\d+\b/.test(text) ||
    /\bmore\s+than\b|\bless\s+than\b/.test(text);
  const hasDeliverVerb = /\bdeliver\b|\bdrop\s+off\b/.test(text);

  // pickup count rule repair
  if (hasPickupVerb && hasCountPhrase && !hasDeliverVerb) {
    repaired.category = "rule";
    repaired.targetAction = "pickup";
    repaired.requiresCoordination = false;
    repaired.persistentUntilCancelled =
      schema.persistentUntilCancelled || /\bfrom\s+now\s+on\b/.test(text);

    if (repaired.objectiveType !== "pickup_rule") {
      repaired.objectiveType = "pickup_rule";
      repaired.valueThreshold = null;
      repaired.rewardMultiplier = null;
      repaired.rewardOverride = null;
    }

    if (/\bmore\s+than\s+1\b/.test(text) || /\bonly\s+1\b/.test(text) || /\bone\s+(?:parcel|package)\b/.test(text)) {
      repaired.maxCount = repaired.maxCount ?? 1;
      repaired.exactCount = null;
      repaired.minCount = null;
      repaired.minExclusiveCount = null;
      repaired.maxExclusiveCount = null;
    }
  }

  // delivery count rule repair
  if (hasDeliverVerb && hasCountPhrase) {
    repaired.category = "rule";
    repaired.targetAction = "deliver";
    repaired.requiresCoordination = false;
    repaired.persistentUntilCancelled =
      schema.persistentUntilCancelled || /\bfrom\s+now\s+on\b/.test(text);

    if (repaired.objectiveType === "delivery_value_constraint") {
      repaired.objectiveType = "deliver_rule";
      repaired.valueThreshold = null;
      repaired.rewardMultiplier = null;
      repaired.rewardOverride = null;
    }

    if (/\bmore\s+than\s+1\b/.test(text) && /\bpenalt/.test(text)) {
      repaired.objectiveType = "deliver_rule";
      repaired.polarity = "must";
      repaired.maxCount = 1;
      repaired.exactCount = null;
      repaired.minCount = null;
      repaired.minExclusiveCount = null;
      repaired.maxExclusiveCount = null;
    }

    if (
      (/\bonly\s+1\b/.test(text) || /\bone\s+(?:parcel|package)\s+at\s+a\s+time\b/.test(text)) &&
      repaired.objectiveType !== "deliver_rule"
    ) {
      repaired.objectiveType = "deliver_rule";
      repaired.exactCount = 1;
      repaired.minCount = null;
      repaired.maxCount = null;
      repaired.minExclusiveCount = null;
      repaired.maxExclusiveCount = null;
    }
  }

  if (
    repaired.objectiveType === "avoid_tile" &&
    !repaired.targetTiles?.length &&
    repaired.targetPosition
  ) {
    repaired.targetTiles = [repaired.targetPosition];
  }

  return repaired;
}

export async function interpretMissionWithLLM({ callModel, missionText, currentState }) {
  const systemPrompt = `
You are an arbiter for in-game missions in DeliverooJS.
Convert a natural-language message into a STRICT JSON mission schema.

THE GAME
- The agent moves on a grid, picks up parcels, delivers them for points.
- The server may send temporary missions, rules, quizzes, or cancellations.
- Messages can contain incentives and penalties.

RETURN ONLY VALID JSON.
Do not include markdown.
Do not include explanation outside the JSON.
If a field is unknown, use null.
Do not invent constraints that are not explicitly supported by the message.

SCHEMA
{
  "category": "rule" | "goal" | "quiz" | "end" | "ignore",
  "objectiveType": "move_to" | "wait" | "deliver_rule" | "pickup_rule" | "drop_rule" | "delivery_zone_rule" | "delivery_value_constraint" | "avoid_tile" | "avoid_pickup" | "avoid_delivery" | "meet_teammate" | "handoff_bonus" | "traffic_light_wait" | "custom",
  "targetAction": "pickup" | "deliver" | null,
  "polarity": "must" | "avoid" | null,
  "exactCount": number | null,
  "minCount": number | null,
  "maxCount": number | null,
  "minExclusiveCount": number | null,
  "maxExclusiveCount": number | null,
  "durationMs": number | null,
  "targetPosition": { "x": number, "y": number } | null,
  "targetTiles": [{ "x": number, "y": number }] | null,
  "rewardMultiplier": number | null,
  "rewardOverride": number | null,
  "valueThreshold": number | null,
  "radius": number | null,
  "requiresCoordination": boolean,
  "persistentUntilCancelled": boolean,
  "replyToSender": boolean,
  "rowParity": "odd" | "even" | null,
  "region": string | null,
  "scoreEffect": { "type": "gain" | "loss" | "unknown", "amount": number | null, "per": "pickup" | "delivery" | "answer" | null } | null,
  "confidence": number,
  "explanation": string
}

COUNT INTERPRETATION RULES
- Use exactCount only for wording like exactly, only, just, one at a time, deliver 2 at a time.
- Use minCount for wording like at least, minimum, 2 or more, no fewer than.
- Use maxCount for wording like at most, maximum, up to, no more than.
- Use minExclusiveCount for wording like more than 2, greater than 2.
- Use maxExclusiveCount for wording like less than 5, fewer than 5.
- Never convert "more than 1 gives a penalty" into a value/score rule. That is still a count rule.
- If the message penalizes delivering more than N parcels at a time, use objectiveType "deliver_rule" with maxCount N.
- If the message limits how many parcels to pick up at once, use objectiveType "pickup_rule" with maxCount N.
- If no count constraint is stated, all count fields must be null.

INTERPRETATION RULES
- "From now on, only deliver 2 packages at a time" => category "rule", objectiveType "deliver_rule", targetAction "deliver", polarity "must", exactCount 2.
- "Deliver at least 2 packages at a time" => category "rule", objectiveType "deliver_rule", targetAction "deliver", polarity "must", minCount 2.
- "Deliver at most 5 packages at a time" => category "rule", objectiveType "deliver_rule", targetAction "deliver", polarity "must", maxCount 5.
- "If you deliver more than 1 parcel at a time you get a penalty" => category "rule", objectiveType "deliver_rule", targetAction "deliver", polarity "must", maxCount 1.
- "Deliver more than 2 and less than 5 packages at a time" => category "rule", objectiveType "deliver_rule", targetAction "deliver", polarity "must", minExclusiveCount 2, maxExclusiveCount 5.
- "Pick up no more than 1 parcel at a time" => category "rule", objectiveType "pickup_rule", targetAction "pickup", polarity "must", maxCount 1.
- "Pick up only 2 parcels at a time" => category "rule", objectiveType "pickup_rule", targetAction "pickup", polarity "must", exactCount 2.
- "You can only carry 3 parcels at once" => category "rule", objectiveType "pickup_rule", targetAction "pickup", polarity "must", maxCount 3.
- "Wait for 10 seconds without moving" => category "goal", objectiveType "wait", durationMs 10000.
- "If you pick up any packages in the next 30 seconds you will lose 50 points for each package picked up" => category "rule", objectiveType "avoid_pickup", targetAction "pickup", polarity "avoid", durationMs 30000, scoreEffect { "type": "loss", "amount": 50, "per": "pickup" }.
- "Drop a package in the leftmost tile to get 5pt" => category "goal", objectiveType "drop_rule", targetAction "deliver", polarity "must", region "leftmost", scoreEffect { "type": "gain", "amount": 5, "per": "delivery" }.
- "Drop a package in the leftmost tile to get -10pt" => category "rule", objectiveType "drop_rule", targetAction "deliver", polarity "avoid", region "leftmost", scoreEffect { "type": "loss", "amount": 10, "per": "delivery" }.
- "Every time you deliver in 4,7 or 8,2 you get 5x pts" => category "rule", objectiveType "delivery_zone_rule", targetAction "deliver", targetTiles [{ "x": 4, "y": 7 }, { "x": 8, "y": 2 }], rewardMultiplier 5.
- "Every time you deliver in 4,7 you get 0 pts" => category "rule", objectiveType "delivery_zone_rule", targetAction "deliver", targetTiles [{ "x": 4, "y": 7 }], rewardOverride 0.
- "Only deliver parcels with a score higher than 15, otherwise you get negative points" => category "rule", objectiveType "delivery_value_constraint", targetAction "deliver", valueThreshold 15, rewardMultiplier 0.
- "If you deliver parcels with a score higher than 10, you get no reward" => category "rule", objectiveType "delivery_value_constraint", targetAction "deliver", valueThreshold 10, rewardMultiplier 0.
- "Do not go through tile 4,7 otherwise you lose 50 points" => category "rule", objectiveType "avoid_tile", polarity "avoid", targetTiles [{ "x": 4, "y": 7 }], scoreEffect { "type": "loss", "amount": 50, "per": null }.
- Quiz questions => category "quiz".
- End/cancel messages => category "end".

Return ONLY the JSON object.
`.trim();

  const userPrompt = `
MESSAGE:
"${missionText}"

CURRENT STATE:
${currentState ?? "n/a"}
`.trim();

  const raw = await callModel(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0 }
  );

  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return validateMissionSchema(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

function quickMissionRoute(text) {
  const raw = String(text ?? "").trim();
  const t = raw.toLowerCase();

  if (!raw) return { kind: "ignore", reason: "empty" };
  if (isMissionEndMessage(t)) return { kind: "end", reason: "explicit-end" };

  const looksLikeQuiz =
    /\?$/.test(raw) ||
    /\bwhat is\b/.test(t) ||
    /\bwho is\b/.test(t) ||
    /\bquiz\b/.test(t) ||
    /\bquestion\b/.test(t);

  const looksNegative =
    /\blose\b/.test(t) ||
    /\bpenalt(y|ies)?\b/.test(t) ||
    /\bminus\s+\d+\b/.test(t) ||
    /-\s*\d+\s*points?\b/.test(t) ||
    /\byou\s+will\s+lose\b/.test(t);

  if (looksLikeQuiz) {
    return {
      kind: "quiz",
      reason: looksNegative ? "quiz-negative" : "quiz-candidate",
      negative: looksNegative,
    };
  }

  return { kind: "unknown", reason: "needs-full-parse" };
}

function extractQuizQuestion(text) {
  const raw = String(text ?? "").trim();
  const m =
    raw.match(/quiz\s*:\s*(.+)$/i) ||
    raw.match(/question\s*:\s*(.+)$/i);
  return (m?.[1] ?? raw).trim();
}

function parseQuickMathAnswer(text) {
  const q = extractQuizQuestion(text).toLowerCase();

  const m =
    q.match(/what is\s+(-?\d+)\s*([+\-*/x])\s*(-?\d+)\??/) ||
    q.match(/(-?\d+)\s*([+\-*/x])\s*(-?\d+)\s*=?\??/);

  if (!m) return null;

  const a = Number(m[1]);
  const op = m[2];
  const b = Number(m[3]);

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  if (op === "+") return String(a + b);
  if (op === "-") return String(a - b);
  if (op === "*" || op === "x") return String(a * b);
  if (op === "/") {
    if (b === 0) return null;
    return String(a / b);
  }

  return null;
}

function baseQuickSchema(overrides = {}) {
  return {
    category: "ignore",
    objectiveType: "custom",
    targetAction: null,
    polarity: null,
    exactCount: null,
    minCount: null,
    maxCount: null,
    minExclusiveCount: null,
    maxExclusiveCount: null,
    durationMs: null,
    scoreEffect: null,
    targetPosition: null,
    targetTiles: null,
    rewardMultiplier: null,
    rewardOverride: null,
    valueThreshold: null,
    radius: null,
    requiresCoordination: false,
    persistentUntilCancelled: false,
    replyToSender: false,
    rowParity: null,
    region: null,
    confidence: 0.95,
    explanation: "quick-rule-parser",
    ...overrides,
  };
}

function extractCoordinatePairs(text) {
  const out = [];
  const seen = new Set();
  const re = /(?:tile\s*)?(-?\d+)\s*,\s*(-?\d+)/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, y });
  }
  return out;
}

function quickMissionSchema(rawText) {
  const raw = String(rawText ?? "").trim();
  const t = raw.toLowerCase();
  if (!raw) return null;

  const durationMs = parseMissionDurationMs(raw);
  const coords = extractCoordinatePairs(raw);

  // wait
  if (/\bwait\b/.test(t) && durationMs) {
    return baseQuickSchema({
      category: "goal",
      objectiveType: "wait",
      durationMs,
      confidence: 1,
    });
  }

  // move_to
  const moveMatch = t.match(
    /\b(?:go|move|walk|reach)\s+(?:on|to|towards|at)?\s*(?:tile|position)?\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?/i
  );
  if (moveMatch) {
    return baseQuickSchema({
      category: "goal",
      objectiveType: "move_to",
      targetPosition: { x: Number(moveMatch[1]), y: Number(moveMatch[2]) },
      radius: 0,
    });
  }

  // pickup_rule> count-limited pickup (must come before avoid_pickup)
  if (
    /\bpick\s*up\b|\bcollect\b|\bgrab\b/.test(t) &&
    /\bat\s+a\s+time\b|\bat\s+once\b|\bno\s+more\s+than\b|\bat\s+most\b|\bonly\s+\d|\bmax(?:imum)?\b/.test(t)
  ) {
    const atMost =
      t.match(/(?:no\s+more\s+than|at\s+most|max(?:imum)?|up\s+to)\s+(\d+)/i) ??
      t.match(/only\s+(\d+)/i) ??
      t.match(/(\d+)\s+(?:parcel|package|item)/i);
    const exact =
      t.match(/\bexactly\s+(\d+)\b/i) ??
      t.match(/\bjust\s+(\d+)\b/i);
    if (atMost) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "pickup_rule",
        targetAction: "pickup",
        polarity: "must",
        maxCount: Number(atMost[1]),
      });
    }
    if (exact) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "pickup_rule",
        targetAction: "pickup",
        polarity: "must",
        exactCount: Number(exact[1]),
      });
    }
  }

  // avoid_pickup: full ban (no count phrase, just penalty for picking up)
  if (/\bpick\s*up\b|\bpickup\b/.test(t) && /\b(?:lose|penalt|negative|minus|-)\b/.test(t)) {
    const amount = Number(
      t.match(/(?:lose|minus|-)\s*(\d+)\s*points?/i)?.[1] ??
      t.match(/(-\d+)\s*points?/i)?.[2]
    );
    return baseQuickSchema({
      category: "rule",
      objectiveType: "avoid_pickup",
      targetAction: "pickup",
      polarity: "avoid",
      durationMs,
      scoreEffect: {
        type: "loss",
        amount: Number.isFinite(amount) ? amount : null,
        per: "pickup",
      },
    });
  }

  // deliver_rule
  if (/\bdeliver\b/.test(t) && /\bat\s+a\s+time\b/.test(t)) {
    const exact =
      t.match(/\bmay\s+only\s+deliver\s+(\d+)\b/) ??
      t.match(/\bcan\s+only\s+deliver\s+(\d+)\b/) ??
      t.match(/\bonly\s+(\d+)\b/) ??
      t.match(/\bonly\b[\s\S]*?\b(\d+)\b/) ??
      t.match(/\bexactly\s+(\d+)\b/) ??
      t.match(/\bjust\s+(\d+)\b/);
    if (exact) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "deliver_rule",
        targetAction: "deliver",
        polarity: "must",
        exactCount: Number(exact[1]),
      });
    }

    const atLeast = t.match(/\bat\s+least\s+(\d+)\b/);
    if (atLeast) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "deliver_rule",
        targetAction: "deliver",
        polarity: "must",
        minCount: Number(atLeast[1]),
      });
    }

    const atMost =
      t.match(/\bat\s+most\s+(\d+)\b/) ??
      t.match(/\bno\s+more\s+than\s+(\d+)\b/);
    if (atMost) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "deliver_rule",
        targetAction: "deliver",
        polarity: "must",
        maxCount: Number(atMost[1]),
      });
    }

    const moreLess = t.match(/\bmore\s+than\s+(\d+)\b[\s\S]*\bless\s+than\s+(\d+)\b/);
    if (moreLess) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "deliver_rule",
        targetAction: "deliver",
        polarity: "must",
        minExclusiveCount: Number(moreLess[1]),
        maxExclusiveCount: Number(moreLess[2]),
      });
    }

    const moreThanPenalty = t.match(/\bmore\s+than\s+(\d+)\b/);
    if (moreThanPenalty && /\b(?:lose|penalty|penalties|penalized|negative|minus)\b|-/.test(t)) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "deliver_rule",
        targetAction: "deliver",
        polarity: "must",
        maxCount: Number(moreThanPenalty[1]),
      });
    }
  }

  // drop_rule on leftmost / rightmost region
  if (/\b(?:drop|deliver)\b/.test(t) && /\b(?:leftmost|left-most|rightmost|right-most)\b/.test(t)) {
    const loss = /\b(?:lose|penalt|negative|minus|-)\b/.test(t) || /-\s*\d+/.test(t);
    const amount = Number(t.match(/-?\d+/)?.[0]);
    return baseQuickSchema({
      category: loss ? "rule" : "goal",
      objectiveType: "drop_rule",
      targetAction: "deliver",
      polarity: loss ? "avoid" : "must",
      region: /\b(?:rightmost|right-most)\b/.test(t) ? "rightmost" : "leftmost",
      scoreEffect: {
        type: loss ? "loss" : "gain",
        amount: Number.isFinite(Math.abs(amount)) ? Math.abs(amount) : null,
        per: "delivery",
      },
    });
  }

  // drop_rule on current tile
  if (/\bdrop\b/.test(t) && /\b(?:right\s+now|now|current\s+tile|tile\s+you\s+are\s+on|where\s+you\s+are)\b/.test(t)) {
    const amount = Number(
      t.match(/(?:get|win|gain)\s+(\d+)\s*points?/i)?.[1] ??
      t.match(/(?:get|win|gain)\s+\+?(\d+)/i)?.[2]
    );
    return baseQuickSchema({
      category: "goal",
      objectiveType: "drop_rule",
      targetAction: "deliver",
      polarity: "must",
      scoreEffect: {
        type: "gain",
        amount: Number.isFinite(amount) ? amount : null,
        per: "delivery",
      },
    });
  }

  // delivery_zone_rule
  if (/\bdeliver\b/.test(t) && coords.length > 0 && /\b(?:pts|points|reward|\dx)\b/.test(t)) {
    const multiplier = Number(t.match(/(\d+(?:\.\d+)?)\s*x\b/i)?.[1]);
    if (Number.isFinite(multiplier)) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "delivery_zone_rule",
        targetAction: "deliver",
        targetTiles: coords,
        rewardMultiplier: multiplier,
      });
    }
    if (/\b0\s*(?:pts|points|reward)\b|\bno\s+reward\b/.test(t)) {
      return baseQuickSchema({
        category: "rule",
        objectiveType: "delivery_zone_rule",
        targetAction: "deliver",
        targetTiles: coords,
        rewardOverride: 0,
      });
    }
  }

  // delivery_value_constraint
  if (/\bdeliver\b/.test(t) && /\b(?:score|reward|value|points?)\b/.test(t)) {
    const thresholdMatch =
      t.match(/\b(?:higher|greater|above|over|at\s+least|minimum|min)\s+than\s+(\d+)\b/) ??
      t.match(/\b(?:higher|greater|above|over|at\s+least|minimum|min)\s+(\d+)\b/);
    if (thresholdMatch) {
      const noReward = /\bno\s+reward\b|\b0\s*(?:pts|points)\b/.test(t);
      return baseQuickSchema({
        category: "rule",
        objectiveType: "delivery_value_constraint",
        targetAction: "deliver",
        valueThreshold: Number(thresholdMatch[1]),
        rewardMultiplier: 0,
        polarity: noReward ? "avoid" : "must",
      });
    }
  }

  // avoid_tile
  if (/\b(?:do\s+not|don't|avoid)\b[\s\S]*\b(?:go|pass|move|walk)\b/.test(t) && coords.length > 0) {
    const amount = Number(
      t.match(/(?:lose|minus|-)\s*(\d+)\s*points?/i)?.[1] ??
      t.match(/(-\d+)\s*points?/i)?.[2]
    );
    return baseQuickSchema({
      category: "rule",
      objectiveType: "avoid_tile",
      polarity: "avoid",
      targetTiles: coords,
      scoreEffect: {
        type: "loss",
        amount: Number.isFinite(amount) ? amount : null,
        per: null,
      },
    });
  }

  return null;
}

export async function classifyMissionSchema({ callModel, missionText, currentState }) {
  const raw = String(missionText ?? "").trim();
  const route = quickMissionRoute(raw);

  const emptySchema = (overrides = {}) => ({
    category: "ignore",
    objectiveType: "custom",
    targetAction: null,
    polarity: null,
    exactCount: null,
    minCount: null,
    maxCount: null,
    minExclusiveCount: null,
    maxExclusiveCount: null,
    durationMs: null,
    scoreEffect: null,
    targetPosition: null,
    targetTiles: null,
    rewardMultiplier: null,
    rewardOverride: null,
    valueThreshold: null,
    radius: null,
    requiresCoordination: false,
    persistentUntilCancelled: false,
    replyToSender: false,
    rowParity: null,
    region: null,
    ...overrides,
  });

  if (route.kind === "ignore") {
    return emptySchema({ confidence: 1, explanation: "Empty message" });
  }

  if (route.kind === "end") {
    return emptySchema({ category: "end", confidence: 1, explanation: "Explicit end/cancel message" });
  }

  if (route.kind === "quiz") {
    return emptySchema({
      category: "quiz",
      scoreEffect: route.negative ? { type: "loss", amount: null, per: "answer" } : null,
      replyToSender: true,
      confidence: 0.9,
      explanation: route.reason,
    });
  }

  const quickSchema = quickMissionSchema(raw);
  if (quickSchema) return repairMissionSchema(validateMissionSchema(quickSchema), raw);

  const schema = await interpretMissionWithLLM({
    callModel,
    missionText: raw,
    currentState,
  });

  if (!schema) {
    return emptySchema({ confidence: 0, explanation: "Failed to parse mission schema" });
  }

  if (!schema.durationMs) {
    const fallbackDuration = parseMissionDurationMs(raw);
    if (fallbackDuration) schema.durationMs = fallbackDuration;
  }

  return repairMissionSchema(schema, raw);
}

export function buildMissionRecordFromSchema(missionText, schema, now = Date.now()) {
  if (!schema) return null;
  if (!(schema.category === "rule" || schema.category === "goal")) return null;

  const objectiveType = canonicalObjectiveType(schema.objectiveType);

  const mission = {
    id: now + Math.floor(Math.random() * 1000),
    signature: missionSignature(missionText),
    text: String(missionText ?? ""),
    accepted: true,
    status: "active",
    kind: schema.category === "rule" ? "persistent_rule" : "achievement_once",
    objectiveType,
    policy: {},
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    completedAt: null,
  };

  if (schema.durationMs && schema.durationMs > 0) {
    const until = now + schema.durationMs;
    mission.expiresAt = until;

    if (objectiveType === "wait" || objectiveType === "traffic_light_wait") {
      mission.policy.wait = mission.policy.wait || {};
      mission.policy.wait.until = until;
    }
  }

  if (objectiveType === "move_to" && schema.targetPosition) {
    mission.policy.moveTo = {
      target: { x: schema.targetPosition.x, y: schema.targetPosition.y },
      radius: Number.isFinite(schema.radius) ? schema.radius : 0,
    };
  }

  if (objectiveType === "wait") {
    mission.policy.wait = mission.policy.wait || {};
    mission.policy.wait.enabled = true;
  }

  if (
    objectiveType === "deliver_rule" &&
    (
      Number.isFinite(schema.exactCount) ||
      Number.isFinite(schema.minCount) ||
      Number.isFinite(schema.maxCount) ||
      Number.isFinite(schema.minExclusiveCount) ||
      Number.isFinite(schema.maxExclusiveCount)
    )
  ) {
    mission.policy.delivery = {
      exactCount:        Number.isFinite(schema.exactCount)        ? schema.exactCount        : null,
      minCount:          Number.isFinite(schema.minCount)          ? schema.minCount          : null,
      maxCount:          Number.isFinite(schema.maxCount)          ? schema.maxCount          : null,
      minExclusiveCount: Number.isFinite(schema.minExclusiveCount) ? schema.minExclusiveCount : null,
      maxExclusiveCount: Number.isFinite(schema.maxExclusiveCount) ? schema.maxExclusiveCount : null,
      rewardMultiplier:  Number.isFinite(schema.rewardMultiplier)  ? schema.rewardMultiplier  : null,
    };
    // derive pickup carry cap from delivery constraint
    if (Number.isFinite(schema.exactCount) && schema.exactCount > 0) {
      mission.policy.pickup = { maxCarry: schema.exactCount };
    } else if (Number.isFinite(schema.maxCount) && schema.maxCount > 0) {
      mission.policy.pickup = { maxCarry: schema.maxCount };
    }
  }

  if (objectiveType === "pickup_rule") {
    const hasCount =
      Number.isFinite(schema.maxCount) ||
      Number.isFinite(schema.exactCount) ||
      Number.isFinite(schema.minCount);

    if (hasCount) {
      mission.policy.pickup = {
        enabled:    true,
        maxCarry:   Number.isFinite(schema.maxCount)   ? schema.maxCount   : null,
        exactCarry: Number.isFinite(schema.exactCount) ? schema.exactCount : null,
        minCarry:   Number.isFinite(schema.minCount)   ? schema.minCount   : null,
      };
    } else {
      // no count specified -> treat as a full pickup ban
      mission.policy.avoidPickup = true;
    }
  }

  if (objectiveType === "drop_rule") {
    // const targetTiles =
    //to solve leftmost problem
    const explicitTargetTiles =
      schema.targetTiles ??
      (schema.targetPosition
        ? [schema.targetPosition]
        : (
          /\b(?:right\s+now|now|current\s+tile|tile\s+you\s+are\s+on|where\s+you\s+are)\b/i.test(String(missionText ?? "")) &&
          W.me
            ? [{ x: Math.round(Number(W.me.x)), y: Math.round(Number(W.me.y)) }]
            : null
        ));

    //to solve leftmost problem
    const regionTiles = explicitTargetTiles?.length
      ? explicitTargetTiles
      : deliveryTilesForRegion(schema.region);
    //to solve leftmost problem
    const targetTiles = Array.isArray(regionTiles) && regionTiles.length > 0
      ? regionTiles.map((t) => ({ x: Number(t.x), y: Number(t.y) }))
      : null;

    mission.policy.dropRule = {
      region: schema.region ?? null,
      targetTiles,
      scoreEffect: schema.scoreEffect ?? null,
    };

    if (targetTiles?.length && schema.scoreEffect?.type === "gain") {
      mission.policy.delivery = mission.policy.delivery || {};
      mission.policy.delivery.preferredTiles = targetTiles.map((t) => ({ x: t.x, y: t.y }));
    }
  }

  if (objectiveType === "delivery_zone_rule" && schema.targetTiles?.length) {
    mission.policy.delivery = mission.policy.delivery || {};

    if (Number.isFinite(schema.rewardMultiplier)) {
      mission.policy.delivery.multipliers = schema.targetTiles.map((t) => ({
        x: t.x,
        y: t.y,
        multiplier: schema.rewardMultiplier,
      }));
    }

    if (Number.isFinite(schema.rewardOverride) && schema.rewardOverride === 0) {
      mission.policy.delivery.zeroRewardTiles = schema.targetTiles.map((t) => ({
        x: t.x,
        y: t.y,
      }));
    }
  }

  if (objectiveType === "delivery_value_constraint" && Number.isFinite(schema.valueThreshold)) {
    mission.policy.delivery = mission.policy.delivery || {};
    const text = String(missionText ?? "").toLowerCase();
    const requiresHighValue =
      /\b(?:score|reward|value|points?)\b/.test(text) &&
      /\b(?:higher|greater|above|over|at\s+least|minimum|min)\b/.test(text) &&
      (/\bonly\b/.test(text) || /\b(?:otherwise|negative|penalt|lose)\b/.test(text)) &&
      !/\bno\s+reward\b/.test(text);

    if (requiresHighValue) {
      mission.policy.delivery.minParcelScore = schema.valueThreshold;
    } else {
      mission.policy.delivery.maxParcelScore = schema.valueThreshold;
    }
    mission.policy.delivery.rewardMultiplier =
      Number.isFinite(schema.rewardMultiplier) ? schema.rewardMultiplier : 0;
  }

  if (objectiveType === "avoid_tile" && schema.targetTiles?.length) {
    mission.policy.avoidTiles = {
      tiles: schema.targetTiles.map((t) => ({ x: t.x, y: t.y })),
      penalty: Number.isFinite(schema.scoreEffect?.amount) ? schema.scoreEffect.amount : 0,
    };
  }

  if (objectiveType === "avoid_pickup") {
    mission.policy.avoidPickup = true;
  }

  if (objectiveType === "avoid_delivery") {
    mission.policy.avoidDelivery = true;
  }

  if (objectiveType === "meet_teammate") {
    mission.policy.meetTeammate = {
      target: schema.targetPosition ?? null,
      radius: Number.isFinite(schema.radius) ? schema.radius : 3,
      bonus: schema.scoreEffect?.amount ?? null,
      requiresCoordination: !!schema.requiresCoordination,
    };
  }

  if (objectiveType === "handoff_bonus") {
    mission.policy.handoffBonus = {
      bonus: schema.scoreEffect?.amount ?? null,
      requiresCoordination: !!schema.requiresCoordination,
    };
  }

  if (objectiveType === "traffic_light_wait") {
    mission.policy.trafficLight = {
      rowParity: schema.rowParity ?? "odd",
      persistentUntilCancelled: !!schema.persistentUntilCancelled,
    };
  }

  if (schema.scoreEffect) {
    mission.policy.scoreEffect = schema.scoreEffect;

    if (
      schema.scoreEffect.type === "loss" &&
      schema.scoreEffect.per === "pickup" &&
      Number.isFinite(schema.scoreEffect.amount)
    ) {
      mission.policy.penalty = {
        type: "pickup",
        lossPerParcel: schema.scoreEffect.amount,
      };
    }
  }

  mission.policy.requiresCoordination = !!schema.requiresCoordination;
  mission.policy.persistentUntilCancelled = !!schema.persistentUntilCancelled;

  return mission;
}

export function addMission(collectionName, mission) {
  if (!Array.isArray(W[collectionName])) {
    W[collectionName] = [];
  }

  const arr = W[collectionName];
  const existing = arr.find(
    (m) => m?.status === "active" && m.signature === mission.signature
  );

  if (existing) {
    existing.text = mission.text;
    existing.updatedAt = Date.now();
    existing.objectiveType = mission.objectiveType;
    existing.kind = mission.kind;
    existing.policy = mission.policy;
    existing.expiresAt = mission.expiresAt ?? existing.expiresAt ?? null;
    console.log('[MISSION] Updated existing mission in', collectionName, existing.signature, existing.policy);
    return existing;
  }

  arr.push(mission);
  console.log('[MISSION] Added mission to', collectionName, mission.signature, mission.policy);
  return mission;
}

export function getMissionPolicy() {
  const constraints = currentMissionConstraints();
  const waitAction = missionNextAction();
  const blocking = currentBlockingMission();

  const exactDeliveryCount = constraints.exactDeliverCount;
  const carrying = W.carrying?.size ?? 0;

  // needsMorePickup: true when the agent must accumulate more parcels before delivering
  const needsMorePickup = (() => {
    if (Number.isFinite(exactDeliveryCount) && carrying < exactDeliveryCount) return true;
    const minC = constraints.minDeliverCount;
    const minE = constraints.minExclusiveDeliverCount;
    const maxC = constraints.maxDeliverCount;
    const maxE = constraints.maxExclusiveDeliverCount;
    if (Number.isFinite(minC) && carrying < minC) return true;
    if (Number.isFinite(minE) && carrying <= minE) return true;
    if (Number.isFinite(maxC) && carrying < maxC) return true;
    if (Number.isFinite(maxE) && carrying < maxE - 1) return true;
    return false;
  })();

  // forceDelivery: true when the agent MUST deliver now
  const forceDelivery = (() => {
    if (Number.isFinite(exactDeliveryCount) && carrying >= exactDeliveryCount) return true;
    const maxC = constraints.maxDeliverCount;
    const maxE = constraints.maxExclusiveDeliverCount;
    if (Number.isFinite(maxC) && carrying >= maxC) return true;
    if (Number.isFinite(maxE) && carrying >= maxE - 1) return true;
    return false;
  })();

  // Effective pickup cap: from deliver_rule OR pickup_rule, whichever is more restrictive
  const maxCarry = (() => {
    const deliverMission = currentDeliverRuleMission();
    const pickupMission = currentPickupRuleMission();
    const deliverCap = Number(deliverMission?.policy?.pickup?.maxCarry ?? Infinity);
    const pickupCap = Number(
      pickupMission?.policy?.pickup?.maxCarry ??
      pickupMission?.policy?.pickup?.exactCarry ??
      Infinity
    );
    const effective = Math.min(deliverCap, pickupCap);
    return Number.isFinite(effective) ? effective : null;
  })();

  return {
    mode: waitAction?.type === "WAIT" ? "WAIT" : "NORMAL_PLAY",
    missionId: waitAction?.missionId ?? blocking?.id ?? null,
    missionSignature: blocking?.signature ?? null,
    blockingText: blocking?.text ?? "None",

    avoidPickup: !!constraints.avoidPickup,
    avoidDelivery: !!constraints.avoidDelivery,

    maxCarry,

    exactDeliveryCount,
    minDeliveryCount: constraints.minDeliverCount,
    maxDeliveryCount: constraints.maxDeliverCount,
    minExclusiveDeliveryCount: constraints.minExclusiveDeliverCount,
    maxExclusiveDeliveryCount: constraints.maxExclusiveDeliverCount,

    needsMorePickup,
    forceDelivery,

    moveTo: constraints.moveTo ?? null,
    trafficLight: constraints.trafficLight ?? null,
    avoidTiles: constraints.avoidTiles ?? [],
    preferredDeliveryTiles: constraints.preferredDeliveryTiles ?? [],
    zeroRewardDeliveryTiles: constraints.zeroRewardDeliveryTiles ?? [],
    forbiddenDeliveryTiles: constraints.forbiddenDeliveryTiles ?? [],
    deliveryMultipliers: constraints.deliveryMultipliers ?? [],
    minAllowedParcelScore: constraints.minAllowedParcelScore ?? null,
    maxAllowedParcelScore: constraints.maxAllowedParcelScore ?? null,
    meetTarget: constraints.meetTarget ?? null,
    meetRadius: constraints.meetRadius ?? null,
    //leftmost problem
    dropRule: constraints.dropRule ?? null,
    handoffBonus: constraints.handoffBonus ?? null,
  };
}

function shouldIgnoreQuizSchema(schema, missionText) {
  if (!schema || schema.category !== "quiz") return false;
  if (schema.scoreEffect?.type === "loss") return true;

  const t = String(missionText ?? "").toLowerCase();
  if (/\blose\b/.test(t) || /\bpenalt(y|ies)?\b/.test(t)) return true;

  return false;
}

async function answerQuizFast(callModel, missionText, currentState) {
  const local = parseQuickMathAnswer(missionText);
  if (local != null) return local;

  const quizQuestion = extractQuizQuestion(missionText);

  const raw = await callModel(
    [
      {
        role: "system",
        content:
          'You are answering a DeliverooJS quiz. Reply with ONLY the raw answer text. If unsure, give your best short answer. Never include "Thought:", "Action:", or "Final Answer:".',
      },
      {
        role: "user",
        content: `Question: ${quizQuestion}\nCurrent state: ${currentState ?? "n/a"}`,
      },
    ],
    { temperature: 0 }
  );

  const answer = String(raw ?? "").trim();
  if (!answer) return null;

  return answer
    .replace(/^final answer:\s*/i, "")
    .replace(/^answer:\s*/i, "")
    .trim();
}

async function identifyCancelTarget(callModel, missionText, active) {
  const list = active.map((m, i) => `${i}: "${m.text}"`).join("\n");

  const raw = await callModel(
    [
      {
        role: "system",
        content:
          'Identify which mission is being cancelled. Reply ONLY with JSON: {"index": <number>} for a specific one, or {"index":"all"}. No other text.',
      },
      {
        role: "user",
        content: `Active missions:\n${list}\n\nCancellation message: "${missionText}"`,
      },
    ],
    { temperature: 0 }
  );

  try {
    const m = raw?.match(/\{[\s\S]*?\}/);
    if (!m) return "all";
    const { index } = JSON.parse(m[0]);
    if (index === "all") return "all";
    const n = Number(index);
    return Number.isFinite(n) && n >= 0 && n < active.length
      ? active[n].signature
      : "all";
  } catch {
    return "all";
  }
}

export function cancelMissionBySignature(signature) {
  for (const mission of [...activeGoals(), ...activeRules()]) {
    if (mission?.signature === signature) {
      archiveMission(mission, "cancelled");
      break;
    }
  }
  W.activeGoals = activeGoals().filter((m) => m?.status === "active");
  W.activeRules = activeRules().filter((m) => m?.status === "active");
}

export async function handleTrustedMissionMessage({
  callModel,
  runCoordinationCycle,
  missionText,
  replyCallback,
  senderId,
  socket,
}) {
  pruneExpiredMissions();

  const currentState = `Position: x=${W.me?.x}, y=${W.me?.y} | Score: ${W.me?.score}`;
  const schema = await classifyMissionSchema({
    callModel,
    missionText,
    currentState,
  });

  console.log("[MISSION] Interpreted schema:", schema);

  if (schema.category === "end") {
    const active = activeMissions();

    if (active.length <= 1) {
      completeAllActiveMissions("cancelled");
      return;
    }

    const cancelTarget = await identifyCancelTarget(callModel, missionText, active);

    if (!cancelTarget || cancelTarget === "all") {
      completeAllActiveMissions("cancelled");
    } else {
      cancelMissionBySignature(cancelTarget);
    }
    return;
  }

  if (schema.category === "rule" || schema.category === "goal") {
    const mission = buildMissionRecordFromSchema(missionText, schema, Date.now());

    if (mission) {
      const storedMission =
        mission.kind === "persistent_rule"
          ? addMission("activeRules", mission)
          : addMission("activeGoals", mission);

      const receivedTarget = schema.targetPosition ?? schema.targetTiles ?? null;
      const storedTarget =
        storedMission?.policy?.moveTo?.target ??
        storedMission?.policy?.dropRule?.targetTiles ??
        storedMission?.policy?.delivery?.preferredTiles ??
        null;

      console.log("[MISSION] Target check:", JSON.stringify({
        receivedTarget,
        storedTarget,
      }));

      console.log(
        mission.kind === "persistent_rule"
          ? "[MISSION] Activated persistent rule:"
          : "[MISSION] Activated temporary goal:",
        storedMission
      );
    }

    console.log("[MISSION] Behavior mission stored; no reply needed.");
    return;
  }

  if (schema.category === "ignore") {
    console.log("[MISSION] Schema category=ignore -> no reply, no mission.");
    return;
  }

  if (schema.category === "quiz") {
    if (shouldIgnoreQuizSchema(schema, missionText)) {
      console.log("[MISSION] Quiz ignored due to penalty/negative value.");
      return;
    }

    try {
      let answer = await answerQuizFast(callModel, missionText, currentState);

      if (!answer) {
        const prompt = `
You are playing DeliverooJS.

The server sent a QUIZ or question:

"${missionText}"

Your current state is: ${currentState}.

If answering can give positive points without obvious penalty, answer with the RAW answer only.
If it looks like a trick or penalty, answer "IGNORE".

Format:
Thought: <reasoning>
Final Answer: <answer>
`.trim();

        const result = await runCoordinationCycle(missionText, {
          maxIterations: 2,
          systemPrompt: prompt,
        });

        if (!result?.success) {
          console.log("[MISSION] Quiz evaluation failed.");
          return;
        }

        answer = String(result.answer ?? "").trim();
      }

      if (!answer || /^ignore$/i.test(answer)) {
        console.log("[MISSION] Quiz reply ignored.");
        return;
      }

      console.log(`[MISSION] Replying to server with quiz answer: ${answer}`);
      if (replyCallback) {
        try {
          await replyCallback(answer);
        } catch (e) {
          console.error("[MISSION] Failed to reply:", e);
        }
      } else if (socket?.say) {
        await socket.say(senderId, answer);
      }
    } catch (error) {
      console.error("[MISSION] Quiz handling failed:", error);
    }

    return;
  }
}