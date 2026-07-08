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
import { CFG } from "./config.js";
import { key } from "./utils/math.js";
import { inbox, pushPlanFromB } from "./coordination/inbox.js";
import client from "./client.js";


let busy = false;
let lastFailedTargetKey = null;
let failedTargetCount = 0;
let failedStepCount = 0;


const SENSOR_RADIUS = 5;
let mapAnalysisDone = false;
let lastBranchingFactor = 0;
let strategyCheckCounter = 0;


// Helpers


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
    const d = { up: { dx: 0, dy: 1 }, down: { dx: 0, dy: -1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 } }[dir];
    if (!d) continue;
    x += d.dx; y += d.dy;
    if (W.boxPos?.has(key(x, y))) return true;
  }
  return false;
}


function shouldRelaxFailureHandling() {
  return isCrateMap() && currentPlanLooksCrateSensitive();
}


function dist2(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}


function nearestDeliveryTarget() {
  if (!W.me || !Array.isArray(W.deliveryTiles) || W.deliveryTiles.length === 0) return null;
  let best = null, bestD = Infinity;
  for (const t of W.deliveryTiles) {
    const d = dist2(W.me, t);
    if (d < bestD) { bestD = d; best = { x: t.x, y: t.y }; }
  }
  return best;
}


function maybeStartStrategyAnalysis() {
  if (mapAnalysisDone || !W.tiles || W.tiles.size === 0) return;
  strategyCheckCounter++;
  if (strategyCheckCounter % 50 !== 0) return;
  computeMapProfile();
  const currentBF = W.mapProfile?.avgBranchingFactor ?? 0;
  if (Math.abs(currentBF - lastBranchingFactor) < 0.15) {
    mapAnalysisDone = true;
    const strategy = computeStrategy();
    if (strategy) {
      W.strategy = strategy;
      console.log("[A][STRATEGY] Map stabilized:", JSON.stringify(strategy));
    }
  }
  lastBranchingFactor = currentBF;
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


// Hint helpers


function shouldPreferOpportunisticPickup(hint, next = null) {
  if (!next) return false;
  if (!["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(next.type)) return false;
  if (hint?.mode === "WAIT" || hint?.avoidPickup || hint?.forceDelivery) return false;
  const carrying = W.carrying?.size ?? 0;
  if (carrying >= (CFG.REACT_HARD_CARRY_LIMIT ?? 15)) return false;
  return hasOpportunisticNearbyParcel(hint);
}


function opportunisticPickupPlan(hint) {
  const parcel = bestOpportunisticNearbyParcel(hint);
  if (!parcel) return null;
  return { type: "PICKUP", target: { x: Number(parcel.x), y: Number(parcel.y) } };
}


// LLM plan consumer


function normalizeLLMPlan(plan) {
  if (!plan?.objective) {
    if (plan?.type && ["PICKUP", "DELIVER", "MOVE", "PATROL", "EXPLORE", "WAIT"].includes(plan.type)) {
      return { type: plan.type, target: plan.target ?? null };
    }
    return null;
  }

  if (plan.objective === "collect_parcel") {
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
    return { type: "PICKUP", target };
  }

  if (plan.objective === "deliver_now") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : nearestDeliveryTarget();
    return target ? { type: "DELIVER", target } : null;
  }

  if (plan.objective === "explore") {
    const spawnTarget = getOldestUnseenSpawn();
    return spawnTarget
      ? { type: "PATROL", target: spawnTarget }
      : { type: "EXPLORE", target: null };
  }

  return null;
}


// Inbox: returns a hint object (avoidTiles, moveTo, mode, ...) or null
// LLM plan messages are converted to a moveTo/mode hint


function drainInboxHint() {
  let hint = null;

  while (inbox.pendingMessages.length > 0) {
    const msg = inbox.pendingMessages.shift();
    if (!msg) continue;

    // Coordination signal from B (avoidTiles, moveTo, mode, etc.)
    if (msg.type === "hint" && typeof msg === "object") {
      hint = { ...hint, ...msg };
      continue;
    }

    // LLM plan from B: normalize into an intent and attach to hint
    if ((msg.type === "llmplan" || msg.type === "llm_plan") && msg.plan) {
      console.log("[A][LLM] Consuming plan from B:", JSON.stringify(msg.plan));
      const normalized = normalizeLLMPlan(msg.plan);
      if (normalized) {
        console.log("[A][LLM] Normalized to intent:", JSON.stringify(normalized));
        // Attach as a moveTo hint so deliberate() respects it
        hint = hint ?? {};
        if (normalized.type === "WAIT") {
          hint.mode = "WAIT";
        } else if (normalized.target) {
          hint.moveTo   = normalized.target;
          hint.llmType  = normalized.type; // carry original type for reference
        }
      }
      continue;
    }
  }

  return hint;
}


async function tryReactiveFollowup(hint) {
  let didAnything = false;
  for (let i = 0; i < 4; i++) {
    const intent = proposeReactiveAction(hint);
    if (!intent) break;
    const ok = await executeActionIntent(intent, hint);
    if (!ok) break;
    didAnything = true;
    syncCaches();
  }
  return didAnything;
}


// Main tick


export async function tick() {
  if (!W.me || busy || W.prevActionFinished === false) return;

  busy = true;

  try {
    syncCaches();
    computeMapProfile();
    maybeStartStrategyAnalysis();
    updateSpatialMemory();

    // Drain inbox and build coordination hint for this tick
    const hint = drainInboxHint();

    // If a coordination hint contains an explicit rendezvous/moveTo, force a MOVE
    // objective and ignore other behaviors until the target is reached.
    let forcedMoveTarget = null;
    if (hint && hint.mode !== "WAIT" && (hint.moveTo || hint.meetTarget)) {
      const t = hint.moveTo ?? hint.meetTarget;
      if (t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y))) {
        forcedMoveTarget = { x: Number(t.x), y: Number(t.y) };
        console.log("[A] Forced move target from hint:", forcedMoveTarget);
      }
    }

    // Wait override from B
    if (hint?.mode === "WAIT") {
      if (intention.type !== "WAIT") {
        clearIntention();
        intention.type   = "WAIT";
        intention.target = null;
        intention.steps  = 0;
        intention.path   = [];
      }
      await executeActionIntent(waitAction("hint_wait"), hint);
      return;
    }

    // Reactive layer (pickup/deliver if already standing on tile)
    if (await tryReactiveFollowup(hint)) {
      clearTargetFailureMemory();
      clearIntention();
      syncCaches();
      return;
    }

    // Stale patrol target
    if (intention.type === "PATROL" && intention.target) {
      const lastSeen = visitedSpawns.get(`${intention.target.x},${intention.target.y}`) || 0;
      if (
        (Date.now() - lastSeen) / 1000 < 1 &&
        !W.parcelList.some((p) => p.x === intention.target.x && p.y === intention.target.y)
      ) {
        clearIntention();
      }
    }

    // Opportunistic pickup interrupt
    if (["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(intention.type)) {
      if (shouldPreferOpportunisticPickup(hint, { type: intention.type })) {
        clearIntention();
      }
    }

    // Deliberation (unless a forced move target is present)
    let next = null;
    if (forcedMoveTarget) {
      next = { type: "MOVE", target: forcedMoveTarget };
    } else {
      next = (await deliberate(hint)) ?? { type: "EXPLORE", target: null };
    }

    // Opportunistic pickup override
    if (shouldPreferOpportunisticPickup(hint, next)) {
      const pickupPlan = opportunisticPickupPlan(hint);
      if (pickupPlan) next = pickupPlan;
    }

    // Plan (or replan)
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
          avoidTiles: hint?.avoidTiles ?? [],
        });
        if (!path || (path.length === 0 && !samePos(W.me, next.target))) {
          if (!isCrateMap()) blacklistGoal(next.target);
          clearIntention();
          await fallbackMove(null);
          await tryReactiveFollowup(hint);
          return;
        }
      }
      intention.type   = next.type;
      intention.target = next.target;
      intention.steps  = 0;
      intention.path   = path;
      clearTargetFailureMemory();
    }

    // Already at target
    if (intention.target && samePos(W.me, intention.target)) {
      if (!(await tryReactiveFollowup(hint))) {
        if (
          intention.type === "DELIVER" &&
          W.tiles.get(key(W.me.x, W.me.y))?.delivery
        ) {
          blacklistGoal(intention.target);
        }
        if (intention.type === "PATROL") completeSpawnPatrol();
        const reachedTarget = intention.target;
        clearIntention();
        clearTargetFailureMemory(reachedTarget);
        await fallbackMove(null);
      }
      return;
    }

    // Follow path
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
        await tryReactiveFollowup(hint);
        return;
      }
      clearTargetFailureMemory(intention.target);
      await tryReactiveFollowup(hint);
      return;
    }

    await fallbackMove(next.target);
    await tryReactiveFollowup(hint);

  } catch (err) {
    console.error("[A] tick error:", err);
  } finally {
    busy = false;
  }
}


// Message listener


client.onMsg((id, name, msg, reply) => {
  const parsed = typeof msg === "object" ? msg : tryParseJSON(msg);
  if (!parsed) return;

  if ((parsed.type === "llmplan" || parsed.type === "llm_plan") && parsed.plan) {
    console.log("[A] Received plan from B:", JSON.stringify(parsed.plan));
    pushPlanFromB(parsed.plan);
    return;
  }

  console.log("[A] Ignoring non-plan message from", name);
});


function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}