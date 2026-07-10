import { W, visitedSpawns, syncCaches, intention, clearIntention, isTeammate } from "./world/state.js";
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
import { blacklistGoal, validGoal } from "./world/helpers.js";
import { CFG } from "./config.js";
import { key } from "./utils/math.js";
import { inbox, pushPlanFromB } from "./coordination/inbox.js";
import { getPDDLIntention, missionNeedsPlanning } from "./planning/pddlPlanner.js";
import client from "./client.js";


let busy = false;
let lastFailedTargetKey = null;
let failedTargetCount = 0;
let failedStepCount = 0;
let lastCoordinatorId = null;
let activeCoordination = null;
let lastPositionBeaconAt = 0;
let positionBeaconEnabled = false;
let waitingStatusSent = false;
// tracks a handoff parcel from confirmed pickup through to confirmed
// delivery so B can be told both times - survives past the point
// activeCoordination gets cleared, since A may pick up/deliver other
// parcels in between and this isn't necessarily resolved in the same trip
let pendingHandoffParcelId = null;
let pendingHandoffMissionId = null;
// tracks a handoff parcel from the moment B assigns it through to confirmed
// pickup. kept separate from pendingHandoffParcelId/activeCoordination
// because the actual pickup can happen via ordinary path-following reactive
// pickup (see reactive.js) a tick before hint.mode ever reaches "WAIT" -
// this is checked every tick so it catches the pickup no matter which code
// path actually grabbed the parcel
let awaitingHandoffPickupParcelId = null;
let awaitingHandoffMissionId = null;

const POSITION_BEACON_INTERVAL_MS = 1000;

function shoutPosition() {
  if (!W.me) return;
  client
    .shout(JSON.stringify({ type: "position_beacon", position: { x: Number(W.me.x), y: Number(W.me.y) } }))
    .catch((err) => console.warn("[A] Failed to shout position beacon:", err?.message ?? err));
}

// resolves the teammate's id from the server's 'controller' roster
// (id/name/teamId/teamName for every connected agent) instead of a shout -
// authoritative, vision-independent, and reaches only whoever we later
// client.say() it to rather than every connected agent
function resolveTeammateId() {
  for (const agent of W.knownAgents.values()) {
    if (isTeammate(agent.id)) return agent.id;
  }
  return null;
}

// broadcasts A's position regardless of distance, so B can find it even on
// a big map where they'd never cross paths. only runs while B has asked for
// it (hint.reportPosition) - A never turns this on itself, and it always
// turns back off on clear_constraints
function maybeSendPositionBeacon() {
  if (!W.me || !positionBeaconEnabled) return;
  const now = Date.now();
  if (now - lastPositionBeaconAt < POSITION_BEACON_INTERVAL_MS) return;
  lastPositionBeaconAt = now;
  shoutPosition();
}


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


const COORDINATION_TARGET_INVALID_WARNING_DELAY_MS = 15000;
let invalidCoordinationTargetSig = null;
let invalidCoordinationTargetSince = 0;
let warnedInvalidCoordinationTarget = false;

// warn only after exploration has had time to reveal a forced target
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
      "[A] Forced move target still isn't a known walkable tile after 15s - probably out of bounds or a wall, not just unexplored yet. Double-check the coordinates given in the mission:",
      target
    );
  }
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

function rememberCoordinationTarget(plan, target) {
  if (!target) return;
  const isHandoffPickup = plan?.objective === "collect_parcel";
  activeCoordination = {
    missionId: plan?.missionId ?? plan?.missionSignature ?? plan?.objective ?? "coordination",
    target: { x: Number(target.x), y: Number(target.y) },
    radius: Number(plan?.meetRadius ?? plan?.radius ?? 0),
    arrivedSent: false,
    // collect_parcel targets are only ever a pickup, never a real meet/
    // traffic-light waypoint - remembered so the fallback hint rebuilt from
    // activeCoordination keeps letting the reactive layer pick up on arrival
    llmType: isHandoffPickup ? "PICKUP" : null,
    targetParcelId: plan?.targetParcelId ?? null,
  };
  if (isHandoffPickup && plan?.targetParcelId) {
    awaitingHandoffPickupParcelId = plan.targetParcelId;
    awaitingHandoffMissionId = activeCoordination.missionId;
  }
}

// missionIdOverride lets a caller report status after activeCoordination has
// already been cleared (e.g. confirming delivery of a handoff parcel picked
// up several ticks/trips ago), instead of only ever reporting the currently
// active coordination
async function sendCoordinationStatus(status, extra = {}, missionIdOverride = null) {
  const missionId = missionIdOverride ?? activeCoordination?.missionId;
  // prefer the roster (authoritative, doesn't depend on B having messaged
  // us first) - lastCoordinatorId is just a fallback for a roster that
  // hasn't arrived yet
  const targetId = resolveTeammateId() ?? lastCoordinatorId;
  if (!targetId || !missionId) return;
  const msg = {
    type: "coordination_status",
    missionId,
    status,
    position: W.me ? { x: Number(W.me.x), y: Number(W.me.y) } : null,
    ...extra,
  };
  try {
    await client.say(targetId, JSON.stringify(msg));
  } catch (err) {
    console.warn("[A][COORD] Failed to send status:", err?.message ?? err);
  }
}

function activeCoordinationReached() {
  if (!W.me || !activeCoordination?.target) return false;
  const radius = Math.max(0, Number(activeCoordination.radius ?? 0));
  const dx = Math.abs(Number(W.me.x) - Number(activeCoordination.target.x));
  const dy = Math.abs(Number(W.me.y) - Number(activeCoordination.target.y));
  return dx + dy <= radius;
}

// finds the nearest reachable tile matching a row/column/parity spec - each
// agent calls this independently on its own position, so both sides don't
// need to agree on a single shared point (same idea as traffic_light_wait)
function nearestRowColumnTile(spec) {
  if (!W.me || !W.tiles) return null;
  const parity = spec?.rowParity ?? null;
  const row = Number.isFinite(spec?.row) ? Number(spec.row) : null;
  const column = Number.isFinite(spec?.column) ? Number(spec.column) : null;
  if (!parity && row === null && column === null) return null;

  let best = null;
  let bestDist = Infinity;

  for (const tile of W.tiles.values()) {
    if (!tile || tile.walkable === false) continue;
    const y = Number(tile.y);
    const x = Number(tile.x);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    if (parity) {
      const isOdd = Math.abs(y % 2) === 1;
      if (parity === "odd" && !isOdd) continue;
      if (parity === "even" && isOdd) continue;
    }
    if (row !== null && y !== row) continue;
    if (column !== null && x !== column) continue;

    const target = { x, y };
    const path = planPathToTarget(target);
    if (!samePos(W.me, target) && (!Array.isArray(path) || path.length === 0)) continue;

    const d = Math.abs(Number(W.me.x) - x) + Math.abs(Number(W.me.y) - y);
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

function nearestTrafficLightTile(trafficLight) {
  const row = Number.isFinite(trafficLight?.row) ? Number(trafficLight.row) : null;
  let column = Number.isFinite(trafficLight?.column) ? Number(trafficLight.column) : null;
  if (column === null && row === null && (trafficLight?.region === "leftmost" || trafficLight?.region === "rightmost")) {
    column = extremeKnownColumn(trafficLight.region);
  }
  const spec =
    row !== null || column !== null
      ? { row, column }
      : { rowParity: trafficLight?.rowParity ?? "odd" };
  return nearestRowColumnTile(spec);
}

async function maybeReportCoordinationArrival() {
  if (!activeCoordinationReached() || activeCoordination.arrivedSent) return false;
  activeCoordination.arrivedSent = true;
  await sendCoordinationStatus("arrived", {
    radius: activeCoordination.radius,
  });
  return true;
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
  if (plan?.reportPosition === true) {
    positionBeaconEnabled = true;
  }

  if (plan?.objective === "clear_constraints") {
    activeCoordination = null;
    positionBeaconEnabled = false;
    clearIntention();
    return { type: "EXPLORE", target: null };
  }

  if (plan?.mode === "WAIT" || plan?.objective === "wait") {
    return { type: "WAIT", target: null };
  }

  if (plan?.trafficLight) {
    const target = nearestTrafficLightTile(plan.trafficLight);
    if (!target) return { type: "WAIT", target: null };
    rememberCoordinationTarget(
      {
        ...plan,
        objective: "traffic_light_wait",
        radius: 0,
      },
      target
    );
    return samePos(W.me, target)
      ? { type: "WAIT", target: null }
      : { type: "MOVE", target };
  }

  if (Number.isFinite(plan?.meetRow) || Number.isFinite(plan?.meetColumn)) {
    const target = nearestRowColumnTile({ row: plan.meetRow, column: plan.meetColumn });
    if (!target) return { type: "WAIT", target: null };
    rememberCoordinationTarget({ ...plan, objective: "meet_teammate", radius: 0 }, target);
    return samePos(W.me, target)
      ? { type: "WAIT", target: null }
      : { type: "MOVE", target };
  }

  const hintTarget = plan?.moveTo ?? plan?.meetTarget ?? null;
  if (hintTarget) {
    const target = { x: Number(hintTarget.x), y: Number(hintTarget.y) };
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
    rememberCoordinationTarget(plan, target);
    return { type: "MOVE", target };
  }

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
    rememberCoordinationTarget(plan, target);
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

  if (plan.objective === "move_to") {
    const target = plan.targetPosition
      ? { x: Number(plan.targetPosition.x), y: Number(plan.targetPosition.y) }
      : null;
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
    rememberCoordinationTarget(plan, target);
    return { type: "MOVE", target };
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
    if (msg.type === "llm_plan" && msg.plan) {
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

async function maybeUsePDDL(hint, next) {
  if (!CFG.USE_PDDL || !hint || hint.mode === "WAIT") return next;
  if (!missionNeedsPlanning(hint)) return next;

  const startedAt = Date.now();
  const pddlIntent = await getPDDLIntention(hint);
  const elapsed = Date.now() - startedAt;

  if (!pddlIntent) {
    console.warn(`[A][PDDL] No usable plan after ${elapsed}ms; keeping BDI/A* intention.`);
    return next;
  }

  console.log(`[A][PDDL] Using symbolic intention after ${elapsed}ms:`, JSON.stringify(pddlIntent));
  return pddlIntent;
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
    maybeSendPositionBeacon();

    // confirm handoff pickup as soon as the carried set changes
    if (awaitingHandoffPickupParcelId && W.carrying?.has(awaitingHandoffPickupParcelId)) {
      const collectedId = awaitingHandoffPickupParcelId;
      const collectedMissionId = awaitingHandoffMissionId;
      awaitingHandoffPickupParcelId = null;
      awaitingHandoffMissionId = null;
      pendingHandoffParcelId = collectedId;
      pendingHandoffMissionId = collectedMissionId;
      console.log("[A][HANDOFF] Picked up the handed-off parcel, notifying B:", collectedId);
      await sendCoordinationStatus("collected", { targetParcelId: collectedId }, collectedMissionId);
    }

    // a pending handoff parcel leaving W.carrying means it was delivered
    if (pendingHandoffParcelId && !W.carrying?.has(pendingHandoffParcelId)) {
      const deliveredId = pendingHandoffParcelId;
      const deliveredMissionId = pendingHandoffMissionId;
      pendingHandoffParcelId = null;
      pendingHandoffMissionId = null;
      console.log("[A][HANDOFF] Delivered the handed-off parcel, notifying B:", deliveredId);
      await sendCoordinationStatus("delivered", { targetParcelId: deliveredId }, deliveredMissionId);
    }

    // drain inbox and build the coordination hint for this tick
    let hint = drainInboxHint();
    if (!hint && activeCoordination?.target) {
      hint = {
        moveTo: activeCoordination.target,
        meetRadius: activeCoordination.radius,
        llmType: activeCoordination.llmType ?? null,
      };
      if (activeCoordinationReached()) hint.mode = "WAIT";
    }

    // explicit rendezvous hints override normal parcel behaviour
    let forcedMoveTarget = null;
    if (hint && hint.mode !== "WAIT" && (hint.moveTo || hint.meetTarget)) {
      const t = hint.moveTo ?? hint.meetTarget;
      if (t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y))) {
        forcedMoveTarget = { x: Number(t.x), y: Number(t.y) };
        console.log("[A] Forced move target from hint:", forcedMoveTarget);
        warnIfCoordinationTargetInvalid(forcedMoveTarget);
      }
    }

    // collect_parcel is a one-shot pickup target, not a persistent rendezvous
    if (hint?.mode === "WAIT" && hint.llmType === "PICKUP") {
      const attemptedParcelId = awaitingHandoffPickupParcelId;
      const attemptedMissionId = awaitingHandoffMissionId;
      await tryReactiveFollowup(hint);
      // if the parcel is gone on arrival, notify B so it can retry
      if (attemptedParcelId && !W.carrying?.has(attemptedParcelId)) {
        awaitingHandoffPickupParcelId = null;
        awaitingHandoffMissionId = null;
        console.log("[A][HANDOFF] Parcel gone on arrival, notifying B:", attemptedParcelId);
        await sendCoordinationStatus("missed", { targetParcelId: attemptedParcelId }, attemptedMissionId);
      }
      activeCoordination = null;
      clearTargetFailureMemory();
      clearIntention();
      syncCaches();
      return;
    }

    // Wait override from B
    if (hint?.mode === "WAIT") {
      if (intention.type !== "WAIT") {
        clearIntention();
        intention.type   = "WAIT";
        intention.target = null;
        intention.steps  = 0;
        intention.path   = [];
        waitingStatusSent = false;
      }
      // send once per WAIT-state entry, not every tick spent waiting
      if (!waitingStatusSent) {
        waitingStatusSent = true;
        await sendCoordinationStatus("waiting");
      }
      await executeActionIntent(waitAction("hint_wait"), hint);
      return;
    }

    // Reactive layer (pickup/deliver if already standing on tile)
    await maybeReportCoordinationArrival();

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

    // Opportunistic pickup interrupt - skipped during a forced coordination
    // move, or this clears the plan every time something's merely nearby
    if (!forcedMoveTarget && ["DELIVER", "EXPLORE", "PATROL", "MOVE"].includes(intention.type)) {
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

    // Opportunistic pickup override - same guard. shouldPreferOpportunisticPickup()
    // doesn't know about forcedMoveTarget, so without this a coordination
    // MOVE gets silently swapped for a PICKUP plan the moment anything's nearby
    if (!forcedMoveTarget && shouldPreferOpportunisticPickup(hint, next)) {
      const pickupPlan = opportunisticPickupPlan(hint);
      if (pickupPlan) next = pickupPlan;
    }

    next = await maybeUsePDDL(hint, next);

    // deliberate() can itself decide to WAIT (e.g. a committed delivery
    // target just got briefly blacklisted - see forcedDeliveryTarget in
    // targeting.js). unlike the hint.mode === "WAIT" case above, this one
    // comes with a null target and would otherwise fall through to
    // fallbackMove(null), which has no destination and just wanders off
    if (next.type === "WAIT") {
      if (intention.type !== "WAIT") {
        clearIntention();
        intention.type = "WAIT";
        intention.target = null;
        intention.steps = 0;
        intention.path = [];
      }
      await executeActionIntent(waitAction(next.source ?? "deliberate_wait"), hint);
      return;
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
          // a forced coordination target from B is rare (one new target
          // every several seconds, not every tick like normal delivery/
          // pickup queries) but can require a long detour around a one-way
          // section that a plain Manhattan-distance heuristic badly
          // misjudges - not just underestimates the cost (a bigger
          // expansion budget alone wasn't enough), but can actively walk
          // the agent backward when raw distance briefly favors it
          // mid-detour. exact pathing sidesteps the heuristic problem
          // entirely instead of just giving it more room to fail in
          // (see astar.js)
          exact: !!forcedMoveTarget,
        });
        if (!path || (path.length === 0 && !samePos(W.me, next.target))) {
          if (forcedMoveTarget) {
            // a coordination target from B can point at a tile A hasn't
            // mapped yet (each agent explores independently), so blacklisting
            // it here would make it permanently unreachable - just head that
            // way and let the next tick's planPathToTarget retry
            clearIntention();
            await fallbackMove(forcedMoveTarget);
            await tryReactiveFollowup(hint);
            return;
          }
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
      await maybeReportCoordinationArrival();
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
        if (forcedMoveTarget) {
          // never blacklist a coordination target from B - same reasoning
          // as the path-not-found branch above. just reset the failure
          // streak and keep nudging toward it via fallbackMove below
          intention.steps = 0;
        } else if (shouldRelaxFailureHandling()) {
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


// message listener


client.onMsg((id, name, msg, reply) => {
  const parsed = typeof msg === "object" ? msg : tryParseJSON(msg);
  if (!parsed) return;

  if (parsed.type === "llm_plan" && parsed.plan) {
    // accept plans from verified teammates; tolerate missing roster data early
    if (W.knownAgents.has(id) && !isTeammate(id)) {
      console.log("[A] Ignoring llm_plan from non-teammate:", name);
      return;
    }
    lastCoordinatorId = id;
    console.log("[A] Received plan from B:", JSON.stringify(parsed.plan));
    pushPlanFromB(parsed.plan);
    return;
  }

  // ignore unrelated chatter to keep A's console focused
});


function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}
