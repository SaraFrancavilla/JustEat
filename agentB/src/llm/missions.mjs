import { W } from "../world/state.js";

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

// traffic-light waits are released only by explicit "go" signals
export function isTrafficLightReleaseMessage(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    /\bgreen\s*light\b/.test(t) ||
    /\blight('?s| is| turn(?:ed|s)?)?\s+green\b/.test(t) ||
    /\bgo\s+ahead\b/.test(t) ||
    /\byou\s+(?:can|may)\s+(?:go|move|proceed)\b/.test(t) ||
    /\bproceed\b/.test(t) ||
    /\bclear\s+to\s+(?:go|proceed|move)\b/.test(t) ||
    /\ball\s+clear\b/.test(t) ||
    /^\s*go\s*!?\s*$/.test(t)
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

// canonicalize objective names before internal comparisons
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
  if (type === "wait")               return 100;
  // coordination must take priority over ordinary count/value rules
  if (type === "traffic_light_wait") return 95;
  if (type === "meet_teammate")      return 90;
  if (type === "deliver_rule")       return 80;
  if (type === "pickup_rule")        return 75;
  if (type === "move_to")            return 60;
  if (type === "avoid_tile")         return 50;
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

// active pickup rule with the smallest carry cap
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
    console.log(`[MISSION] Mission ${reason}:`, mission.text);
  }
  for (const mission of activeRules()) {
    archiveMission(mission, reason);
    console.log(`[MISSION] Mission ${reason}:`, mission.text);
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
      console.log("[MISSION] Expired mission completed:", mission.text);
    }
  }

  for (const mission of activeRules()) {
    if (mission?.status !== "active") continue;
    const until = Number(mission?.policy?.wait?.until ?? mission?.expiresAt ?? 0);
    if (until && now >= until) {
      archiveMission(mission, "completed");
      console.log("[MISSION] Expired mission completed:", mission.text);
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
  const maxAllowedTotalScoreValues = missions
    .map((m) => Number(m?.policy?.delivery?.maxTotalScore))
    .filter((n) => Number.isFinite(n));
  const minAllowedTotalScoreValues = missions
    .map((m) => Number(m?.policy?.delivery?.minTotalScore))
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
    maxAllowedTotalScore:
      maxAllowedTotalScoreValues.length > 0
        ? Math.min(...maxAllowedTotalScoreValues)
        : null,
    minAllowedTotalScore:
      minAllowedTotalScoreValues.length > 0
        ? Math.max(...minAllowedTotalScoreValues)
        : null,

    meetTarget: blocking?.policy?.meetTeammate?.target ?? null,
    meetRadius: blocking?.policy?.meetTeammate?.radius ?? null,
    meetRow: blocking?.policy?.meetTeammate?.row ?? null,
    meetColumn: blocking?.policy?.meetTeammate?.column ?? null,
    // handoff is opportunistic, so keep it visible beside blocking missions
    handoffBonus:
      missions.find((m) => canonicalObjectiveType(m?.objectiveType) === "handoff_bonus")?.policy?.handoffBonus ?? null,
    // keep drop rules available even when another mission is blocking
    dropRule:
      blocking?.policy?.dropRule ??
      missions.find((m) => canonicalObjectiveType(m?.objectiveType) === "drop_rule")?.policy?.dropRule ??
      // synthesize a drop rule for score-constrained delivery logic
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

    // persistent rules stay active for the whole session
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

// complete meet missions only after both agents are in range and A confirms
export function completeMeetTeammateMissionsIfSatisfied(position = W.me) {
  if (!position) return false;
  let completed = false;

  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "meet_teammate") continue;
    const meet = mission?.policy?.meetTeammate ?? null;
    const target = meet?.target ?? null;
    const row = Number.isFinite(meet?.row) ? Number(meet.row) : null;
    const column = Number.isFinite(meet?.column) ? Number(meet.column) : null;
    if (!target && row === null && column === null) continue;

    const radius = Math.max(0, Number(meet?.radius ?? 3));

    const teammateStatus = (W.coordinationStatuses ?? []).find(
      (s) => s?.missionId === mission.id && ["arrived", "waiting"].includes(String(s?.status ?? ""))
    );
    if (!teammateStatus) continue;

    if (target) {
      const targetDx = Math.abs(Number(position.x) - Number(target.x));
      const targetDy = Math.abs(Number(position.y) - Number(target.y));
      const nearTarget = targetDx + targetDy <= radius;

      // prefer pairwise distance; the shared target is only a rendezvous area
      let nearTeammate = false;
      if (teammateStatus.position) {
        const pairDx = Math.abs(Number(position.x) - Number(teammateStatus.position.x));
        const pairDy = Math.abs(Number(position.y) - Number(teammateStatus.position.y));
        nearTeammate = pairDx + pairDy <= radius;
      }

      if (!nearTarget && !nearTeammate) continue;
    } else {
      // row/column missions require matching the row or column exactly
      if (row !== null && Number(position.y) !== row) continue;
      if (column !== null && Number(position.x) !== column) continue;
    }

    archiveMission(mission, "completed");
    completed = true;
    const where = target ? `(${Number(target.x)},${Number(target.y)})` : `row/column ${row ?? column}`;
    console.log(
      `[MISSION] Meet-teammate mission completed: both agents met around ${where} (${mission.text})`,
      teammateStatus.position ? { me: position, teammate: teammateStatus.position } : ""
    );
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

    const rule = mission?.policy?.dropRule ?? {};
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

// one-time handoff missions complete after a confirmed handoff
export function completeHandoffBonusMissionsIfSatisfied() {
  let completed = false;

  for (const mission of activeMissions()) {
    if (canonicalObjectiveType(mission?.objectiveType) !== "handoff_bonus") continue;
    if (mission?.kind !== "achievement_once") continue;

    archiveMission(mission, "completed");
    completed = true;
    console.log(`[MISSION] Handoff mission completed: (${mission.text})`);
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
  const targetRow = toNonNegativeInt(obj.targetRow);
  const targetColumn = toNonNegativeInt(obj.targetColumn);
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
    targetRow,
    targetColumn,
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

  // pickup count-rule repair
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

  // delivery count-rule repair
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
  "targetRow": number | null,
  "targetColumn": number | null,
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
- "Only deliver parcels with a score higher than 15, otherwise you get negative points" => category "rule", objectiveType "delivery_value_constraint", targetAction "deliver", valueThreshold 15, rewardMultiplier 0. This constrains EACH parcel individually.
- "If you deliver parcels with a score higher than 10, you get no reward" => category "rule", objectiveType "delivery_value_constraint", targetAction "deliver", valueThreshold 10, rewardMultiplier 0. This constrains EACH parcel individually.
- "Only deliver with a total score below 20" => category "rule", objectiveType "delivery_value_constraint", targetAction "deliver", valueThreshold 20, rewardMultiplier 0. The word "total" means this constrains the SUM of every parcel delivered together, not each parcel individually - a very different rule from the previous two examples.
- "Do not go through tile 4,7 otherwise you lose 50 points" => category "rule", objectiveType "avoid_tile", polarity "avoid", targetTiles [{ "x": 4, "y": 7 }], scoreEffect { "type": "loss", "amount": 50, "per": null }.
- "Move both agents to the neighborhood of position 4,7 within a maximum distance of 3, and have them wait for each other. You will receive 500pts." => category "goal", objectiveType "meet_teammate", targetPosition { "x": 4, "y": 7 }, radius 3, requiresCoordination true, scoreEffect { "type": "gain", "amount": 500, "per": null }.
- "Go on row 10 with agent A" => category "goal", objectiveType "meet_teammate", targetRow 10, requiresCoordination true. Do NOT invent an x coordinate - only a row was given, so targetPosition stays null.
- "Both agents move to column 5 and meet there" => category "goal", objectiveType "meet_teammate", targetColumn 5, requiresCoordination true.
- Any instruction naming both/each agent, "with agent A/B", or "together" for a movement goal implies requiresCoordination true, even if the message never says "wait for each other".
- "If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a 200 points bonus." => category "rule", objectiveType "handoff_bonus", requiresCoordination true, persistentUntilCancelled true, scoreEffect { "type": "gain", "amount": 200, "per": "delivery" }. This is phrased as a standing condition ("if... you will receive") that applies to every parcel for the rest of the match, so it is a persistent rule.
- "Agent B hand off a parcel to agent A and agent A must deliver it" => category "goal", objectiveType "handoff_bonus", requiresCoordination true, persistentUntilCancelled false. This is a direct one-time instruction ("a parcel", singular, no "if"/"every time"/reward-per-occurrence framing) to do ONE handoff, not a standing rule that should keep firing for the rest of the match - use category "goal" (not "rule") for it, exactly like a one-time meet_teammate.
- Any instruction where one agent picks up/hands off a parcel and the OTHER agent delivers it is handoff_bonus, never meet_teammate - meet_teammate is only for both agents converging on a shared point/row/column, it has nothing to do with transferring a parcel between them.
- For handoff_bonus specifically: use persistentUntilCancelled true (category "rule") ONLY when the message describes a standing, repeatable condition - "if/whenever/every time a parcel is handed off, you get N points". Use persistentUntilCancelled false (category "goal") for a direct one-time command to hand off "a parcel" - the difference matters, since a rule keeps firing for every future handoff for the rest of the match, while a goal is satisfied and stops after the first one.
- "All agents must move to an odd-numbered row and wait for our message before moving again, as in a red light green light game. 700 points bonus." => category "rule", objectiveType "traffic_light_wait", rowParity "odd", requiresCoordination true, persistentUntilCancelled true, scoreEffect { "type": "gain", "amount": 700, "per": null }.
- "All agents must move to row 10 and wait for the green light" => category "rule", objectiveType "traffic_light_wait", targetRow 10, requiresCoordination true, persistentUntilCancelled true. This gives an EXACT row, not a parity - do not set rowParity, and do NOT invent an x coordinate.
- Any exact row/column number given for a movement rule/goal must go in targetRow/targetColumn, never targetPosition - targetPosition is only for a full, explicit (x,y) pair.
- "AgentB, for 50 points, move to the rightmost row and wait for the green light" => category "rule", objectiveType "traffic_light_wait", region "rightmost", requiresCoordination false, persistentUntilCancelled true, scoreEffect { "type": "gain", "amount": 50, "per": null }. Two things matter here: "rightmost"/"leftmost" is a map-edge region, not a row/column number or parity, so it goes in the region field. And the message names only "AgentB" specifically, never says "all agents" or "both agents" - so this applies to that one agent alone, requiresCoordination is false, and it must NOT be relayed to the other agent.
- "Move to tile (11,21) to get 100 points and wait for the green light" => category "rule", objectiveType "traffic_light_wait", targetPosition { "x": 11, "y": 21 }, requiresCoordination false, persistentUntilCancelled true, scoreEffect { "type": "gain", "amount": 100, "per": null }. An explicit (x,y) point (not a row/column/parity/region) combined with a wait-for-signal clause is still traffic_light_wait - use targetPosition for the point. Do NOT classify this as plain move_to, which completes and releases the instant the tile is touched instead of actually waiting for the signal.
- ANY movement instruction (to a point, row, column, or region) that also tells the agent to wait afterward is objectiveType "traffic_light_wait" with persistentUntilCancelled true, never plain "move_to" - regardless of the exact wording of the wait clause: "and wait", "then wait", "wait there", "wait for the green light", "wait for a signal", "wait for our message" all mean the same thing (arrive, then hold position instead of resuming normal play immediately). Only use "move_to" when there is no wait/hold clause at all.
- If CURRENT STATE below shows an ACTIVE WAIT, this new message is very likely about releasing it, even when it doesn't literally say "green light" - judge it by meaning, not exact phrasing ("go ahead", "you're clear", "proceed now", "it's safe to move" all mean the same thing as a green light). If it plausibly signals the agent may resume moving, classify it as category "end" regardless of how it's worded. Only classify it as a new goal/rule instead if it clearly describes a distinct new instruction unrelated to ending the wait.
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

  const reward = classifyQuizReward(raw);
  const looksNegative = reward.decision === "negative";

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

function classifyQuizReward(text) {
  const t = String(text ?? "").toLowerCase();

  const negativePatterns = [
    /\bfor\s*-\s*\d+\b/,
    /\bworth\s*-\s*\d+\b/,
    /\b-\s*\d+\s*(?:pts?|points?)?\b/,
    /\bminus\s+\d+\b/,
    /\bnegative\s+\d+\b/,
    /\blose\b/,
    /\bloss\b/,
    /\bpenalt(?:y|ies|ized|ise|ize)?\b/,
    /\bdecreas(?:e|es|ed|ing)\b/,
    /\bsubtract(?:s|ed|ing)?\b/,
    /\btake\s+away\b/,
    /\bcosts?\b/,
    /\byou\s+will\s+lose\b/,
  ];

  const positivePatterns = [
    /\bfor\s*\+?\s*\d+\b/,
    /\bworth\s*\+?\s*\d+\b/,
    /\b\+\s*\d+\s*(?:pts?|points?)?\b/,
    /\bwin\s+\d+\b/,
    /\bgain\s+\d+\b/,
    /\bget\s+\d+\b/,
    /\breceive\s+\d+\b/,
    /\bearn\s+\d+\b/,
    /\bbonus\b/,
  ];

  if (negativePatterns.some((re) => re.test(t))) {
    return { decision: "negative", source: "local" };
  }

  if (positivePatterns.some((re) => re.test(t))) {
    return { decision: "positive", source: "local" };
  }

  return { decision: "unknown", source: "local" };
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
    targetRow: null,
    targetColumn: null,
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

// true when the message addresses one specific agent by name ("AgentB,
// move to...") rather than both ("all agents"/"both agents"/"each agent").
// traffic_light_wait can legitimately be aimed at a single agent, unlike
// meet_teammate/handoff_bonus which always need both regardless of wording
function impliesSingleAgentAddressed(text) {
  const namesOneAgent = /\bagent\s*[ab]\b/i.test(text);
  const impliesAll = /\ball\s+agents?\b|\bboth\s+agents?\b|\beach\s+agent\b/i.test(text);
  return namesOneAgent && !impliesAll;
}

function quickMissionSchema(rawText) {
  const raw = String(rawText ?? "").trim();
  const t = raw.toLowerCase();
  if (!raw) return null;

  const durationMs = parseMissionDurationMs(raw);
  const coords = extractCoordinatePairs(raw);

  // wait
  if (/\bwait\b/.test(t) && durationMs) {
    const reward = classifyQuizReward(raw);
    if (reward.decision === "negative") {
      return baseQuickSchema({
        category: "ignore",
        confidence: 1,
        explanation: "negative-wait-reward",
      });
    }

    return baseQuickSchema({
      category: "goal",
      objectiveType: "wait",
      durationMs,
      confidence: 1,
    });
  }

  // leave compound move-and-wait messages to the full classifier
  const moveMatch = !/\bwait\b/.test(t)
    ? t.match(
        /\b(?:go|move|walk|reach)\s+(?:on|to|towards|at)?\s*(?:tile|position)?\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?/i
      )
    : null;
  if (moveMatch) {
    return baseQuickSchema({
      category: "goal",
      objectiveType: "move_to",
      targetPosition: { x: Number(moveMatch[1]), y: Number(moveMatch[2]) },
      radius: 0,
    });
  }

  // handoff_bonus: one agent picks up/hands off a parcel, the other
  // delivers it - distinct from meet_teammate, which is about a shared
  // point, not transferring a parcel. "if/whenever/every time... you get N
  // points" is a standing rule; a direct command ("hand off a parcel") is
  // a one-time goal, done after the first successful handoff
  if (
    /\bhand(?:s|ed)?[\s-]?off\b/i.test(t) ||
    (/\b(?:one|other|each)\s+agent\b/i.test(t) && /\bpick(?:s|ed)?\s*up\b/i.test(t) && /\bdeliver/i.test(t))
  ) {
    const isOngoingRule =
      /\bif\b/i.test(t) ||
      /\bevery\s*time\b|\beach\s*time\b|\bwhenever\b/i.test(t) ||
      /\bpoints?\s*bonus\b|\byou\s+will\s+receive\b|\byou(?:'ll| will)?\s+get\b/i.test(t);
    return baseQuickSchema({
      category: isOngoingRule ? "rule" : "goal",
      objectiveType: "handoff_bonus",
      requiresCoordination: true,
      persistentUntilCancelled: isOngoingRule,
    });
  }

  // meet_teammate: "Move both agents to the neighborhood of position (x,y)
  // within a maximum distance of 3, and have them wait for each other."
  if (/\bwait\s+for\s+each\s+other\b/.test(t) && coords.length > 0) {
    const distanceMatch =
      t.match(/\b(?:maximum\s+)?distance\s+of\s+(\d+)/i) ??
      t.match(/\bwithin\s+(\d+)\b/i);
    return baseQuickSchema({
      category: "goal",
      objectiveType: "meet_teammate",
      targetPosition: coords[0],
      radius: distanceMatch ? Number(distanceMatch[1]) : 3,
      requiresCoordination: true,
    });
  }

  // meet_teammate on an exact row/column: "Go on row 10 with agent A" -
  // distinct from traffic_light_wait's odd/even parity below
  const rowMatch = t.match(/\brow\s+(\d+)\b/i);
  const columnMatch = t.match(/\bcolumn\s+(\d+)\b/i);
  const impliesTeammate = /\bwith\s+agent\b|\btogether\b|\bboth\s+agents?\b|\beach\s+other\b/i.test(t);
  if ((rowMatch || columnMatch) && impliesTeammate) {
    return baseQuickSchema({
      category: "goal",
      objectiveType: "meet_teammate",
      targetRow: rowMatch ? Number(rowMatch[1]) : null,
      targetColumn: columnMatch ? Number(columnMatch[1]) : null,
      requiresCoordination: true,
    });
  }

  // traffic_light_wait: "All agents must move to an odd-numbered row and
  // wait for our message before moving again, as in a red light green light game."
  if (/\b(odd|even)[\s-]*numbered\s+row\b/i.test(t) && /\bwait\b/.test(t)) {
    const parity = /\bodd\b/i.test(t) ? "odd" : "even";
    return baseQuickSchema({
      category: "rule",
      objectiveType: "traffic_light_wait",
      rowParity: parity,
      requiresCoordination: !impliesSingleAgentAddressed(t),
      persistentUntilCancelled: true,
    });
  }

  // traffic_light_wait on an exact row/column: "All agents must move to
  // row 10 and wait for the green light" - no "with agent"/"together"
  // framing (that's the meet_teammate case above), just a plain freeze-in-place
  if ((rowMatch || columnMatch) && /\bwait\b/.test(t)) {
    return baseQuickSchema({
      category: "rule",
      objectiveType: "traffic_light_wait",
      targetRow: rowMatch ? Number(rowMatch[1]) : null,
      targetColumn: columnMatch ? Number(columnMatch[1]) : null,
      requiresCoordination: !impliesSingleAgentAddressed(t),
      persistentUntilCancelled: true,
    });
  }

  // traffic_light_wait on a region edge: "move to the rightmost row and
  // wait for the green light" - resolved against the known map live at
  // execution time (see extremeKnownColumn in mainLoop.js), not here
  const regionMatch = /\b(leftmost|left-most|rightmost|right-most)\b/i.test(t);
  if (regionMatch && /\bwait\b/.test(t)) {
    return baseQuickSchema({
      category: "rule",
      objectiveType: "traffic_light_wait",
      region: /\bleft/i.test(t) ? "leftmost" : "rightmost",
      requiresCoordination: !impliesSingleAgentAddressed(t),
      persistentUntilCancelled: true,
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
    targetRow: null,
    targetColumn: null,
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
    const minCount = Number.isFinite(schema.minCount) ? schema.minCount : null;
    const maxExclusiveCount =
      Number.isFinite(schema.maxExclusiveCount) &&
      !(Number.isFinite(minCount) && schema.maxExclusiveCount <= minCount)
        ? schema.maxExclusiveCount
        : null;

    mission.policy.delivery = {
      exactCount:        Number.isFinite(schema.exactCount)        ? schema.exactCount        : null,
      minCount,
      maxCount:          Number.isFinite(schema.maxCount)          ? schema.maxCount          : null,
      minExclusiveCount: Number.isFinite(schema.minExclusiveCount) ? schema.minExclusiveCount : null,
      maxExclusiveCount,
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

    // resolve leftmost/rightmost delivery regions lazily as the map expands
    const targetTiles = explicitTargetTiles?.length
      ? explicitTargetTiles.map((t) => ({ x: Number(t.x), y: Number(t.y) }))
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
    // "only deliver with a score below 20" constrains each parcel
    // individually, "...a total score below 20" constrains the sum - the
    // former lets you deliver four 18-point parcels (72 total), the latter
    // forbids it. detected from the original wording since it's independent
    // of quick-regex vs full LLM parsing
    const isTotalScope = /\btotal\b|\bcombined\b|\baltogether\b|\ball\s+together\b|\bsum\b/.test(text);

    if (isTotalScope) {
      if (requiresHighValue) {
        mission.policy.delivery.minTotalScore = schema.valueThreshold;
      } else {
        mission.policy.delivery.maxTotalScore = schema.valueThreshold;
      }
    } else if (requiresHighValue) {
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
      row: Number.isFinite(schema.targetRow) ? schema.targetRow : null,
      column: Number.isFinite(schema.targetColumn) ? schema.targetColumn : null,
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
    const row = Number.isFinite(schema.targetRow) ? schema.targetRow : null;
    const column = Number.isFinite(schema.targetColumn) ? schema.targetColumn : null;
    const regionRaw = String(schema.region ?? "").trim().toLowerCase();
    // resolve leftmost/rightmost lazily against the explored map
    const region =
      regionRaw.includes("rightmost") || regionRaw.includes("right-most")
        ? "rightmost"
        : regionRaw.includes("leftmost") || regionRaw.includes("left-most")
        ? "leftmost"
        : null;
    // explicit rendezvous points take priority over row/parity constraints
    const target = schema.targetPosition ?? null;
    // no radius means an exact tile, matching plain move_to semantics
    const radius = target ? (Number.isFinite(schema.radius) ? schema.radius : 0) : null;
    const hasExplicitTarget = !!target || row !== null || column !== null || !!region;
    mission.policy.trafficLight = {
      // parity is only a fallback when no exact row/column/region is given
      rowParity: !hasExplicitTarget ? (schema.rowParity ?? "odd") : (schema.rowParity ?? null),
      row,
      column,
      region,
      target,
      radius,
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

  // true when the agent must collect more before delivering
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

  // true when the agent must deliver now
  const forceDelivery = (() => {
    if (Number.isFinite(exactDeliveryCount) && carrying >= exactDeliveryCount) return true;
    const maxC = constraints.maxDeliverCount;
    const maxE = constraints.maxExclusiveDeliverCount;
    if (Number.isFinite(maxC) && carrying >= maxC) return true;
    if (Number.isFinite(maxE) && carrying >= maxE - 1) return true;
    return false;
  })();

  // strictest pickup cap across delivery and pickup rules
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

  // coordination is checked across all active missions, not just the blocker
  const coordinationRequired = activeMissions().some(
    (m) => m?.policy?.requiresCoordination || m?.policy?.meetTeammate || m?.policy?.handoffBonus
  );

  return {
    mode: waitAction?.type === "WAIT" ? "WAIT" : "NORMAL_PLAY",
    missionId: waitAction?.missionId ?? blocking?.id ?? null,
    missionSignature: blocking?.signature ?? null,
    blockingText: blocking?.text ?? "None",
    coordinationRequired,

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
    minAllowedTotalScore: constraints.minAllowedTotalScore ?? null,
    maxAllowedTotalScore: constraints.maxAllowedTotalScore ?? null,
    meetTarget: constraints.meetTarget ?? null,
    meetRadius: constraints.meetRadius ?? null,
    meetRow: constraints.meetRow ?? null,
    meetColumn: constraints.meetColumn ?? null,
    dropRule: constraints.dropRule ?? null,
    handoffBonus: constraints.handoffBonus ?? null,
  };
}

function shouldIgnoreQuizSchema(schema, missionText) {
  if (!schema || schema.category !== "quiz") return false;
  if (schema.scoreEffect?.type === "loss") return true;

  const reward = classifyQuizReward(missionText);
  if (reward.decision === "negative") return true;

  return false;
}

function isUsefulAvoidanceSchema(schema) {
  if (!schema) return false;
  if (schema.polarity === "avoid") return true;
  return [
    "avoid_tile",
    "avoid_pickup",
    "avoid_delivery",
    "delivery_value_constraint",
  ].includes(canonicalObjectiveType(schema.objectiveType));
}

// movement commands with negative payoff are traps, not useful constraints
const MOVEMENT_COMMAND_OBJECTIVE_TYPES = new Set(["move_to", "traffic_light_wait", "meet_teammate"]);

function shouldIgnoreNegativeMissionSchema(schema, missionText) {
  if (!schema || !(schema.category === "goal" || schema.category === "rule")) return false;
  if (isUsefulAvoidanceSchema(schema)) return false;
  // passive negative constraints are kept so the agent can avoid them
  const isMovementCommand = MOVEMENT_COMMAND_OBJECTIVE_TYPES.has(canonicalObjectiveType(schema.objectiveType));
  if (schema.category === "rule" && !isMovementCommand) return false;

  const reward = classifyQuizReward(missionText);
  if (reward.decision === "negative") return true;

  if (schema.scoreEffect?.type === "loss") return true;

  return false;
}

async function judgeQuizRewardWithLLM(callModel, missionText) {
  const raw = await callModel(
    [
      {
        role: "system",
        content:
          'You decide whether answering a DeliverooJS quiz is beneficial. Reply ONLY JSON: {"decision":"answer"|"ignore","reason":"short"}. Choose "answer" only if the prompt clearly gives positive reward for answering. Choose "ignore" for negative reward, penalties, cost, or unclear reward.',
      },
      {
        role: "user",
        content: `Quiz prompt: ${missionText}`,
      },
    ],
    { temperature: 0 }
  );

  try {
    const match = raw?.match(/\{[\s\S]*?\}/);
    if (!match) return { decision: "ignore", reason: "no-json" };
    const parsed = JSON.parse(match[0]);
    return parsed?.decision === "answer"
      ? { decision: "answer", reason: parsed.reason ?? "llm" }
      : { decision: "ignore", reason: parsed?.reason ?? "llm" };
  } catch {
    return { decision: "ignore", reason: "parse-error" };
  }
}

async function shouldAnswerQuiz(callModel, schema, missionText) {
  if (!schema || schema.category !== "quiz") return false;
  if (shouldIgnoreQuizSchema(schema, missionText)) return false;

  const reward = classifyQuizReward(missionText);
  if (reward.decision === "positive") return true;
  if (reward.decision === "negative") return false;

  const judged = await judgeQuizRewardWithLLM(callModel, missionText);
  if (judged.decision !== "answer") {
    console.log("[MISSION] Quiz ignored by reward judge:", judged.reason);
    return false;
  }

  return true;
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
      console.log("[MISSION] Mission cancelled:", mission.text);
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

  // include active waits so the classifier can recognize release messages
  const activeTrafficLightWaits = activeMissions().filter(
    (m) => canonicalObjectiveType(m?.objectiveType) === "traffic_light_wait"
  );
  const activeWaitContext = activeTrafficLightWaits.length > 0
    ? ` | ACTIVE WAIT (not yet released): "${activeTrafficLightWaits.map((m) => m.text).join('", "')}"`
    : "";
  const currentState = `Position: x=${W.me?.x}, y=${W.me?.y} | Score: ${W.me?.score}${activeWaitContext}`;
  const schema = await classifyMissionSchema({
    callModel,
    missionText,
    currentState,
  });

  console.log("[MISSION] Interpreted schema:", schema);

  // traffic-light waits end only on explicit release or cancellation
  const releasedTrafficLight = isTrafficLightReleaseMessage(missionText)
    ? activeMissions().filter(
        (m) => canonicalObjectiveType(m?.objectiveType) === "traffic_light_wait"
      )
    : [];
  if (releasedTrafficLight.length > 0) {
    for (const mission of releasedTrafficLight) {
      archiveMission(mission, "completed");
      console.log("[MISSION] Traffic-light wait released by incoming message:", mission.text);
    }
    W.activeGoals = activeGoals().filter((m) => m?.status === "active");
    W.activeRules = activeRules().filter((m) => m?.status === "active");
  }

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
    if (shouldIgnoreNegativeMissionSchema(schema, missionText)) {
      console.log("[MISSION] Negative mission ignored:", missionText);
      return;
    }

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
    if (!(await shouldAnswerQuiz(callModel, schema, missionText))) {
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
