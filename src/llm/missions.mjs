import { W } from "../world/state.js";

const TRUSTED_SENDERS = (process.env.TRUSTED_SENDERS || "ChallengeGiver")
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
    /\bchallenge\s+cancelled\b/.test(t)
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

function missionPriority(mission) {
  if (!mission) return -Infinity;
  if (mission.objectiveType === "wait") return 100;
  if (mission.objectiveType === "deliver_rule") return 80;
  return 10;
}

export function currentDeliverRuleMission() {
  const candidates = activeMissions().filter(
    (m) => m?.objectiveType === "deliver_rule"
  );
  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    const an = Number(a?.policy?.delivery?.exactCount ?? Infinity);
    const bn = Number(b?.policy?.delivery?.exactCount ?? Infinity);
    return an - bn;
  })[0];
}

export function currentMissionExactCount() {
  const mission = currentDeliverRuleMission();
  const exact = Number(mission?.policy?.delivery?.exactCount);
  return Number.isFinite(exact) && exact > 0 ? exact : null;
}

export function currentCarryTarget() {
  return currentMissionExactCount() ?? Math.max(1, W.strategy?.carryTarget ?? 3);
}

export function missionNeedsMorePickup() {
  const exact = currentMissionExactCount();
  return Number.isFinite(exact) && carryingCount() < exact;
}

export function currentBlockingMission() {
  const missions = activeMissions();
  if (missions.length === 0) return null;
  return [...missions].sort(
    (a, b) => missionPriority(b) - missionPriority(a)
  )[0];
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
    (m) => m?.objectiveType === "wait"
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

  return totalMs > 0 ? totalMs : null;
}

export function currentMissionConstraints() {
  const missions = activeMissions();
  const blocking = currentBlockingMission();

  const maxAllowedParcelScoreValues = missions
    .map((m) => Number(m.policy?.delivery?.maxParcelScore))
    .filter((n) => Number.isFinite(n));

  return {
    mustWait: missions.some((m) => m.objectiveType === "wait"),
    avoidPickup: missions.some((m) => m.policy?.avoidPickup),
    avoidDelivery: missions.some((m) => m.policy?.avoidDelivery),

    exactDeliverCount: currentMissionExactCount(),
    minDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m.policy?.delivery?.minCount);
      return Number.isFinite(v) ? Math.max(acc ?? v, v) : acc;
    }, null),
    maxDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m.policy?.delivery?.maxCount);
      return Number.isFinite(v) ? Math.min(acc ?? v, v) : acc;
    }, null),
    minExclusiveDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m.policy?.delivery?.minExclusiveCount);
      return Number.isFinite(v) ? Math.max(acc ?? v, v) : acc;
    }, null),
    maxExclusiveDeliverCount: missions.reduce((acc, m) => {
      const v = Number(m.policy?.delivery?.maxExclusiveCount);
      return Number.isFinite(v) ? Math.min(acc ?? v, v) : acc;
    }, null),

    moveTo: blocking?.policy?.moveTo?.target ?? blocking?.policy?.moveTo ?? null,
    trafficLight: blocking?.policy?.trafficLight ?? null,
    avoidTiles: missions.flatMap((m) => m.policy?.avoidTiles?.tiles ?? []),
    preferredDeliveryTiles: missions.flatMap(
      (m) => m.policy?.delivery?.preferredTiles ?? []
    ),
    zeroRewardDeliveryTiles: missions.flatMap(
      (m) => m.policy?.delivery?.zeroRewardTiles ?? []
    ),
    forbiddenDeliveryTiles: missions.flatMap(
      (m) => m.policy?.delivery?.forbiddenTiles ?? []
    ),
    deliveryMultipliers: missions.flatMap(
      (m) => m.policy?.delivery?.multipliers ?? []
    ),
    maxAllowedParcelScore:
      maxAllowedParcelScoreValues.length > 0
        ? Math.min(...maxAllowedParcelScoreValues)
        : null,
    meetTarget: blocking?.policy?.meetTeammate?.target ?? null,
    meetRadius: blocking?.policy?.meetTeammate?.radius ?? null,
    handoffBonus: blocking?.policy?.handoffBonus ?? null,
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
    if (mission?.objectiveType !== "deliver_rule") continue;

    const exact = Number(mission?.policy?.delivery?.exactCount);
    if (!Number.isFinite(exact)) continue;

    if (carriedCountBeforeDrop === exact) {
      archiveMission(mission, "completed");
      W._lastMissionId = null;
      W._lastMissionSignature = null;
      console.log("[MISSION] Delivery mission completed:", mission.text);
    }
  }

  W.activeGoals = (W.activeGoals ?? []).filter((m) => m?.status === "active");
  W.activeRules = (W.activeRules ?? []).filter((m) => m?.status === "active");
}

function validateMissionSchema(obj) {
  if (!obj || typeof obj !== "object") return null;

  const category = obj.category;
  if (!["rule", "goal", "quiz", "end", "ignore"].includes(category)) {
    return null;
  }

  const allowedObjectiveTypes = [
    "move_to",
    "wait",
    "deliver_rule",
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
  ];

  const objectiveType = obj.objectiveType ?? "custom";
  if (!allowedObjectiveTypes.includes(objectiveType)) {
    return null;
  }

  const toNonNegativeInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const toNumber = (v) => {
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
    const per = ["pickup", "delivery", "answer", null].includes(
      obj.scoreEffect.per
    )
      ? obj.scoreEffect.per
      : null;
    scoreEffect = { type, amount, per };
  }

  const normPos = (p) => {
    if (!p || typeof p !== "object") return null;
    const x = toNumber(p.x);
    const y = toNumber(p.y);
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
  const rowParity = ["odd", "even"].includes(obj.rowParity)
    ? obj.rowParity
    : null;

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

export async function interpretMissionWithLLM({ callModel, missionText, currentState }) {
  const systemPrompt = `
  You are an arbiter for in-game missions in DeliverooJS.

  Convert a natural-language message into a STRICT JSON mission schema.

  THE GAME:
  - The agent moves on a grid, picks up parcels, delivers them for points.
  - The server may send temporary missions, rules, quizzes, or cancellations.
  - Messages can contain incentives and penalties.

  RETURN ONLY VALID JSON. Do not include markdown. Do not include explanation outside the JSON.
  If a field is unknown, use null.
  Do not invent constraints that are not explicitly supported by the message.

  SCHEMA:
  {
    "category": "rule" | "goal" | "quiz" | "end" | "ignore",
    "objectiveType": "move_to" | "wait" | "deliver_rule" | "drop_rule" | "delivery_zone_rule" | "delivery_value_constraint" | "avoid_tile" | "avoid_pickup" | "avoid_delivery" | "meet_teammate" | "handoff_bonus" | "traffic_light_wait" | "custom",
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
    "scoreEffect": {
      "type": "gain" | "loss" | "unknown",
      "amount": number | null,
      "per": "pickup" | "delivery" | "answer" | null
    } | null,
    "confidence": number,
    "explanation": string
  }

  COUNT INTERPRETATION RULES:
  - Use exactCount only for wording like "exactly", "only", "just", "one at a time", "deliver 2 at a time".
  - Use minCount for wording like "at least", "minimum", "2 or more", "no fewer than".
  - Use maxCount for wording like "at most", "maximum", "up to", "no more than".
  - Use minExclusiveCount for wording like "more than 2", "greater than 2".
  - Use maxExclusiveCount for wording like "less than 5", "fewer than 5".
  - If the message contains multiple count constraints, fill all applicable fields.
  - Never use exactCount to represent minimum or maximum.
  - If no count constraint is stated, all count fields must be null.

  INTERPRETATION RULES:
  - "From now on, only deliver 2 packages at a time" =>
    category="rule", objectiveType="deliver_rule", targetAction="deliver", polarity="must", exactCount=2.
  - "Deliver at least 2 packages at a time" =>
    category="rule", objectiveType="deliver_rule", targetAction="deliver", polarity="must", minCount=2.
  - "Deliver at most 5 packages at a time" =>
    category="rule", objectiveType="deliver_rule", targetAction="deliver", polarity="must", maxCount=5.
  - "Deliver more than 2 and less than 5 packages at a time" =>
    category="rule", objectiveType="deliver_rule", targetAction="deliver", polarity="must", minExclusiveCount=2, maxExclusiveCount=5.
  - "Wait for 10 seconds without moving" =>
    category="goal", objectiveType="wait", durationMs=10000.
  - "If you pick up any packages in the next 30 seconds you will lose 50 points for each package picked up" =>
    category="rule", objectiveType="avoid_pickup", targetAction="pickup", polarity="avoid", durationMs=30000,
    scoreEffect={ "type":"loss", "amount":50, "per":"pickup" }.
  - "Quiz: What is 2+2?" =>
    category="quiz", objectiveType="custom".
  - "Every time you deliver in (4,7) or (8,2) you get 5x pts" =>
    category="rule", objectiveType="delivery_zone_rule",
    targetAction="deliver", targetTiles=[{"x":4,"y":7},{"x":8,"y":2}],
    rewardMultiplier=5.
  - "Every time you deliver in (4,7) you get 0 pts" =>
    category="rule", objectiveType="delivery_zone_rule",
    targetAction="deliver", targetTiles=[{"x":4,"y":7}],
    rewardOverride=0.
  - "If you deliver parcels with a score higher than 10, you get no reward" =>
    category="rule", objectiveType="delivery_value_constraint",
    targetAction="deliver", valueThreshold=10, rewardMultiplier=0.
  - "Do not go through tile (4,7) otherwise you lose 50 points" =>
    category="rule", objectiveType="avoid_tile",
    polarity="avoid", targetTiles=[{"x":4,"y":7}],
    scoreEffect={"type":"loss","amount":50,"per":null}.
  - Clear mission cancellation or end messages =>
    category="end".

  Return ONLY the JSON object.
  `.trim();

  const userPrompt = `
  MESSAGE:
  "${missionText}"

  CURRENT STATE:
  ${currentState || "n/a"}
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
    /\bquiz\b/.test(t) ||
    /\bquestion\b/.test(t) ||
    /\bwhat\s+is\b/.test(t) ||
    /\bsolve\b/.test(t) ||
    /\banswer\b/.test(t) ||
    /\?\s*$/.test(raw);

  const looksNegative =
    /\blose\b/.test(t) ||
    /\bpenalt(y|ies)\b/.test(t) ||
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

export async function classifyMissionSchema({ callModel, missionText, currentState }) {
  const raw = String(missionText ?? "").trim();
  const route = quickMissionRoute(raw);

  if (route.kind === "ignore") {
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
      confidence: 1,
      explanation: "Empty message",
    };
  }

  if (route.kind === "end") {
    return {
      category: "end",
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
      confidence: 1,
      explanation: "Explicit end/cancel message",
    };
  }

  if (route.kind === "quiz") {
    return {
      category: "quiz",
      objectiveType: "custom",
      targetAction: null,
      polarity: null,
      exactCount: 0,
      minCount: null,
      maxCount: null,
      minExclusiveCount: null,
      maxExclusiveCount: null,
      durationMs: 0,
      scoreEffect: route.negative
        ? { type: "loss", amount: null, per: "answer" }
        : null,
      targetPosition: null,
      targetTiles: null,
      rewardMultiplier: null,
      rewardOverride: null,
      valueThreshold: null,
      radius: 0,
      requiresCoordination: false,
      persistentUntilCancelled: false,
      replyToSender: true,
      rowParity: null,
      region: null,
      confidence: 0.9,
      explanation: route.reason,
    };
  }

  const schema = await interpretMissionWithLLM({
    callModel,
    missionText: raw,
    currentState,
  });

  if (!schema) {
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
      confidence: 0,
      explanation: "Failed to parse mission schema",
    };
  }

  if (!schema.durationMs) {
    const fallbackDuration = parseMissionDurationMs(raw);
    if (fallbackDuration) schema.durationMs = fallbackDuration;
  }

  return schema;
}

export function buildMissionRecordFromSchema(missionText, schema, now = Date.now()) {
  if (!schema) return null;
  if (!(schema.category === "rule" || schema.category === "goal")) return null;

  const mission = {
    id: now + Math.floor(Math.random() * 1000),
    signature: missionSignature(missionText),
    text: String(missionText ?? ""),
    accepted: true,
    status: "active",
    kind: schema.category === "rule" ? "persistent_rule" : "achievement_once",
    objectiveType: schema.objectiveType || "custom",
    policy: {},
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    completedAt: null,
  };

  if (schema.durationMs && schema.durationMs > 0) {
    const until = now + schema.durationMs;
    mission.expiresAt = until;

    if (
      mission.objectiveType === "wait" ||
      mission.objectiveType === "traffic_light_wait"
    ) {
      mission.policy.wait = mission.policy.wait || {};
      mission.policy.wait.until = until;
    }
  }

  if (mission.objectiveType === "move_to" && schema.targetPosition) {
    mission.policy.moveTo = {
      target: { x: schema.targetPosition.x, y: schema.targetPosition.y },
      radius: Number.isFinite(schema.radius) ? schema.radius : 0,
    };
  }

  if (mission.objectiveType === "wait" && !mission.policy.wait) {
    mission.policy.wait = mission.policy.wait || {};
  }

  if (
    mission.objectiveType === "deliver_rule" &&
    (Number.isFinite(schema.exactCount) ||
      Number.isFinite(schema.minCount) ||
      Number.isFinite(schema.maxCount) ||
      Number.isFinite(schema.minExclusiveCount) ||
      Number.isFinite(schema.maxExclusiveCount))
  ) {
    mission.policy.delivery = {
      exactCount: Number.isFinite(schema.exactCount)
        ? schema.exactCount
        : null,
      minCount: Number.isFinite(schema.minCount) ? schema.minCount : null,
      maxCount: Number.isFinite(schema.maxCount) ? schema.maxCount : null,
      minExclusiveCount: Number.isFinite(schema.minExclusiveCount)
        ? schema.minExclusiveCount
        : null,
      maxExclusiveCount: Number.isFinite(schema.maxExclusiveCount)
        ? schema.maxExclusiveCount
        : null,
      rewardMultiplier: Number.isFinite(schema.rewardMultiplier)
        ? schema.rewardMultiplier
        : null,
    };

    if (Number.isFinite(schema.exactCount) && schema.exactCount > 0) {
      mission.policy.pickup = { maxCarry: schema.exactCount };
    }
  }

  if (mission.objectiveType === "drop_rule") {
    mission.policy.dropRule = {
      region: schema.region ?? null,
      targetTiles: schema.targetTiles ?? null,
      scoreEffect: schema.scoreEffect ?? null,
    };
  }

  if (
    mission.objectiveType === "delivery_zone_rule" &&
    schema.targetTiles?.length
  ) {
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

  if (
    mission.objectiveType === "delivery_value_constraint" &&
    Number.isFinite(schema.valueThreshold)
  ) {
    mission.policy.delivery = mission.policy.delivery || {};
    mission.policy.delivery.maxParcelScore = schema.valueThreshold;
    mission.policy.delivery.rewardMultiplier =
      Number.isFinite(schema.rewardMultiplier) ? schema.rewardMultiplier : 0;
  }

  if (mission.objectiveType === "avoid_tile" && schema.targetTiles?.length) {
    mission.policy.avoidTiles = {
      tiles: schema.targetTiles,
      penalty: Number.isFinite(schema.scoreEffect?.amount)
        ? schema.scoreEffect.amount
        : null,
    };
  }

  if (mission.objectiveType === "avoid_pickup") {
    mission.policy.avoidPickup = true;
  }

  if (mission.objectiveType === "avoid_delivery") {
    mission.policy.avoidDelivery = true;
  }

  if (mission.objectiveType === "meet_teammate") {
    mission.policy.meetTeammate = {
      target: schema.targetPosition ?? null,
      radius: Number.isFinite(schema.radius) ? schema.radius : 3,
      bonus: schema.scoreEffect?.amount ?? null,
      requiresCoordination: !!schema.requiresCoordination,
    };
  }

  if (mission.objectiveType === "handoff_bonus") {
    mission.policy.handoffBonus = {
      bonus: schema.scoreEffect?.amount ?? null,
      requiresCoordination: !!schema.requiresCoordination,
    };
  }

  if (mission.objectiveType === "traffic_light_wait") {
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

  return mission;
}

export function addMission(collectionName, mission) {
  if (!Array.isArray(W[collectionName])) {
    W[collectionName] = [];
  }

  const arr = W[collectionName];
  const existing = arr.find(
    (m) => m.status === "active" && m.signature === mission.signature
  );

  if (existing) {
    existing.text = mission.text;
    existing.updatedAt = Date.now();
    existing.objectiveType = mission.objectiveType;
    existing.kind = mission.kind;
    existing.policy = mission.policy;
    existing.expiresAt = mission.expiresAt ?? existing.expiresAt ?? null;
    return existing;
  }

  arr.push(mission);
  return mission;
}

export function getMissionPolicy() {
  const constraints = currentMissionConstraints();
  const waitAction = missionNextAction();
  const blocking = currentBlockingMission();

  const exactDeliveryCount = constraints.exactDeliverCount;
  const carrying = W.carrying?.size ?? 0;
  const needsMorePickup =
    Number.isFinite(exactDeliveryCount) && carrying < exactDeliveryCount;
  const forceDelivery =
    Number.isFinite(exactDeliveryCount) && carrying >= exactDeliveryCount;

  return {
    mode: waitAction?.type === "WAIT" ? "WAIT" : "NORMAL_PLAY",
    missionId: waitAction?.missionId ?? blocking?.id ?? null,
    missionSignature: blocking?.signature ?? null,
    blockingText: blocking?.text ?? "None",

    avoidPickup: !!constraints.avoidPickup,
    avoidDelivery: !!constraints.avoidDelivery,
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
    maxAllowedParcelScore: constraints.maxAllowedParcelScore ?? null,
    meetTarget: constraints.meetTarget ?? null,
    meetRadius: constraints.meetRadius ?? null,
    handoffBonus: constraints.handoffBonus ?? null,
  };
}

function shouldIgnoreQuizSchema(schema, missionText) {
  if (!schema || schema.category !== "quiz") return false;

  if (schema.scoreEffect?.type === "loss") return true;

  const t = String(missionText ?? "").toLowerCase();
  if (/\blose\b/.test(t) || /\bpenalt(y|ies)\b/.test(t)) return true;

  return false;
}

async function answerQuizFast({ callModel, missionText, currentState }) {
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
        content: `Question: ${quizQuestion}\nCurrent state: ${currentState || "n/a"}`,
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
    console.log("[MISSION] End/cancel schema -> completing all missions.");
    completeAllActiveMissions("cancelled");
    return;
  }

  if (schema.category === "rule" || schema.category === "goal") {
    const mission = buildMissionRecordFromSchema(missionText, schema, Date.now());

    if (mission) {
      const storedMission =
        mission.kind === "persistent_rule"
          ? addMission("activeRules", mission)
          : addMission("activeGoals", mission);

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
      let answer = await answerQuizFast({
        callModel,
        missionText,
        currentState,
      });

      if (!answer) {
        const prompt = `
  You are playing DeliverooJS.

  The server sent a QUIZ or question:

  "${missionText}"

  Your current state is: ${currentState}.

  If answering can give positive points without obvious penalty, answer with the RAW answer only.
  If it looks like a trick or penalty, answer "IGNORE".

  Format:
  Thought: <brief reasoning>
  Final Answer: <raw answer or IGNORE>
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
          replyCallback(answer);
        } catch (e) {
          console.error("[MISSION] Failed to reply:", e);
        }
      } else if (socket) {
        socket.say(senderId, answer);
      }
    } catch (error) {
      console.error("[MISSION] Quiz handling failed:", error);
    }

    return;
  }
}