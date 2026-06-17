import client from "../client.js";
import { W } from "../world/state.js";
import { getMissionPolicy, currentBlockingMission } from "../llm/missions.mjs";

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

  const mineId = norm(myAgentId());
  const mineName = norm(myAgentName());

  const agents = visibleAgents();
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
    if (!warnedMissingTeammateId) {
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

export function resetLastSentPlan() {
  lastSentPlan = null;
}

export function relayMissionPolicyToA() {
  const policy = getMissionPolicy();
  const blocking = currentBlockingMission();
  const coordinationRequired = !!(
    blocking?.policy?.requiresCoordination ||
    blocking?.policy?.meetTeammate ||
    blocking?.policy?.handoffBonus
  );

  if (!coordinationRequired) {
    if (policy.mode === "NORMAL_PLAY" && policy.blockingText === "None") {
      sendPlanToA({ objective: "CLEAR_CONSTRAINTS" });
    }
    return;
  }

  if (policy.mode === "NORMAL_PLAY" && policy.blockingText === "None") {
    sendPlanToA({ objective: "CLEAR_CONSTRAINTS" });
    return;
  }

  const hint = {};

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
    hint.moveTo = policy.meetTarget;
    hint.meetRadius = policy.meetRadius ?? 2;
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

  hint.objective = `mission:${policy.missionSignature ?? "active"}`;
  sendPlanToA(hint);
}