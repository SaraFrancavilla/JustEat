import client from "../client.js";
import { W, isTeammate } from "../world/state.js";
import { getMissionPolicy, currentBlockingMission } from "../llm/missions.mjs";
import { isTrustedSender } from "../config.js";

let teammateId =
  process.env.TEAMMATE_ID ||
  process.argv.find((a) => a.startsWith("--teamId="))?.split("=")[1] ||
  null;

const teammateNameHint =
  process.env.TEAMMATE_NAME ||
  process.argv.find((a) => a.startsWith("--teammateName="))?.split("=")[1] ||
  null;

let lastSentPlan = null;
let warnedMissingTeammateId = false;
let notifiedTeammateConnected = false;
let firstMissingTeammateAttemptAt = 0;
const TEAMMATE_WARNING_DELAY_MS = 3000; // discovery usually resolves within a couple seconds - don't warn about the normal case

function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}

function myAgentId() {
  return W.me?.id ?? client?.id ?? null;
}

function myAgentName() {
  return W.me?.name ?? null;
}

function myTeamName() {
  return (
    W.me?.teamName ??
    W.me?.team ??
    W.me?.group ??
    process.env.TEAM_NAME ??
    process.env.TEAM ??
    null
  );
}

function visibleAgents() {
  if (Array.isArray(W.agentList)) return W.agentList;
  if (Array.isArray(W.agents)) return W.agents;
  if (W.agents instanceof Map) return Array.from(W.agents.values());
  return [];
}

function isSameTeam(agent) {
  const mine = norm(myTeamName());
  if (!mine) return false;

  const theirs = norm(agent?.teamName ?? agent?.team ?? agent?.group ?? null);
  return !!theirs && theirs === mine;
}

function matchesTeammateName(agent) {
  if (!teammateNameHint) return false;
  return norm(agent?.name) === norm(teammateNameHint);
}

function discoverTeammateId() {
  if (teammateId) return teammateId;

  // prefer the authoritative roster; it is independent of vision range
  for (const agent of W.knownAgents.values()) {
    if (isTeammate(agent.id)) {
      teammateId = agent.id;
      console.log("[OUTBOX] Discovered teammate id via roster:", teammateId, "name:", agent?.name ?? "unknown");
      return teammateId;
    }
  }

  const mineId = norm(myAgentId());
  const mineName = norm(myAgentName());

  // fallback to visible agents, excluding trusted mission senders
  const agents = visibleAgents().filter((a) => !isTrustedSender(a?.name));
  if (!agents.length) return null;

  let candidate = agents.find((a) => {
    const aid = norm(a?.id);
    if (!aid || aid === mineId) return false;
    if (norm(a?.name) === mineName && mineName) return false;
    return isSameTeam(a);
  });

  if (!candidate && teammateNameHint) {
    candidate = agents.find((a) => {
      const aid = norm(a?.id);
      if (!aid || aid === mineId) return false;
      return matchesTeammateName(a);
    });
  }

  if (!candidate && agents.length === 1) {
    const only = agents[0];
    const aid = norm(only?.id);
    if (aid && aid !== mineId) candidate = only;
  }

  if (candidate?.id) {
    teammateId = candidate.id;
    console.log("[OUTBOX] Discovered teammate id:", teammateId, "name:", candidate?.name ?? "unknown");
    return teammateId;
  }

  return null;
}

export function setTeammateId(id) {
  if (!id) return false;
  if (teammateId === id) return true; // already known - nothing changed, don't reset/log
  teammateId = id;
  warnedMissingTeammateId = false;
  notifiedTeammateConnected = false;
  console.log("[OUTBOX] Teammate id set:", teammateId);
  return true;
}

export function getTeammateId() {
  return teammateId ?? discoverTeammateId() ?? null;
}

export function sendPlanToA(plan) {
  const resolvedId = getTeammateId();

  if (!resolvedId) {
    if (!firstMissingTeammateAttemptAt) firstMissingTeammateAttemptAt = Date.now();
    if (!warnedMissingTeammateId && Date.now() - firstMissingTeammateAttemptAt > TEAMMATE_WARNING_DELAY_MS) {
      console.warn("[OUTBOX] No teammate id available, cannot send plan to Agent A.");
      console.warn(
        "[OUTBOX] Set TEAMMATE_ID or TEAMMATE_NAME, or expose teammate in W.agents/W.agentList with same team metadata."
      );
      warnedMissingTeammateId = true;
    }
    notifiedTeammateConnected = false;
    return false;
  }

  if (!notifiedTeammateConnected) {
    console.log("[OUTBOX] Teammate id detected, can send plans to Agent A:", resolvedId);
    notifiedTeammateConnected = true;
  }

  warnedMissingTeammateId = false;
  firstMissingTeammateAttemptAt = 0;

  if (!plan?.objective) {
    console.warn("[OUTBOX] Tried to send invalid plan:", plan);
    return false;
  }

  const sig = JSON.stringify({ to: resolvedId, plan });
  if (sig === lastSentPlan) return false;
  lastSentPlan = sig;

  const msg = JSON.stringify({ type: "llm_plan", plan });
  client.say(resolvedId, msg);
  console.log("[OUTBOX] Sent plan to Agent A:", plan.objective, "->", resolvedId);
  return true;
}

// tracks whether A currently has an active coordination hint to clear
let coordinationActiveWithA = false;
let lastDiagnosticSig = null;
let suppressClearConstraintsUntil = 0;

// keep A's collect_parcel hint alive while a handoff pickup is still pending
export function suppressClearConstraints(ms) {
  suppressClearConstraintsUntil = Date.now() + ms;
}

export function relayMissionPolicyToA() {
  const policy = getMissionPolicy();
  const blocking = currentBlockingMission();
  // computed across all active missions, not only the current blocker
  const coordinationRequired = !!policy.coordinationRequired;
  const clearConstraintsSuppressed = Date.now() < suppressClearConstraintsUntil;

  if (!coordinationRequired) {
    if (coordinationActiveWithA && policy.mode === "NORMAL_PLAY" && policy.blockingText === "None" && !clearConstraintsSuppressed) {
      sendPlanToA({ objective: "clear_constraints" });
      coordinationActiveWithA = false;
    }
    return;
  }

  if (policy.mode === "NORMAL_PLAY" && policy.blockingText === "None") {
    if (coordinationActiveWithA && !clearConstraintsSuppressed) {
      sendPlanToA({ objective: "clear_constraints" });
      coordinationActiveWithA = false;
    }
    return;
  }

  const hint = {};

  // log only when the coordination target changes
  const diagnosticSig = JSON.stringify({
    moveTo: policy.moveTo,
    meetTarget: policy.meetTarget,
    meetRow: policy.meetRow,
    meetColumn: policy.meetColumn,
    trafficLight: policy.trafficLight,
    blockingSignature: blocking?.signature ?? null,
  });
  if (diagnosticSig !== lastDiagnosticSig) {
    lastDiagnosticSig = diagnosticSig;
    console.log("[OUTBOX] relayMissionPolicyToA: policy.moveTo=", policy.moveTo, "policy.meetTarget=", policy.meetTarget, "policy.meetRow=", policy.meetRow, "policy.meetColumn=", policy.meetColumn, "policy.trafficLight=", policy.trafficLight, "blockingSignature=", blocking?.signature ?? null);
  }

  if (policy.mode === "WAIT") {
    hint.mode = "WAIT";
  }

  if (policy.avoidTiles?.length) {
    hint.avoidTiles = policy.avoidTiles.map((t) => ({
      x: t.x,
      y: t.y,
      penalty: 100,
    }));
  }

  if (policy.moveTo) {
    hint.moveTo = policy.moveTo;
    hint.meetRadius = policy.meetRadius ?? 0;
  }

  if (policy.meetTarget) {
    // include both fields so A can treat this as a rendezvous
    hint.moveTo = policy.meetTarget;
    hint.meetTarget = policy.meetTarget;
    hint.meetRadius = policy.meetRadius ?? 2;
  }

  if (policy.trafficLight) {
    if (policy.trafficLight.target) {
      // explicit traffic-light targets use the same rendezvous path as meet missions
      hint.moveTo = policy.trafficLight.target;
      hint.meetTarget = policy.trafficLight.target;
      hint.meetRadius = Math.max(0, Number(policy.trafficLight.radius ?? 3));
    } else {
      hint.trafficLight = policy.trafficLight;
    }
  }

  if (Number.isFinite(policy.meetRow) || Number.isFinite(policy.meetColumn)) {
    // each agent resolves row/column constraints from its own position
    hint.meetRow = policy.meetRow ?? null;
    hint.meetColumn = policy.meetColumn ?? null;
  }

  if (policy.handoffBonus) {
    // request beacons only while a handoff can actually use them
    hint.reportPosition = true;
  }

  if (Number.isFinite(policy.exactDeliveryCount)) {
    hint.carryTarget = policy.exactDeliveryCount;
  }

  if (Number.isFinite(policy.maxDeliveryCount)) {
    hint.carryTarget = policy.maxDeliveryCount;
  }

  if (policy.avoidPickup) hint.avoidPickup = true;
  if (policy.avoidDelivery) hint.avoidDelivery = true;

  if (Object.keys(hint).length === 0) return;

  hint.objective = "move_to";
  hint.missionId = policy.missionId ?? null;
  hint.missionSignature = policy.missionSignature ?? null;
  coordinationActiveWithA = true;
  sendPlanToA(hint);
}
