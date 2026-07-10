import { W, visitedSpawns, syncCaches, intention, clearIntention, isTeammate } from "./world/state.js";
import { isCrateMap, computeMapProfile, computeStrategy } from "./world/mapAnalysis.js";
import { proposeReactiveAction } from "./behavior/reactive.js";
import { executeActionIntent, waitAction, canDeliverNow, executeHandoffDrop } from "./behavior/actions.js";
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
  dropRuleTarget,
} from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal, carryingCount, carriedParcels, validGoal } from "./world/helpers.js";
import { CFG, isTrustedSender } from "./config.js";
import { key, manhattan } from "./utils/math.js";
import {
  activeMissions,
  pruneExpiredMissions,
  processMissionQueue,
  getMissionPolicy,
  enqueueTrustedMissionMessage,
  completeWaitMissionsIfExpired,
  completeMoveToMissionsIfReached,
  completeMeetTeammateMissionsIfSatisfied,
  completeHandoffBonusMissionsIfSatisfied,
} from "./llm/missions.mjs";
import {
  normalizeMissionPolicy,
  deliveryPreferredCarryTarget,
  deliveryRequiredCarryTarget,
  deliveryMustHappenNow,
} from "./llm/mission-policies.js";
import { callModel, runCoordinationCycle } from "./llm/agent.mjs";
import { coordination } from "./llm/tools.mjs";
import { relayMissionPolicyToA, getTeammateId, sendPlanToA, setTeammateId, suppressClearConstraints } from "./coordination/outbox.js";
import { tickAgentABaseline } from "./baseline/agentABaselineTick.js";
import client from "./client.js";

let busy = false;
let missionQueueRunning = false;
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
let lastNonBlockingMissionLogKey = null;

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

function missionDeliveryCarryTarget(policy) {
  return deliveryPreferredCarryTarget(policy);
}

function missionRequiredCarryTarget(policy) {
  return deliveryRequiredCarryTarget(policy);
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

  // pickupAllowed already enforces upper bounds; floor-only missions can stay opportunistic
  if (isMissionBlockingBaseline(mission)) {
    return hasOpportunisticNearbyParcel(mission);
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
    return { type: "PICKUP", target, source: "llm" };
  }

  if (plan.objective === "deliver_now") {
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

  if (plan.objective === "move_to") {
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
    if (msg?.type !== "llm_plan") continue;
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

function arbitratePlannedIntent(next, mission) {
  if (!next) return { type: "EXPLORE", target: null };

  const policy = normalizeMissionPolicy(mission);
  const missionBlocksBaseline = isMissionBlockingBaseline(mission);
  const carried = carryingCount();
  const carryTarget = missionRequiredCarryTarget(policy);
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

// suppressOpportunistic freezes this entirely during an active coordination/
// handoff MOVE - proposeReactiveAction()/canPickupNow()/canDeliverNow() have
// no way to know "B is mid-coordination-move" on their own (that state lives
// only in mainLoop.js's local coordinationIntent/handoffIntent, not in the
// mission policy they read), so without this B would reactively pick up and
// deliver ordinary parcels while walking to a meet/traffic-light/handoff
// target, directly contradicting the "focus on the mission" behavior already
// enforced everywhere else in this tick
async function tryReactiveFollowup(mission, suppressOpportunistic = false) {
  if (suppressOpportunistic) return false;
  let didAnything = false;
  for (let i = 0; i < 4; i += 1) {
    const intentNow = proposeReactiveAction(mission);
    if (!intentNow) break;
    const ok = await executeActionIntent(intentNow, mission);
    if (!ok) break;
    didAnything = true;
    syncCaches();

    // a reactive PICKUP just above can flip carrying from 0 to >0 mid-loop.
    // suppressOpportunistic was computed once, by the caller, off the
    // carrying count from BEFORE this pickup - it has no way to reflect
    // that change, and the next loop iteration would call
    // proposeReactiveAction() again still fully unsuppressed. for a
    // drop_rule mission that meant reactively picking up a parcel and
    // immediately delivering it again right where it stood, in the very
    // same tick, without ever reaching deliberate()'s mission-focus routing
    // to check whether it should be carried to the actual target tile
    // instead - i.e. exactly how a mission target got skipped entirely.
    // stop here once that's now the case and let the next tick's fresh
    // focusedMissionMove computation (mainLoop.js's tick()) take over with
    // an up-to-date carrying count
    const policyNow = normalizeMissionPolicy(mission);
    const dropTargetNow = carryingCount() > 0 ? dropRuleTarget(policyNow) : null;
    if (dropTargetNow && !samePos(W.me, dropTargetNow)) break;
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

function nearTarget(target, radius = 0) {
  if (!W.me || !target) return false;
  return manhattan(W.me.x, W.me.y, target.x, target.y) <= Math.max(0, Number(radius ?? 0));
}

function teammateArrivedForMission(missionId) {
  if (!missionId || !Array.isArray(W.coordinationStatuses)) return false;
  return W.coordinationStatuses.some((s) =>
    s?.missionId === missionId &&
    ["arrived", "waiting"].includes(String(s?.status ?? ""))
  );
}

// most recent position A reported as "arrived"/"waiting" for this mission -
// A is stationary once waiting (see mainLoop.js's hint.mode==="WAIT"
// branch), so this is a stable convergence target, not a moving one
function latestTeammatePositionForMission(missionId) {
  if (!missionId || !Array.isArray(W.coordinationStatuses)) return null;
  for (let i = W.coordinationStatuses.length - 1; i >= 0; i--) {
    const s = W.coordinationStatuses[i];
    if (s?.missionId === missionId && ["arrived", "waiting"].includes(String(s?.status ?? "")) && s?.position) {
      return { x: Number(s.position.x), y: Number(s.position.y) };
    }
  }
  return null;
}

// finds the nearest reachable tile matching a row/column/parity spec -
// each agent calls this independently on its own position, so they don't
// need to agree on a single shared point (same idea as traffic_light_wait)
function nearestRowColumnTile(spec, avoidTiles = []) {
  if (!W.me || !W.tiles) return null;
  const parity = spec?.rowParity ?? null;
  const row = Number.isFinite(spec?.row) ? Number(spec.row) : null;
  const column = Number.isFinite(spec?.column) ? Number(spec.column) : null;
  if (!parity && row === null && column === null) return null;

  let best = null;
  let bestDist = Infinity;
  for (const tile of W.tiles.values()) {
    if (!tile || tile.walkable === false) continue;
    const x = Number(tile.x);
    const y = Number(tile.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    if (parity) {
      const isOdd = Math.abs(y % 2) === 1;
      if (parity === "odd" && !isOdd) continue;
      if (parity === "even" && isOdd) continue;
    }
    if (row !== null && y !== row) continue;
    if (column !== null && x !== column) continue;

    const target = { x, y };
    const path = planPathToTarget(target, { avoidTiles });
    if (!samePos(W.me, target) && (!Array.isArray(path) || path.length === 0)) continue;

    const d = manhattan(W.me.x, W.me.y, target.x, target.y);
    if (d < bestDist) {
      bestDist = d;
      best = target;
    }
  }
  return best;
}

// "leftmost"/"rightmost" can't be pinned to a fixed column up front - the
// known map is still being explored, so this re-scans W.tiles live each
// call and naturally shifts further out as more of the map gets discovered
function extremeKnownColumn(direction) {
  if (!W.tiles) return null;
  let extreme = null;
  for (const tile of W.tiles.values()) {
    if (!tile || tile.walkable === false) continue;
    const x = Number(tile.x);
    if (!Number.isFinite(x)) continue;
    if (extreme === null || (direction === "rightmost" ? x > extreme : x < extreme)) extreme = x;
  }
  return extreme;
}

function nearestTrafficLightTile(trafficLight, avoidTiles = []) {
  const row = Number.isFinite(trafficLight?.row) ? Number(trafficLight.row) : null;
  let column = Number.isFinite(trafficLight?.column) ? Number(trafficLight.column) : null;
  if (column === null && row === null && (trafficLight?.region === "leftmost" || trafficLight?.region === "rightmost")) {
    column = extremeKnownColumn(trafficLight.region);
  }
  const spec =
    row !== null || column !== null
      ? { row, column }
      : { rowParity: trafficLight?.rowParity ?? "odd" };
  return nearestRowColumnTile(spec, avoidTiles);
}

let lastLoggedCoordinationMoveSig = null;
function logCoordinationMoveOnce(target, radius) {
  const sig = `${target.x},${target.y},${radius}`;
  if (sig === lastLoggedCoordinationMoveSig) return;
  lastLoggedCoordinationMoveSig = sig;
  console.log("[B] Moving to coordination target:", target, "radius:", radius);
}

const COORDINATION_TARGET_INVALID_WARNING_DELAY_MS = 15000;
let invalidCoordinationTargetSig = null;
let invalidCoordinationTargetSince = 0;
let warnedInvalidCoordinationTarget = false;

// warn only after exploration has had time to reveal a coordination target
function warnIfCoordinationTargetInvalid(target) {
  const sig = `${target.x},${target.y}`;
  if (validGoal(target)) {
    if (invalidCoordinationTargetSig === sig) {
      invalidCoordinationTargetSig = null;
      invalidCoordinationTargetSince = 0;
      warnedInvalidCoordinationTarget = false;
    }
    return;
  }
  if (invalidCoordinationTargetSig !== sig) {
    invalidCoordinationTargetSig = sig;
    invalidCoordinationTargetSince = Date.now();
    warnedInvalidCoordinationTarget = false;
    return;
  }
  if (!warnedInvalidCoordinationTarget && Date.now() - invalidCoordinationTargetSince > COORDINATION_TARGET_INVALID_WARNING_DELAY_MS) {
    warnedInvalidCoordinationTarget = true;
    console.warn(
      "[B] Coordination target still isn't a known walkable tile after 15s - probably out of bounds or a wall, not just unexplored yet. Double-check the coordinates given in the mission:",
      target
    );
  }
}

// shared rendezvous handling for meet_teammate and explicit traffic-light targets
function meetTargetMoveOrWait(target, radius, missionId) {
  const teammatePos = latestTeammatePositionForMission(missionId);
  const effectiveTarget = teammatePos ?? target;
  warnIfCoordinationTargetInvalid(effectiveTarget);

  if (!nearTarget(effectiveTarget, radius)) {
    // B's own coordination movement had no equivalent of A's "Forced move
    // target" log - made it look like B wasn't doing anything toward a
    // meet-up while it was actually converging correctly the whole time.
    // logged on change only, not every tick, since this is checked every
    // tick while approaching
    logCoordinationMoveOnce(effectiveTarget, radius);
    return {
      type: "MOVE",
      target: effectiveTarget,
      source: teammatePos ? "coordination_move_to_teammate" : "coordination_move",
    };
  }
  if (teammatePos || teammateArrivedForMission(missionId)) {
    return { type: "WAIT", target: null, source: "coordination_wait_ready" };
  }
  return { type: "WAIT", target: null, source: "coordination_wait_teammate" };
}

function coordinationOverrideIntent(policy) {
  const movement = policy?.movement ?? {};
  const target = movement.meetTarget ?? movement.moveTo ?? null;
  const radius = Number(movement.meetRadius ?? (movement.meetTarget ? 3 : 0));
  const missionId = policy?.meta?.missionId ?? policy?.meta?.missionSignature ?? policy?.meta?.blockingText ?? null;

  if (target) {
    if (movement.meetTarget) {
      return meetTargetMoveOrWait(target, radius, missionId);
    }
    // plain moveTo (no real "meet" semantics, e.g. a one-off relocation
    // hint) - just get there and wait, no teammate-position refinement
    if (!nearTarget(target, radius)) {
      logCoordinationMoveOnce(target, radius);
      return { type: "MOVE", target, source: "coordination_move" };
    }
    return { type: "WAIT", target: null, source: "coordination_wait_ready" };
  }

  if (Number.isFinite(movement.meetRow) || Number.isFinite(movement.meetColumn)) {
    const rowColTarget = nearestRowColumnTile(
      { row: movement.meetRow, column: movement.meetColumn },
      movement.avoidRules ?? movement.avoidTiles ?? []
    );
    if (rowColTarget && !samePos(W.me, rowColTarget)) {
      return { type: "MOVE", target: rowColTarget, source: "coordination_row_column" };
    }
    if (teammateArrivedForMission(missionId)) {
      return { type: "WAIT", target: null, source: "coordination_wait_ready" };
    }
    return { type: "WAIT", target: null, source: "coordination_wait_teammate" };
  }

  const trafficLight = policy?.wait?.trafficLight;
  if (trafficLight) {
    if (trafficLight.target) {
      // an explicit target/radius (e.g. "wait near (x,y) within N tiles of
      // each other") takes the same meet-then-wait path as meet_teammate,
      // instead of the row/column/parity tile search below - that search
      // has no way to express "near a specific point", so without this the
      // target/radius the LLM correctly extracted was silently discarded
      // and each agent independently found its own unrelated "nearest odd
      // row" tile, which is why they ended up far apart
      const tlRadius = Math.max(0, Number(trafficLight.radius ?? 3));
      return meetTargetMoveOrWait(trafficLight.target, tlRadius, missionId);
    }
    const parityTarget = nearestTrafficLightTile(
      trafficLight,
      policy?.movement?.avoidRules ?? policy?.movement?.avoidTiles ?? []
    );
    if (parityTarget && !samePos(W.me, parityTarget)) {
      return { type: "MOVE", target: parityTarget, source: "traffic_light_row" };
    }
    return { type: "WAIT", target: null, source: "traffic_light_wait" };
  }

  return null;
}

// drop as soon as reasonably close instead of walking all the way to A -
// B's own approach is pure decay overhead that never needed to happen; a
// short radius here leaves the remaining distance (and decay budget) for
// A's much shorter walk instead of burning it all on B's leg. kept tight
// (not 0) since B/A positions are still only known to +-1 tick of latency -
// requiring exact overlap could miss the window on the same tick it'd
// otherwise trigger. tightened from 5 - on a vision-limited map A's walk
// to the drop tile can take a long time (no shortcuts through unexplored
// territory), and observed cases lost an entire parcel to decay purely
// during that last stretch
const HANDOFF_MEET_RADIUS = 2;
const HANDOFF_BEACON_MAX_AGE_MS = 8000; // a bit more than agentA's 2s beacon interval
const HANDOFF_RETRY_COOLDOWN_MS = 15000; // must be >= the pickup blacklist in executeHandoffDrop
// a parcel already too decayed to survive even a short handoff trip isn't
// worth attempting - deliver it normally instead and wait for a better one
const HANDOFF_MIN_PARCEL_SCORE = 15;
let activeHandoffParcelId = null;
let handoffCooldownUntil = 0;

// handoff_bonus only makes sense carrying exactly one parcel - putdown()
// drops everything held at once. prefers agentA's live-sensed position but
// falls back to its position beacon when sensing hasn't picked it up yet
function handoffOverrideIntent(policy) {
  if (!policy?.meta?.handoffBonus) {
    activeHandoffParcelId = null;
    return null;
  }

  if (Date.now() < handoffCooldownUntil) {
    // a previous drop is still pending collection - starting a second
    // handoff with a different parcel now would send agentA a brand new
    // collect_parcel target and abandon whatever it was still walking
    // toward, so nothing ever actually gets collected
    return null;
  }

  const carried = carriedParcels();
  if (carried.length !== 1) {
    activeHandoffParcelId = null;
    return null;
  }

  const parcel = carried[0];
  const parcelId = String(parcel?.id ?? "");
  if (!parcelId) return null;

  if (Number(parcel?.reward ?? 0) < HANDOFF_MIN_PARCEL_SCORE) {
    // too decayed/low-value to be worth chasing a teammate down for -
    // just let normal delivery handle it
    activeHandoffParcelId = null;
    return null;
  }

  const teammateId = getTeammateId?.();
  if (!teammateId) return null;

  const sensed = W.agents?.get?.(teammateId);
  const beacon = W.teammatePosition;
  const beaconFresh = !!beacon && Date.now() - beacon.receivedAt < HANDOFF_BEACON_MAX_AGE_MS;
  const teammate = sensed ?? (beaconFresh ? beacon : null);
  if (!teammate) return null;

  const dist = manhattan(W.me.x, W.me.y, teammate.x, teammate.y);

  if (dist <= HANDOFF_MEET_RADIUS) {
    activeHandoffParcelId = null;
    return { type: "HANDOFF_DROP", target: null, source: "handoff_dropoff", parcel };
  }

  // required handoff mission: approach the known teammate once holding a parcel
  activeHandoffParcelId = parcelId;
  return { type: "MOVE", target: { x: teammate.x, y: teammate.y }, source: "handoff_approach" };
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
  const carryTarget = missionRequiredCarryTarget(policy);
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
    console.warn("[DELIVER] Delivery blocked.", { reason, target, ...(extra ?? {}) });
    lastDeliveryStuckLogKey = k;
    lastDeliveryStuckLogAt = now;
  }
}

// a maxParcelScore/maxTotalScore violation is a value problem, not a
// positional one - the only fix is waiting for it to decay under the cap,
// never a different tile or path
function carriedBatchExceedsScoreCap(policy) {
  const maxParcelScore = policy?.delivery?.maxParcelScore;
  const maxTotalScore = policy?.delivery?.maxTotalScore;
  if (!Number.isFinite(maxParcelScore) && !Number.isFinite(maxTotalScore)) return false;
  const carried = carriedParcels();
  if (Number.isFinite(maxParcelScore) && carried.some((p) => Number(p?.reward ?? 0) > maxParcelScore)) return true;
  if (Number.isFinite(maxTotalScore)) {
    const total = carried.reduce((s, p) => s + Number(p?.reward ?? 0), 0);
    if (total > maxTotalScore) return true;
  }
  return false;
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
        // tell agentA to drop any coordination hint it was following, or
        // it stays parked forever once B's last mission is archived
        relayMissionPolicyToA?.();
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
    }

    if (completeMeetTeammateMissionsIfSatisfied(W.me)) {
      clearIntention();
      clearTargetFailureMemory();
    }

    if (!hasActiveMissionRecords()) {
      relayMissionPolicyToA?.();
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
      relayMissionPolicyToA?.();
    }

    if (!missionBlocksBaseline) {
      const missionKey = mission?.missionSignature ?? mission?.blockingText ?? JSON.stringify(mission ?? {});
      if (missionKey !== lastNonBlockingMissionLogKey) {
        console.log("[MISSION] Non-blocking rule active; using baseline strategy with action guards.");
        lastNonBlockingMissionLogKey = missionKey;
      }
      await tickAgentABaseline(mission);
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
      } else {
        await executeActionIntent(waitAction("mission_wait"), controlMission);
      }
      return;
    }

    const coordinationIntent = coordinationOverrideIntent(policy);
    if (coordinationIntent?.type === "WAIT") {
      if (intention.type !== "WAIT") clearIntention();
      intention.type = "WAIT";
      intention.target = null;
      intention.steps = 0;
      intention.path = [];
      await executeActionIntent(waitAction(coordinationIntent.source ?? "coordination_wait"), controlMission);
      return;
    }

    // execute handoff drops directly; they are not path-planning intents
    const handoffIntent = coordinationIntent ? null : handoffOverrideIntent(policy);
    // once carrying for a drop_rule, keep focus on the mission target
    const activeDropRuleTarget = carryingCount() > 0 ? dropRuleTarget(policy) : null;
    // focused missions suppress opportunistic detours for this tick
    const focusedMissionMove = coordinationIntent?.type === "MOVE" || handoffIntent?.type === "MOVE" || !!activeDropRuleTarget;
    if (handoffIntent?.type === "HANDOFF_DROP") {
      clearIntention();
      const dropped = await executeHandoffDrop();
      if (Array.isArray(dropped) && dropped.length > 0) {
        handoffCooldownUntil = Date.now() + HANDOFF_RETRY_COOLDOWN_MS;
        // keep A's collection hint active while the handoff can still succeed
        suppressClearConstraints(HANDOFF_RETRY_COOLDOWN_MS);
        // completion waits for A's confirmation, since a dropped parcel may vanish
        const teammateId = getTeammateId?.();
        if (teammateId) {
          for (const p of dropped) {
            sendPlanToA({
              objective: "collect_parcel",
              targetPosition: { x: Number(p.x), y: Number(p.y) },
              targetParcelId: p.id,
            });
          }
          console.log("[HANDOFF] Dropped for teammate and notified:", dropped.map((p) => p.id));
        } else {
          console.warn("[HANDOFF] Dropped parcel but no teammate id to notify - it will just sit there.");
        }
      }
      return;
    }

    const carryTarget = missionRequiredCarryTarget(policy);
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

    if (await tryReactiveFollowup(controlMission, focusedMissionMove)) {
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

    const llmNext = missionBlocksBaseline ? consumeLLMPlan(controlMission) : null;
    // (focusedMissionMove computed earlier, right after handoffIntent -
    // opportunistic pickup below must not pre-empt an active coordination/
    // handoff move; arbitratePlannedIntent passes a MOVE through unchanged,
    // so this stays accurate after that call)
    let next =
      coordinationIntent?.type === "MOVE"
        ? coordinationIntent
        : handoffIntent?.type === "MOVE"
        ? handoffIntent
        : llmNext;
    if (!next) next = await deliberate(controlMission);
    next = arbitratePlannedIntent(next, controlMission) ?? { type: "WAIT", target: null };

    if (next.type === "DELIVER" && !canDeliverNow(policy, carryingCount())) {
      const pickupPlan = opportunisticPickupPlan(controlMission);
      next = pickupPlan ?? { type: "EXPLORE", target: null, source: "delivery-guard" };
    }

    if (!focusedMissionMove && !llmNext && shouldPreferOpportunisticPickup(controlMission, next)) {
      const pickupPlan = opportunisticPickupPlan(controlMission);
      if (pickupPlan) next = pickupPlan;
    }

    // deliberate() can itself decide to WAIT (e.g. still need parcels but
    // nothing's visible, or the delivery target is briefly blocked). unlike
    // the WAIT checks above, this one comes with a null target and would
    // otherwise fall through to fallbackMove(null), which has no
    // destination and just wanders off - intercept it the same way
    if (next.type === "WAIT") {
      if (intention.type !== "WAIT") clearIntention();
      intention.type = "WAIT";
      intention.target = null;
      intention.steps = 0;
      intention.path = [];
      await executeActionIntent(waitAction(next.source ?? "deliberate_wait"), controlMission);
      return;
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
          // exact pathing handles rare coordination targets near one-way sections
          exact: focusedMissionMove,
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
        } else if (focusedMissionMove) {
          // coordination targets are not blacklisted while the map may be incomplete
          clearIntention();
        } else {
          if (!isCrateMap()) blacklistGoal(next.target);
          clearIntention();
        }
        await fallbackMove(next.target ?? null);
        await tryReactiveFollowup(controlMission, focusedMissionMove);
        return;
      }

      const wasReplanningFailedTarget =
        next.target &&
        lastFailedTargetKey &&
        targetKey(next.target) === lastFailedTargetKey;

      intention.type = next.type;
      intention.target = next.target ?? null;
      intention.steps = 0;
      intention.path = path;
      // keep the failure counter when replanning the same target that just
      // failed, otherwise targetFails resets to 1 forever and the blacklist
      // fallback never activates
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
      // lift suppression on the actual drop_rule target so putdown can run
      const arrivedAtDropRuleTarget = !!(activeDropRuleTarget && samePos(reachedTarget, activeDropRuleTarget));
      const didReactive = await tryReactiveFollowup(controlMission, focusedMissionMove && !arrivedAtDropRuleTarget);

      if (!didReactive) {
        // drop_rule targets may be ordinary tiles, so retry failed putdowns there
        const onRealDeliveryTile = !!W.tiles.get?.(key(W.me.x, W.me.y))?.delivery;
        if ((onRealDeliveryTile || arrivedAtDropRuleTarget) && intention.type === "DELIVER") {
          if (carriedBatchExceedsScoreCap(policy)) {
            // stay on target and retry once the score cap is satisfied
            maybeLogDeliveryStuck(intention.target, "waiting-for-score-decay");
            return;
          }
          const { targetFails } = registerTargetFailure(intention.target);
          if (targetFails >= DELIVERY_STUCK_REPLAN_LIMIT) {
            console.warn("[DELIVER] Reached delivery/drop target repeatedly without successful putdown; blacklisting briefly.", intention.target);
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
          await tryReactiveFollowup(controlMission, focusedMissionMove);
          return;
        } else if (shouldRelaxFailureHandling()) {
          clearIntention();
        } else if (focusedMissionMove) {
          // keep coordination targets eligible despite transient movement failures
          intention.steps = 0;
        } else if (intention.target && targetFails >= 3) {
          blacklistGoal(intention.target);
          clearIntention();
        } else {
          intention.steps = 0;
        }
        await fallbackMove(intention.target);
        await tryReactiveFollowup(controlMission, focusedMissionMove);
        return;
      }
    }

    clearTargetFailureMemory(intention.target);
    await tryReactiveFollowup(controlMission, focusedMissionMove);

    if (completeMoveToMissionsIfReached(W.me)) {
      clearIntention();
      clearTargetFailureMemory();
      return;
    }

    await fallbackMove(next.target);
    await tryReactiveFollowup(controlMission, focusedMissionMove);
  } catch (err) {
    console.error("[B] tick error", err);
  } finally {
    busy = false;
  }
}

// trust is governed solely by isTrustedSender() (config.js), which reads
// TRUSTED_SENDERS from env - don't duplicate the name list here, or setting
// that env var stops working for this gate
function isTrustedMissionSender(id, name) {
  return isTrustedSender(name);
}

// internal protocol messages are never mission text
const INTERNAL_MESSAGE_TYPES = new Set(["position_beacon", "coordination_status", "llm_plan", "hint"]);

client.onMsg(async (id, name, msg, reply) => {
  const parsed = typeof msg === "object" ? msg : tryParseJSON(msg);

  if (parsed?.type === "position_beacon" && parsed.position) {
    // prefer roster-based teammate checks when available
    const acceptable = W.knownAgents.has(id) ? isTeammate(id) : !isTrustedSender(name);
    if (acceptable) {
      // frequent beacon, used when normal sensing cannot see A
      setTeammateId(id);
      W.teammatePosition = {
        x: Number(parsed.position.x),
        y: Number(parsed.position.y),
        receivedAt: Date.now(),
      };
    }
    return;
  }

  if (parsed?.type === "coordination_status") {
    if (!Array.isArray(W.coordinationStatuses)) W.coordinationStatuses = [];
    W.coordinationStatuses.push({
      ...parsed,
      senderId: id,
      senderName: name,
      receivedAt: Date.now(),
    });
    W.coordinationStatuses = W.coordinationStatuses.slice(-20);
    if (parsed.status === "collected") {
      console.log("[HANDOFF] Teammate picked up the handed-off parcel:", parsed.targetParcelId);
    } else if (parsed.status === "delivered") {
      console.log("[HANDOFF] Teammate delivered the handed-off parcel - handoff fully complete:", parsed.targetParcelId);
      // complete only after A confirms the handoff delivery
      completeHandoffBonusMissionsIfSatisfied();
    } else if (parsed.status === "missed") {
      // retry promptly if A reached the drop tile after the parcel disappeared
      console.log("[HANDOFF] Teammate found the parcel already gone - retrying handoff sooner:", parsed.targetParcelId);
      handoffCooldownUntil = 0;
      activeHandoffParcelId = null;
    } else {
      console.log("[COORD] Status from teammate:", JSON.stringify(parsed));
    }
    return;
  }

  // ignore internal protocol payloads before mission classification
  if (parsed?.type && INTERNAL_MESSAGE_TYPES.has(parsed.type)) {
    return;
  }

  const missionText = typeof msg === "string"
    ? msg
    : typeof msg?.text === "string"
      ? msg.text
      : typeof msg?.missionText === "string"
        ? msg.missionText
        : JSON.stringify(msg);

  console.log(`[MSG] (${id}) ${name}: "${missionText}" hasReply ${typeof reply === "function"}`);

  if (!isTrustedMissionSender(id, name)) {
    console.log("[MSG] Message from untrusted sender ignored:", id, name);
    return;
  }

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

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}
