import { W, visitedSpawns, syncCaches, intention, clearIntention } from "./world/state.js";
import { isCrateMap, computeMapProfile, computeStrategy } from "./world/mapAnalysis.js";
import { proposeReactiveAction } from "./behavior/reactive.js";
import { executeActionIntent, waitAction } from "./behavior/actions.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import {
  deliberate,
  planPathToTarget,
  completeSpawnPatrol,
  getOldestUnseenSpawn,
  hasOpportunisticNearbyParcel,
  bestOpportunisticNearbyParcel,
} from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal } from "./world/helpers.js";
import { CFG, debug } from "./config.js";
import { key } from "./utils/math.js";
import {
  pruneExpiredMissions,
  processMissionQueue,
  getMissionPolicy,
  enqueueTrustedMissionMessage,
} from "./llm/missions.mjs";
import {
  callModel,
  runCoordinationCycle,
  LLMCoordinationAgent,
} from "./llm/agent.mjs";
import { coordination } from "./llm/tools.mjs";
import client from "./client.js";

let busy = false;

// LLM runtime state
let llmAgent = null;
let llmBusy = false;
let tickCounter = 0;

const LLM_COORDINATION_INTERVAL = 80;
const TEAMMATE_ID =
  process.env.TEAMMATE_ID ||
  process.argv.find((a) => a.startsWith("--teamId="))?.split("=")[1] ||
  null;

// Local retry tracking
let lastFailedTargetKey = null;
let failedTargetCount = 0;
let failedStepCount = 0;

// Vision radius
const SENSOR_RADIUS = 5;

// Map analysis
let map_analysis_done = false;
let last_branching_factor = 0;
let strategy_check_counter = 0;

function targetKey(target) {
  if (!target) return null;
  return `${Number(target.x)},${Number(target.y)}`;
}

function registerTargetFailure(target) {
  const k = targetKey(target);
  if (!k) return { targetFails: 0, stepFails: 0 };

  if (k === lastFailedTargetKey) {
    failedTargetCount += 1;
  } else {
    lastFailedTargetKey = k;
    failedTargetCount = 1;
  }

  failedStepCount += 1;
  return { targetFails: failedTargetCount, stepFails: failedStepCount };
}

function clearTargetFailureMemory(target = null) {
  if (!target) {
    lastFailedTargetKey = null;
    failedTargetCount = 0;
    failedStepCount = 0;
    return;
  }

  if (targetKey(target) === lastFailedTargetKey) {
    lastFailedTargetKey = null;
    failedTargetCount = 0;
    failedStepCount = 0;
  }
}

function currentPlanLooksCrateSensitive() {
  if (!Array.isArray(intention.path) || intention.path.length === 0) return false;
  if (!W.me) return false;

  let { x, y } = W.me;

  for (const dir of intention.path.slice(0, 3)) {
    const d = {
      up: { dx: 0, dy: 1 },
      down: { dx: 0, dy: -1 },
      left: { dx: -1, dy: 0 },
      right: { dx: 1, dy: 0 },
    }[dir];
    if (!d) continue;

    x += d.dx;
    y += d.dy;

    if (W.boxPos?.has(key(x, y))) return true;
  }
  return false;
}

function shouldRelaxFailureHandling() {
  return isCrateMap() && currentPlanLooksCrateSensitive();
}

function getLLMAgent() {
  if (!llmAgent && W.me) {
    llmAgent = new LLMCoordinationAgent(client);
  }
  return llmAgent;
}

function dist2(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function nearestDeliveryTarget() {
  if (!W.me || !Array.isArray(W.deliveryTiles) || W.deliveryTiles.length === 0) return null;

  let best = null;
  let bestD = Infinity;

  for (const t of W.deliveryTiles) {
    const d = dist2(W.me, t);
    if (d < bestD) {
      bestD = d;
      best = { x: t.x, y: t.y };
    }
  }
  return best;
}

function shouldPreferOpportunisticPickup(mission, next = null) {
  if (!next) return false;
  if (!["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(next.type)) return false;
  if (mission?.mode === "WAIT" || mission?.avoidPickup || mission?.forceDelivery) return false;

  const carrying = W.carrying?.size ?? 0;
  if (carrying >= (CFG.REACT_HARD_CARRY_LIMIT ?? 15)) return false;

  return hasOpportunisticNearbyParcel(mission);
}

function opportunisticPickupPlan(mission) {
  const parcel = bestOpportunisticNearbyParcel(mission);
  if (!parcel) return null;
  return { type: "PICKUP", target: { x: Number(parcel.x), y: Number(parcel.y) } };
}

function ensureMissionPlanConsistency(mission) {
  const missionId = mission?.missionId ?? null;
  const missionSignature = mission?.missionSignature ?? null;

  const changed =
    (missionId != null && W._lastMissionId !== missionId) ||
    (missionId == null && missionSignature && W._lastMissionSignature !== missionSignature);

  if (changed) {
    clearIntention();
    W._lastMissionId = missionId;
    W._lastMissionSignature = missionSignature;
    console.log("[MISSION] Cleared previous intention for mission replanning. id=", missionId);
  } else {
    if (missionId != null) W._lastMissionId = missionId;
    if (missionSignature) W._lastMissionSignature = missionSignature;
  }
}

function normalizeLLMPlan(plan, mission) {
  if (!plan?.objective) return null;

  if (plan.objective === "collect_parcel") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : null;
    if (!target) return null;

    if (plan.targetParcelId) {
      const parcel =
        W.parcels?.get?.(plan.targetParcelId) ??
        (Array.isArray(W.parcelList)
          ? W.parcelList.find((p) => p.id === plan.targetParcelId)
          : null);
      if (parcel?.carriedBy) return null;
    }
    return { type: "PICKUP", target };
  }

  if (plan.objective === "deliver_now") {
    let target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : nearestDeliveryTarget();

    if (!target) return null;

    const deliverPlan = { type: "DELIVER", target };
    return shouldPreferOpportunisticPickup(mission, deliverPlan)
      ? opportunisticPickupPlan(mission)
      : deliverPlan;
  }

  if (plan.objective === "explore") {
    const spawnTarget = getOldestUnseenSpawn();
    return spawnTarget
      ? { type: "PATROL", target: spawnTarget }
      : { type: "EXPLORE", target: null };
  }

  return null;
}

function consumeLLMPlan(mission) {
  if (mission?.mode === "WAIT") return null;

  while (coordination.pendingMessages.length > 0) {
    const msg = coordination.pendingMessages.shift();

    if (msg?.type !== "llm_plan") continue;

    console.log(`[LLM] Received plan from tool: ${msg.plan?.objective}`);
    const normalized = normalizeLLMPlan(msg.plan, mission);
    if (normalized) return normalized;
  }

  return null;
}

function maybeStartStrategyAnalysis() {
  if (map_analysis_done || !W.tiles || W.tiles.size === 0) return;

  strategy_check_counter++;

  if (strategy_check_counter % 50 !== 0) return;

  computeMapProfile();

  const current_bf = W.mapProfile?.avgBranchingFactor ?? 0;

  if (Math.abs(current_bf - last_branching_factor) < 0.15) {
    map_analysis_done = true;
    const strategy = computeStrategy();
    console.log("[STRATEGY] Map stabilized, strategy computed:", JSON.stringify(strategy));
  }

  last_branching_factor = current_bf;
}

function maybeTriggerLLMCoordination(mission) {
  if (!W.me || llmBusy || W.missionEvaluating || mission?.mode === "WAIT") return;

  const activeMissions = [...(W.activeGoals || []), ...(W.activeRules || [])];
  if (activeMissions.length === 0) return;

  tickCounter += 1;
  if (tickCounter % LLM_COORDINATION_INTERVAL !== 0) return;

  const agent = getLLMAgent();
  if (!agent) return;

  const missionTexts = activeMissions.map((m) => `- [${m.kind}] ${m.text}`).join("\n");

  const request = `
MISSION ALERT!
You have ${activeMissions.length} active missions/rules overlapping right now:
${missionTexts}

Use your tools to inspect the map, your state, and visible parcels.
Figure out the safest action that complies with all rules, then call \`send_plan_to_bdi\`.
  `.trim();

  llmBusy = true;
  console.log("[LLM] Waking up Mission Strategist. Missions active:", activeMissions.length);

  agent
    .coordinate(request)
    .catch((err) => console.error("[LLM] coordination error:", err))
    .finally(() => {
      llmBusy = false;
    });
}

function updateSpatialMemory() {
  if (!W.me || !W.spawnTiles) return;
  const now = Date.now();
  for (const t of W.spawnTiles) {
    if (Math.abs(W.me.x - t.x) + Math.abs(W.me.y - t.y) <= SENSOR_RADIUS) {
      visitedSpawns.set(`${t.x},${t.y}`, now);
    }
  }
}

function arbitratePlannedIntent(next, mission) {
  if (!mission) return next;
  if (mission.mode === "WAIT") return { type: "WAIT", target: null };
  if (mission.avoidPickup && next?.type === "PICKUP") return null;
  if (mission.avoidDelivery && next?.type === "DELIVER") return null;

  if (shouldPreferOpportunisticPickup(mission, next)) {
    const pickupPlan = opportunisticPickupPlan(mission);
    if (pickupPlan) return pickupPlan;
  }

  if (mission.forceDelivery && !mission.avoidDelivery) {
    const deliveryTarget = nearestDeliveryTarget();
    if (deliveryTarget) return { type: "DELIVER", target: deliveryTarget };
  }

  return next;
}

async function tryReactiveFollowup(mission) {
  let didAnything = false;
  for (let i = 0; i < 4; i++) {
    const intent = proposeReactiveAction(mission);
    if (!intent) break;
    const ok = await executeActionIntent(intent, mission);
    if (!ok) break;
    didAnything = true;
    syncCaches();
  }
  return didAnything;
}

export async function tick() {
  if (!W.me || busy || W.prevActionFinished === false) return;
  busy = true;

  try {
    await processMissionQueue();

    syncCaches();
    computeMapProfile();
    maybeStartStrategyAnalysis();
    updateSpatialMemory();
    pruneExpiredMissions();

    const mission = getMissionPolicy();
    ensureMissionPlanConsistency(mission);

    if (mission?.mode === "WAIT") {
      if (intention.type !== "WAIT") {
        clearIntention();
        intention.type = "WAIT";
        intention.target = null;
        intention.steps = 0;
        intention.path = [];
      }
      await executeActionIntent(waitAction("mission_wait"), mission);
      return;
    }

    if (await tryReactiveFollowup(mission)) {
      clearTargetFailureMemory();
      clearIntention();
      syncCaches();
    }

    if (intention.type === "PATROL" && intention.target) {
      const lastSeen = visitedSpawns.get(`${intention.target.x},${intention.target.y}`) || 0;
      if (
        (Date.now() - lastSeen) / 1000 < 1 &&
        !W.parcelList.some((p) => p.x === intention.target.x && p.y === intention.target.y)
      ) {
        clearIntention();
      }
    }

    if (["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(intention.type)) {
      if (shouldPreferOpportunisticPickup(mission, { type: intention.type })) {
        clearIntention();
      }
    }

    maybeTriggerLLMCoordination(mission);

    let next = consumeLLMPlan(mission) || deliberate(mission);
    next = arbitratePlannedIntent(next, mission) || { type: "EXPLORE", target: null };

    if (shouldPreferOpportunisticPickup(mission, next)) {
      const pickupPlan = opportunisticPickupPlan(mission);
      if (pickupPlan) next = pickupPlan;
    }

    const needNewPlan =
      !intention.type ||
      next.type !== intention.type ||
      !sameTarget(next.target, intention.target) ||
      intention.steps >= CFG.REPLAN_STEPS ||
      !Array.isArray(intention.path);

    if (needNewPlan) {
      let path = [];
      if (next.target) {
        path = planPathToTarget(next.target, {
          avoidTiles: mission?.movement?.avoidTiles ?? mission?.avoidTiles ?? [],
        });

        if (!path || (path.length === 0 && !samePos(W.me, next.target))) {
          if (!isCrateMap()) blacklistGoal(next.target);
          clearIntention();
          await fallbackMove(null);
          await tryReactiveFollowup(mission);
          return;
        }
      }

      intention.type = next.type;
      intention.target = next.target;
      intention.steps = 0;
      intention.path = path;
      clearTargetFailureMemory();
    }

    if (intention.target && samePos(W.me, intention.target)) {
      if (!(await tryReactiveFollowup(mission))) {
        if (W.tiles.get(key(W.me.x, W.me.y))?.delivery) blacklistGoal(intention.target);
        if (intention.type === "PATROL") completeSpawnPatrol();

        clearIntention();
        clearTargetFailureMemory(intention.target);
        await fallbackMove(null);
      }
      return;
    }

    intention.steps++;

    if (Array.isArray(intention.path) && intention.path.length > 0) {
      const dir = intention.path.shift();

      if (!(await tryMoveDir(dir))) {
        const { targetFails } = registerTargetFailure(intention.target);

        if (shouldRelaxFailureHandling()) {
          clearIntention();
        } else if (intention.target && targetFails >= 3) {
          blacklistGoal(intention.target);
          clearIntention();
        } else {
          intention.steps = 0;
        }

        await fallbackMove(intention.target);
        await tryReactiveFollowup(mission);
        return;
      }

      clearTargetFailureMemory(intention.target);
      await tryReactiveFollowup(mission);
      return;
    }

    await fallbackMove(next.target);
    await tryReactiveFollowup(mission);
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}

client.onMsg((id, name, msg, reply) => {
  const text = typeof msg === "string" ? msg : msg?.text;
  if (!text) return;

  console.log("[MSG] Received:", { id, name, text });

  enqueueTrustedMissionMessage({
    callModel,
    runCoordinationCycle,
    missionText: text,
    replyCallback: reply,
    senderId: id,
    socket: client,
  });
});