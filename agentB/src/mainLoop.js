import { W, visitedSpawns, syncCaches, intention, clearIntention } from "./world/state.js";
import { isCrateMap, computeMapProfile, computeStrategy } from "./world/mapAnalysis.js";
import { proposeReactiveAction } from "./behavior/reactive.js";
import { executeActionIntent, waitAction, canDeliverNow } from "./behavior/actions.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import {
  deliberate,
  planPathToTarget,
  completeSpawnPatrol,
  getOldestUnseenSpawn,
  nearestDelivery,
  hasOpportunisticNearbyParcel,
  bestOpportunisticNearbyParcel,
  isMissionBlockingBaseline,
} from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal, carryingCount } from "./world/helpers.js";
import { CFG } from "./config.js";
import { key } from "./utils/math.js";
import {
  activeMissions,
  pruneExpiredMissions,
  processMissionQueue,
  getMissionPolicy,
  enqueueTrustedMissionMessage,
  completeWaitMissionsIfExpired,
  completeMoveToMissionsIfReached,
} from "./llm/missions.mjs";
import {
  normalizeMissionPolicy,
  missionNeedsMorePickup,
  deliveryMustHappenNow,
} from "./llm/mission-policies.js";
import { callModel, runCoordinationCycle, LLMCoordinationAgent } from "./llm/agent.mjs";
import { coordination } from "./llm/tools.mjs";
import { relayMissionPolicyToA } from "./coordination/outbox.js";
import { invalidatePDDLCache } from "./planning/pddlPlanner.js";
import { tickAgentABaseline } from "./baseline/agentABaselineTick.js";
import client from "./client.js";

let busy = false;
let llmAgent = null;
let llmBusy = false;
let missionQueueRunning = false;
let tickCounter = 0;

const LLM_COORDINATION_INTERVAL = 80;
const LLM_COORDINATION_TYPES = new Set(["coordination", "multiagent"]);
const SENSOR_RADIUS = 5;
const DELIVERY_REPLAN_BEFORE_BLACKLIST = 4;
const DELIVERY_STUCK_REPLAN_LIMIT = 3;

let mapAnalysisDone = false;
let lastBranchingFactor = 0;
let strategyCheckCounter = 0;
let lastFailedTargetKey = null;
let failedTargetCount = 0;
let failedStepCount = 0;
let lastStaleDeliverLogKey = null;
let lastStaleDeliverLogAt = 0;
let lastDeliveryStuckLogKey = null;
let lastDeliveryStuckLogAt = 0;

function targetKey(target) {
  if (!target) return null;
  return `${Number(target.x)},${Number(target.y)}`;
}

function registerTargetFailure(target) {
  const k = targetKey(target);
  if (!k) return { targetFails: 0, stepFails: 0 };
  if (k === lastFailedTargetKey) failedTargetCount += 1;
  else {
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
  let x = W.me.x;
  let y = W.me.y;
  for (const dir of intention.path.slice(0, 3)) {
    const d =
      dir === "up" ? { dx: 0, dy: 1 }
      : dir === "down" ? { dx: 0, dy: -1 }
      : dir === "left" ? { dx: -1, dy: 0 }
      : dir === "right" ? { dx: 1, dy: 0 }
      : null;
    if (!d) continue;
    x += d.dx;
    y += d.dy;
    if (W.boxPos?.has?.(key(x, y))) return true;
  }
  return false;
}

function shouldRelaxFailureHandling() {
  return isCrateMap() && currentPlanLooksCrateSensitive();
}

function getLLMAgent() {
  if (!llmAgent && W.me) llmAgent = new LLMCoordinationAgent(client);
  return llmAgent;
}

function missionDeliveryCarryTarget(policy) {
  const d = policy?.delivery ?? {};
  const p = policy?.pickup ?? {};
  if (Number.isFinite(p.exactCarry) && p.exactCarry > 0) return p.exactCarry;
  if (Number.isFinite(d.exactCount) && d.exactCount > 0) return d.exactCount;
  if (Number.isFinite(d.minCount) && d.minCount > 0) return d.minCount;
  if (Number.isFinite(d.minExclusiveCount) && d.minExclusiveCount >= 0) return d.minExclusiveCount + 1;
  if (Number.isFinite(d.maxCount) && d.maxCount > 0) return 1;
  if (Number.isFinite(d.maxExclusiveCount) && d.maxExclusiveCount > 1) return 1;
  return null;
}

function missionStillNeedsPickup(policy) {
  return missionNeedsMorePickup(policy, { carriedCount: carryingCount() });
}

function missionMustDeliverBeforePickup(policy) {
  const carried = carryingCount();
  if (carried === 0) return false;
  return deliveryMustHappenNow(policy, { carriedCount: carried });
}

function shouldPreferOpportunisticPickup(mission, next = null) {
  const policy = normalizeMissionPolicy(mission);
  const carried = carryingCount();
  const carryTarget = missionDeliveryCarryTarget(policy);

  if (Number.isFinite(carryTarget) && carried < carryTarget) {
    return hasOpportunisticNearbyParcel(mission);
  }

  if (!next) return false;
  if (!["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(next.type)) return false;

  if (isMissionBlockingBaseline(mission)) {
    return hasOpportunisticNearbyParcel(mission) && missionStillNeedsPickup(policy);
  }

  if (carried >= (CFG.REACT_HARD_CARRY_LIMIT ?? 15)) return false;
  return hasOpportunisticNearbyParcel(mission);
}

function opportunisticPickupPlan(mission) {
  const parcel = bestOpportunisticNearbyParcel(mission);
  if (!parcel) return null;
  return {
    type: "PICKUP",
    target: { x: Number(parcel.x), y: Number(parcel.y) },
    source: "opportunistic",
  };
}

function ensureMissionPlanConsistency(mission) {
  const policy = normalizeMissionPolicy(mission);
  const missionId = policy?.meta?.missionId ?? null;
  const missionSignature = policy?.meta?.missionSignature ?? null;
  const changed =
    (missionId !== null && W.lastMissionId !== missionId) ||
    (missionSignature !== null && W.lastMissionSignature !== missionSignature);

  if (changed) {
    clearIntention();
    invalidatePDDLCache?.();
    W.lastMissionId = missionId;
    W.lastMissionSignature = missionSignature;
    console.log("[MISSION] Cleared previous intention for mission replanning.", missionId);
  } else {
    if (missionId !== null) W.lastMissionId = missionId;
    if (missionSignature !== null) W.lastMissionSignature = missionSignature;
  }
}

function normalizeLLMPlan(plan, mission) {
  if (!plan) return null;

  if (["PICKUP", "DELIVER", "MOVE", "PATROL", "EXPLORE", "WAIT"].includes(plan.type)) {
    console.log(`[LLM] Plan type: ${plan.type}, target: {x: ${plan.target?.x}, y: ${plan.target?.y}}`);
    return { type: plan.type, target: plan.target ?? null, source: "llm" };
  }

  if (!plan.objective) return null;

  if (plan.objective === "collectparcel") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : null;
    if (!target) return null;
    if (plan.targetParcelId) {
      const parcel =
        W.parcels?.get?.(plan.targetParcelId) ??
        (Array.isArray(W.parcelList) ? W.parcelList.find((p) => p.id === plan.targetParcelId) : null);
      if (parcel?.carriedBy) return null;
    }
    return { type: "PICKUP", target, source: "llm" };
  }

  if (plan.objective === "delivernow") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : null;
    if (!target) return null;
    const deliverPlan = { type: "DELIVER", target, source: "llm" };
    return shouldPreferOpportunisticPickup(mission, deliverPlan)
      ? (opportunisticPickupPlan(mission) ?? deliverPlan)
      : deliverPlan;
  }

  if (plan.objective === "explore") {
    const spawnTarget = getOldestUnseenSpawn();
    return spawnTarget
      ? { type: "PATROL", target: spawnTarget, source: "llm" }
      : { type: "EXPLORE", target: null, source: "llm" };
  }

  if (plan.objective === "moveto") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : null;
    if (!target) return null;
    return { type: "MOVE", target, source: "llm" };
  }

  return null;
}

function consumeLLMPlan(mission) {
  const policy = normalizeMissionPolicy(mission);
  if (policy?.wait?.mustWait) return null;

  while (coordination.pendingMessages.length > 0) {
    const msg = coordination.pendingMessages.shift();
    if (msg?.type !== "llmplan") continue;
    console.log("[LLM] Received plan from tool:", JSON.stringify(msg.plan));
    const normalized = normalizeLLMPlan(msg.plan, mission);
    if (!normalized) continue;
    console.log("[LLM] Normalized plan:", normalized);
    return normalized;
  }
  return null;
}

function maybeStartStrategyAnalysis() {
  if (mapAnalysisDone || !W.tiles || W.tiles.size === 0) return;
  strategyCheckCounter += 1;
  if (strategyCheckCounter % 50 !== 0) return;

  computeMapProfile();
  const currentBF = W.mapProfile?.avgBranchingFactor ?? 0;
  if (Math.abs(currentBF - lastBranchingFactor) < 0.15) {
    mapAnalysisDone = true;
    const strategy = computeStrategy();
    if (strategy) {
      W.strategy = strategy;
      console.log("[STRATEGY] Map stabilized, strategy computed:", JSON.stringify(strategy));
    }
  }
  lastBranchingFactor = currentBF;
}

function maybeTriggerLLMCoordination(mission) {
  const policy = normalizeMissionPolicy(mission);
  if (!W.me || llmBusy || W.missionEvaluating || policy?.wait?.mustWait) return;

  const active = [...(W.activeGoals ?? []), ...(W.activeRules ?? [])]
    .filter((m) => m?.accepted && m?.status === "active");
  if (active.length === 0) return;

  const needsLLM = active.some(
    (m) => LLM_COORDINATION_TYPES.has(m?.objectiveType) && m?.policy?.requiresCoordination === true
  );
  if (!needsLLM) return;

  tickCounter += 1;
  if (tickCounter % LLM_COORDINATION_INTERVAL !== 0) return;

  const agent = getLLMAgent();
  if (!agent) return;

  const missionTexts = active.map((m) => `- [${m.kind}] ${m.text}`).join("\n");
  const request = `You are coordinating overlapping or special missions in DeliverooJS. You must output EXACTLY ONE of the following formats:
Action: sendplan_to_bdi
Action Input: {"objective":"collectparcel","targetPosition":{"x":X,"y":Y}}
Action: sendplan_to_bdi
Action Input: {"objective":"delivernow","targetPosition":{"x":X,"y":Y}}
Action: sendplan_to_bdi
Action Input: {"objective":"explore"}
Final Answer: NO_SAFE_PLAN

Current position: (${W.me.x}, ${W.me.y})
Carrying: ${W.carrying?.size ?? 0}
Active missions:
${missionTexts}`.trim();

  llmBusy = true;
  console.log("[LLM] Waking up Mission Strategist. Missions active:", active.length);
  agent.coordinate(request)
    .catch((err) => console.error("[LLM] coordination error", err))
    .finally(() => { llmBusy = false; });
}

function arbitratePlannedIntent(next, mission) {
  if (!next) return { type: "EXPLORE", target: null };

  const policy = normalizeMissionPolicy(mission);
  const missionBlocksBaseline = isMissionBlockingBaseline(mission);
  const carried = carryingCount();
  const carryTarget = missionDeliveryCarryTarget(policy);
  const stillNeedsPickup = Number.isFinite(carryTarget) && carried < carryTarget;
  const mustDeliverNow = missionMustDeliverBeforePickup(policy);

  if (policy?.wait?.mustWait) return { type: "WAIT", target: null };
  if (!missionBlocksBaseline) return next;

  if (stillNeedsPickup && next.type === "DELIVER") {
    const pickupPlan = opportunisticPickupPlan(mission);
    return pickupPlan ?? { type: "EXPLORE", target: null, source: "pickup-needed" };
  }

  if (mustDeliverNow && next.type === "PICKUP") {
    const target = nearestDelivery?.() ?? null;
    if (target) return { type: "DELIVER", target, source: "delivery-forced" };
  }

  if (next.type === "WAIT") return { type: "WAIT", target: null };
  if (["MOVE", "PATROL", "EXPLORE"].includes(next.type)) return next;

  if (next.source === "llm") {
    if (next.type === "PICKUP") {
      if (mustDeliverNow) {
        const target = nearestDelivery?.() ?? null;
        if (target) return { type: "DELIVER", target, source: "delivery-forced" };
      }
      if (policy?.pickup?.enabled === false) {
        if (policy?.movement?.moveTo) return { type: "MOVE", target: policy.movement.moveTo, source: "fallback" };
        if (policy?.movement?.meetTarget) return { type: "MOVE", target: policy.movement.meetTarget, source: "fallback" };
        return { type: "WAIT", target: null, source: "fallback" };
      }
      return next;
    }

    if (next.type === "DELIVER") {
      if (stillNeedsPickup) {
        const pickupPlan = opportunisticPickupPlan(mission);
        return pickupPlan ?? { type: "EXPLORE", target: null, source: "pickup-needed" };
      }
      if (policy?.delivery?.enabled === false) {
        if (policy?.movement?.moveTo) return { type: "MOVE", target: policy.movement.moveTo, source: "fallback" };
        if (policy?.movement?.meetTarget) return { type: "MOVE", target: policy.movement.meetTarget, source: "fallback" };
        return { type: "WAIT", target: null, source: "fallback" };
      }
      return next;
    }

    return next;
  }

  if (next.type === "PICKUP") {
    if (mustDeliverNow) {
      const target = nearestDelivery?.() ?? null;
      if (target) return { type: "DELIVER", target, source: "delivery-forced" };
    }
    if (policy?.pickup?.enabled === false) {
      if (policy?.movement?.moveTo) return { type: "MOVE", target: policy.movement.moveTo };
      if (policy?.movement?.meetTarget) return { type: "MOVE", target: policy.movement.meetTarget };
      return { type: "WAIT", target: null };
    }
  }

  if (next.type === "DELIVER") {
    if (stillNeedsPickup) {
      const pickupPlan = opportunisticPickupPlan(mission);
      return pickupPlan ?? { type: "EXPLORE", target: null, source: "pickup-needed" };
    }
    if (policy?.delivery?.enabled === false) {
      if (policy?.movement?.moveTo) return { type: "MOVE", target: policy.movement.moveTo };
      if (policy?.movement?.meetTarget) return { type: "MOVE", target: policy.movement.meetTarget };
      return { type: "WAIT", target: null };
    }
  }

  return next;
}

async function tryReactiveFollowup(mission) {
  let didAnything = false;
  for (let i = 0; i < 4; i += 1) {
    const intentNow = proposeReactiveAction(mission);
    if (!intentNow) break;
    const ok = await executeActionIntent(intentNow, mission);
    if (!ok) break;
    didAnything = true;
    syncCaches();
  }
  return didAnything;
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

async function maybeProcessMissionQueue() {
  if (missionQueueRunning || W.missionEvaluating) return false;
  if (!Array.isArray(W.missionQueue) || W.missionQueue.length === 0) return false;
  missionQueueRunning = true;
  try {
    await processMissionQueue();
  } catch (err) {
    console.error("[MISSION] queue processing error", err);
  } finally {
    missionQueueRunning = false;
  }
  return true;
}

function hasActiveMissionRecords() {
  return activeMissions().length > 0;
}

function hasPendingMissionWork() {
  return missionQueueRunning ||
    W.missionEvaluating ||
    (Array.isArray(W.missionQueue) && W.missionQueue.length > 0);
}

function maybeLogStaleDeliver(policy) {
  const carryingNow = carryingCount();
  const carryTarget = missionDeliveryCarryTarget(policy);
  if (!Number.isFinite(carryTarget) || carryingNow >= carryTarget) return;
  const k = `${carryingNow}/${carryTarget}`;
  const now = Date.now();
  if (k !== lastStaleDeliverLogKey || now - lastStaleDeliverLogAt > 1500) {
    console.warn("[DELIVER] Clearing stale DELIVER intention: carrying fewer parcels than required.", {
      carryingNow,
      carryTarget,
    });
    lastStaleDeliverLogKey = k;
    lastStaleDeliverLogAt = now;
  }
}

function maybeLogDeliveryStuck(target, reason, extra = null) {
  const k = `${reason}:${targetKey(target)}`;
  const now = Date.now();
  if (k !== lastDeliveryStuckLogKey || now - lastDeliveryStuckLogAt > 1500) {
    console.warn("[DELIVER] Replanning same delivery target.", { reason, target, ...(extra ?? {}) });
    lastDeliveryStuckLogKey = k;
    lastDeliveryStuckLogAt = now;
  }
}

function setIntentToTarget(type, target, policy) {
  intention.type = type;
  intention.target = target ?? null;
  intention.steps = 0;
  intention.path = target
    ? (planPathToTarget(target, {
        avoidTiles: policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? [],
      }) ?? [])
    : [];
}

function replanSameDeliveryTarget(policy) {
  if (!intention.target) return false;
  const target = { x: Number(intention.target.x), y: Number(intention.target.y) };
  clearIntention();
  setIntentToTarget("DELIVER", target, policy);
  return true;
}

function shouldForceFreshDeliveryPlan(policy) {
  if (intention.type !== "DELIVER") return false;
  const carried = carryingCount();
  if (!canDeliverNow(policy, carried)) return true;
  return false;
}

export async function tick() {
  if (!W.me || busy || W.prevActionFinished === false) return;
  busy = true;

  try {
    completeWaitMissionsIfExpired();
    pruneExpiredMissions();

    if (W.missionEvaluating || missionQueueRunning) {
      clearIntention();
      return;
    }

    if (Array.isArray(W.missionQueue) && W.missionQueue.length > 0) {
      clearIntention();
      clearTargetFailureMemory();
      await maybeProcessMissionQueue();
      completeWaitMissionsIfExpired();
      pruneExpiredMissions();
    }

    if (!hasActiveMissionRecords() && !hasPendingMissionWork()) {
      if (W.lastMissionId != null || W.lastMissionSignature != null) {
        clearIntention();
        clearTargetFailureMemory();
        W.lastMissionId = null;
        W.lastMissionSignature = null;
        invalidatePDDLCache?.();
      }
      await tickAgentABaseline();
      return;
    }

    syncCaches();
    computeMapProfile();
    maybeStartStrategyAnalysis();
    updateSpatialMemory();

    if (completeMoveToMissionsIfReached(W.me)) {
      clearIntention();
      clearTargetFailureMemory();
      invalidatePDDLCache?.();
    }

    if (!hasActiveMissionRecords()) {
      await tickAgentABaseline();
      return;
    }

    const mission = getMissionPolicy();
    const missionBlocksBaseline = isMissionBlockingBaseline(mission);
    const controlMission = missionBlocksBaseline ? mission : null;
    const policy = normalizeMissionPolicy(controlMission);

    if (missionBlocksBaseline) {
      ensureMissionPlanConsistency(mission);
      relayMissionPolicyToA?.(policy);
    } else if (W.lastMissionId != null || W.lastMissionSignature != null) {
      clearIntention();
      clearTargetFailureMemory();
      W.lastMissionId = null;
      W.lastMissionSignature = null;
      invalidatePDDLCache?.();
    }

    if (!missionBlocksBaseline) {
      await tickAgentABaseline();
      return;
    }

    if (policy?.wait?.mustWait) {
      if (intention.type !== "WAIT") clearIntention();
      intention.type = "WAIT";
      intention.target = null;
      intention.steps = 0;
      intention.path = [];
      const until = Number(policy?.wait?.until ?? 0);
      if (until && Date.now() >= until) {
        completeWaitMissionsIfExpired();
        clearIntention();
        clearTargetFailureMemory();
        invalidatePDDLCache?.();
      } else {
        await executeActionIntent(waitAction("mission_wait"), controlMission);
      }
      return;
    }

    const carryTarget = missionDeliveryCarryTarget(policy);
    const carryingNow = carryingCount();
    const stillNeedsPickup = Number.isFinite(carryTarget) && carryingNow < carryTarget;

    if (intention.type === "DELIVER" && stillNeedsPickup) {
      maybeLogStaleDeliver(policy);
      clearIntention();
    }

    if (shouldForceFreshDeliveryPlan(policy)) {
      maybeLogDeliveryStuck(intention.target, "delivery-no-longer-valid");
      clearIntention();
    }

    if (shouldPreferOpportunisticPickup(controlMission, intention)) {
      const pickupPlan = opportunisticPickupPlan(controlMission);
      if (pickupPlan) {
        clearIntention();
        setIntentToTarget(pickupPlan.type, pickupPlan.target, policy);
      }
    }

    if (await tryReactiveFollowup(controlMission)) {
      clearTargetFailureMemory();
      clearIntention();
      syncCaches();
      return;
    }

    if (intention.type === "PATROL" && intention.target) {
      const lastSeen = visitedSpawns.get(`${intention.target.x},${intention.target.y}`) ?? 0;
      if (
        Date.now() - lastSeen < 1000 &&
        !W.parcelList.some((p) => p.x === intention.target.x && p.y === intention.target.y)
      ) {
        clearIntention();
      }
    }

    if (["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(intention.type)) {
      if (shouldPreferOpportunisticPickup(controlMission, intention)) clearIntention();
    }

    maybeTriggerLLMCoordination(controlMission);
    const llmNext = missionBlocksBaseline ? consumeLLMPlan(controlMission) : null;
    let next = llmNext;
    if (!next) next = await deliberate(controlMission);
    next = arbitratePlannedIntent(next, controlMission) ?? { type: "WAIT", target: null };

    if (next.type === "DELIVER" && !canDeliverNow(policy, carryingCount())) {
      const pickupPlan = opportunisticPickupPlan(controlMission);
      next = pickupPlan ?? { type: "EXPLORE", target: null, source: "delivery-guard" };
    }

    if (!llmNext && shouldPreferOpportunisticPickup(controlMission, next)) {
      const pickupPlan = opportunisticPickupPlan(controlMission);
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
          avoidTiles: policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? [],
        }) ?? [];
      }

      if (next.target && path.length === 0 && !samePos(W.me, next.target)) {
        if (next.type === "DELIVER") {
          const { targetFails } = registerTargetFailure(next.target);
          if (targetFails >= DELIVERY_REPLAN_BEFORE_BLACKLIST) {
            console.warn("[DELIVER] No path to delivery target after repeated replans; blacklisting briefly.", next.target);
            blacklistGoal(next.target, 1500);
            clearIntention();
          } else {
            maybeLogDeliveryStuck(next.target, "no-path", { targetFails });
            clearIntention();
          }
        } else {
          if (!isCrateMap()) blacklistGoal(next.target);
          clearIntention();
        }
        await fallbackMove(next.target ?? null);
        await tryReactiveFollowup(controlMission);
        return;
      }

      //leftmost problem
      const wasReplanningFailedTarget =
        next.target &&
        lastFailedTargetKey &&
        targetKey(next.target) === lastFailedTargetKey;

      intention.type = next.type;
      intention.target = next.target ?? null;
      intention.steps = 0;
      intention.path = path;
      // clearTargetFailureMemory();ù
      // Keep the failure counter when we are replanning the same target that just
      // failed. Otherwise targetFails is reset to 1 forever and the delivery
      // fallback/temporary blacklist never activates.
      if (!wasReplanningFailedTarget) clearTargetFailureMemory();
    }

    if (intention.type === "DELIVER" && stillNeedsPickup) {
      maybeLogStaleDeliver(policy);
      clearIntention();
      const pickupPlan = opportunisticPickupPlan(controlMission);
      if (pickupPlan) setIntentToTarget(pickupPlan.type, pickupPlan.target, policy);
    }

    if (intention.target && samePos(W.me, intention.target)) {
      const reachedTarget = intention.target;
      const didReactive = await tryReactiveFollowup(controlMission);

      if (!didReactive) {
        if (W.tiles.get?.(key(W.me.x, W.me.y))?.delivery && intention.type === "DELIVER") {
          const { targetFails } = registerTargetFailure(intention.target);
          if (targetFails >= DELIVERY_STUCK_REPLAN_LIMIT) {
            console.warn("[DELIVER] Reached delivery tile repeatedly without successful putdown; blacklisting briefly.", intention.target);
            blacklistGoal(intention.target, 1500);
            clearIntention();
          } else {
            maybeLogDeliveryStuck(intention.target, "on-delivery-tile-no-putdown", { targetFails });
            clearIntention();
          }
        } else {
          if (intention.type === "PATROL") completeSpawnPatrol();
          clearIntention();
          clearTargetFailureMemory(reachedTarget);
        }
        await fallbackMove(reachedTarget ?? null);
      } else {
        clearTargetFailureMemory(reachedTarget);
      }
      return;
    }

    intention.steps += 1;

    if (Array.isArray(intention.path) && intention.path.length > 0) {
      const dir = intention.path.shift();
      if (!await tryMoveDir(dir)) {
        const { targetFails } = registerTargetFailure(intention.target);
        if (intention.type === "DELIVER" && intention.target) {
          if (targetFails >= DELIVERY_REPLAN_BEFORE_BLACKLIST) {
            console.warn("[DELIVER] Repeated movement failure while delivering; blacklisting target briefly.", intention.target);
            blacklistGoal(intention.target, 1500);
            clearIntention();
          } else {
            maybeLogDeliveryStuck(intention.target, "step-failed", { targetFails });
            clearIntention();
          }
        } else if (shouldRelaxFailureHandling()) {
          clearIntention();
        } else if (intention.target && targetFails >= 3) {
          blacklistGoal(intention.target);
          clearIntention();
        } else {
          intention.steps = 0;
        }
        await fallbackMove(intention.target);
        await tryReactiveFollowup(controlMission);
        return;
      }
    }

    clearTargetFailureMemory(intention.target);
    await tryReactiveFollowup(controlMission);

    if (completeMoveToMissionsIfReached(W.me)) {
      clearIntention();
      clearTargetFailureMemory();
      invalidatePDDLCache?.();
      return;
    }

    await fallbackMove(next.target);
    await tryReactiveFollowup(controlMission);
  } catch (err) {
    console.error("[B] tick error", err);
  } finally {
    busy = false;
  }
}

const TRUSTED_SENDER_NAMES = new Set(["ChallengeGiver", "Professor"]);

function isTrustedMissionSender(id, name) {
  return TRUSTED_SENDER_NAMES.has(String(name));
}

client.onMsg(async (id, name, msg, reply) => {
  console.log("[MSG]", id, name, msg, "hasReply", typeof reply === "function");
  if (!isTrustedMissionSender(id, name)) {
    console.log("[MSG] Message from untrusted sender ignored:", id, name);
    return;
  }

  const missionText = typeof msg === "string"
    ? msg
    : typeof msg?.text === "string"
      ? msg.text
      : typeof msg?.missionText === "string"
        ? msg.missionText
        : JSON.stringify(msg);

  enqueueTrustedMissionMessage({
    callModel,
    runCoordinationCycle,
    missionText,
    rawMessage: msg,
    replyCallback: reply,
    senderId: id,
    socket: client.socket,
  });
});