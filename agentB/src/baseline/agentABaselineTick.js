import { W, visitedSpawns, syncCaches, intention, clearIntention } from "../world/state.js";
import { isCrateMap, computeMapProfile, computeStrategy } from "../world/mapAnalysis.js";
import { proposeBaselineReactiveAction } from "../behavior/reactive.js";
import { executeBaselineActionIntent, waitAction } from "../behavior/actions.js";
import { fallbackMove, tryMoveDir } from "../behavior/movement.js";
import {
  deliberateBaseline,
  planPathToTarget,
  completeSpawnPatrol,
  hasOpportunisticNearbyParcelBaseline,
  bestOpportunisticNearbyParcelBaseline,
} from "../planning/targeting.js";
import { samePos, sameTarget } from "../utils/directions.js";
import { blacklistGoal } from "../world/helpers.js";
import { CFG } from "../config.js";
import { key } from "../utils/math.js";

let lastFailedTargetKey = null;
let failedTargetCount = 0;
let failedStepCount = 0;

const SENSOR_RADIUS = 5;
let mapAnalysisDone = false;
let lastBranchingFactor = 0;
let strategyCheckCounter = 0;

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
      console.log("[B][BASELINE_STRATEGY] Map stabilized:", JSON.stringify(strategy));
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

function shouldPreferOpportunisticPickup(hint, next = null) {
  if (!next) return false;
  if (!["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(next.type)) return false;
  if (hint?.mode === "WAIT" || hint?.avoidPickup || hint?.forceDelivery) return false;
  const carrying = W.carrying?.size ?? 0;
  if (carrying >= (CFG.REACT_HARD_CARRY_LIMIT ?? 15)) return false;
  return hasOpportunisticNearbyParcelBaseline(hint);
}

function opportunisticPickupPlan(hint) {
  const parcel = bestOpportunisticNearbyParcelBaseline(hint);
  if (!parcel) return null;
  return { type: "PICKUP", target: { x: Number(parcel.x), y: Number(parcel.y) } };
}

async function tryReactiveFollowup(hint) {
  let didAnything = false;
  for (let i = 0; i < 4; i++) {
    const intent = proposeBaselineReactiveAction(hint);
    if (!intent) break;
    const ok = await executeBaselineActionIntent(intent, hint);
    if (!ok) break;
    didAnything = true;
    syncCaches();
  }
  return didAnything;
}

export async function tickAgentABaseline(hint = null) {
  syncCaches();
  computeMapProfile();
  maybeStartStrategyAnalysis();
  updateSpatialMemory();

  // const hint = null;

  if (hint?.mode === "WAIT") {
    if (intention.type !== "WAIT") {
      clearIntention();
      intention.type = "WAIT";
      intention.target = null;
      intention.steps = 0;
      intention.path = [];
    }
    await executeActionIntent(waitAction("hint_wait"), hint);
    return;
  }

  if (await tryReactiveFollowup(hint)) {
    clearTargetFailureMemory();
    clearIntention();
    syncCaches();
    return;
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
    if (shouldPreferOpportunisticPickup(hint, { type: intention.type })) {
      clearIntention();
    }
  }

  let next = (await deliberateBaseline(hint)) ?? { type: "EXPLORE", target: null };

  if (shouldPreferOpportunisticPickup(hint, next)) {
    const pickupPlan = opportunisticPickupPlan(hint);
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
    intention.type = next.type;
    intention.target = next.target;
    intention.steps = 0;
    intention.path = path;
    clearTargetFailureMemory();
  }

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
}
