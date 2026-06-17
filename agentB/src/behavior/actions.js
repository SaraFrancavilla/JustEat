import api from "../client.js";
import { CFG, info } from "../config.js";
import { carryingCount, parcelsHere } from "../world/helpers.js";
import { W, syncCaches, clearIntention } from "../world/state.js";
import {
  completeDeliverRuleMissionsIfSatisfied,
  completeDropRuleMissionsIfSatisfied,
} from "../llm/missions.mjs";
import { normalizeMissionPolicy } from "../llm/mission-policies.js";

export const ActionType = {
  MOVE: "MOVE",
  PICKUP: "PICKUP",
  PUTDOWN: "PUTDOWN",
  WAIT: "WAIT",
};

export function moveAction(direction) {
  return { type: ActionType.MOVE, direction };
}

export function pickupAction() {
  return { type: ActionType.PICKUP };
}

export function putdownAction() {
  return { type: ActionType.PUTDOWN };
}

export function waitAction(reason = null) {
  return { type: ActionType.WAIT, reason };
}

export function canIssueAction() {
  return W.prevActionFinished !== false;
}

export function markActionIssued(baseline = false) {
  W.prevActionFinished = false;
  clearTimeout(W.actionFailsafe);
  W.actionFailsafe = setTimeout(() => {
    if (W.prevActionFinished === false) {
      console.warn(`[${baseline ? "FAILSAFE" : "FAILSAFE"}] Action timeout! Forcing prevActionFinished=true.`);
      W.prevActionFinished = true;
    }
  }, 1000);
}

export function finishAction() {
  W.prevActionFinished = true;
  clearTimeout(W.actionFailsafe);
}

export function canPickupNow(missionOrPolicy, carriedCount) {
  if (!canIssueAction()) return false;
  const hardLimit = CFG.REACT_HARD_CARRY_LIMIT ?? 15;
  if (carriedCount >= hardLimit) return false;

  if (missionOrPolicy == null) return true;
  const policy = normalizeMissionPolicy(missionOrPolicy);
  if (policy?.wait?.mustWait) return false;
  if (policy?.pickup?.enabled === false) return false;
  
  // Enforce physical limits here, NOT delivery limits
  if (Number.isFinite(policy?.pickup?.maxCarry) && carriedCount >= policy.pickup.maxCarry) return false;
  if (Number.isFinite(policy?.pickup?.exactCarry) && carriedCount >= policy.pickup.exactCarry) return false;

  return true;
}

export function canDeliverNow(missionOrPolicy, carriedCount) {
  if (!canIssueAction()) return false;
  if (carriedCount <= 0) return false;

  if (missionOrPolicy == null) return true;
  const policy = normalizeMissionPolicy(missionOrPolicy);
  if (policy?.wait?.mustWait) return false;
  if (policy?.delivery?.enabled === false) return false;

  return true;
}

function mergeUniqueParcels(primary = [], fallback = []) {
  const out = [];
  const seen = new Set();
  for (const p of [...primary, ...fallback]) {
    const id = String(p?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

function snapshotCarriedParcels() {
  const ids = [...(W.carrying ?? [])];
  const out = [];
  for (const id of ids) {
    const parcel = W.parcels?.get?.(String(id));
    if (!parcel) {
      out.push({ id: String(id), reward: 0 });
      continue;
    }
    out.push({
      id: String(parcel.id ?? id),
      reward: Number(parcel.reward ?? 0),
      x: Number(parcel.x ?? 0),
      y: Number(parcel.y ?? 0),
    });
  }
  return out;
}

export function coerceActionToMission(intent, missionOrPolicy) {
  if (!intent) return null;
  let normalized = intent;
  if (intent.type === "DELIVER") normalized = { ...intent, type: ActionType.PUTDOWN };

  if (missionOrPolicy == null) return normalized;
  const policy = normalizeMissionPolicy(missionOrPolicy);

  if (policy?.wait?.mustWait) return waitAction(missionOrPolicy.wait);
  
  if (normalized.type === ActionType.PICKUP) {
    if (!canPickupNow(policy, carryingCount())) return null;
  } else if (normalized.type === ActionType.PUTDOWN) {
    if (!canDeliverNow(policy, carryingCount())) return null;
  }
  
  return normalized;
}

export async function executeActionIntent(intent, missionOverride = undefined, mode = "mission") {
  if (!intent || !canIssueAction()) return false;

  const baselineMode = mode === "baseline";
  const mission = missionOverride !== undefined ? missionOverride : (baselineMode ? null : undefined); // Simplified for drop-in
  const policy = normalizeMissionPolicy(mission);
  const finalIntent = coerceActionToMission(intent, policy);

  if (!finalIntent || finalIntent.type === ActionType.WAIT) return false;

  if (finalIntent.type === ActionType.PICKUP) {
    const carriedCountBeforePickup = carryingCount();
    if (!canPickupNow(policy, carriedCountBeforePickup)) return false;

    const parcelsAtFeet = parcelsHere();
    if (!parcelsAtFeet.length) return false;

    markActionIssued();
    let picked = null;
    let pickupOk = false;
    try {
      picked = await api.pickup();
      pickupOk = true;
    } catch (err) {
      console.error("[ACTION] api.pickup failed", err);
    } finally {
      finishAction();
    }

    if (!pickupOk) return false;

    const effectivePicked = mergeUniqueParcels(Array.isArray(picked) ? picked : [], parcelsAtFeet);
    if (!effectivePicked.length) return false;

    if (!W.carrying) W.carrying = new Set();
    let newlyAdded = 0;
    for (const p of effectivePicked) {
      const id = String(p?.id ?? "");
      if (!id) continue;
      if (!W.carrying.has(id)) {
        newlyAdded++;
        W.carrying.add(id);
      }
    }
    syncCaches();
    clearIntention();
    return newlyAdded > 0;
  }

  if (finalIntent.type === ActionType.PUTDOWN) {
    const carriedCountBeforeDrop = carryingCount();
    if (!canDeliverNow(policy, carriedCountBeforeDrop)) return false;

    const carriedSnapshotBeforeDrop = snapshotCarriedParcels();
    markActionIssued();

    let dropped = null;
    let putdownOk = false;
    try {
      dropped = await api.putdown();
      putdownOk = true;
    } catch (err) {
      console.error("[ACTION] api.putdown failed", err);
    } finally {
      finishAction();
    }

    if (!putdownOk) return false;

    const droppedIds = new Set((Array.isArray(dropped) ? dropped : []).map((p) => String(p?.id ?? "")).filter(Boolean));
    if (!droppedIds.size && carriedCountBeforeDrop > 0) {
      for (const id of [...(W.carrying ?? [])]) droppedIds.add(String(id));
    }

    if (!droppedIds.size) return false;

    for (const id of droppedIds) {
      W.carrying?.delete(id);
      W.parcels.delete(id);
    }
    
    syncCaches();
    clearIntention();

    completeDeliverRuleMissionsIfSatisfied(carriedCountBeforeDrop);
    completeDropRuleMissionsIfSatisfied(W.me, droppedIds.size);

    return true;
  }

  return false;
}

export function executeBaselineActionIntent(intent, hint = null) {
  return executeActionIntent(intent, hint, "baseline");
}