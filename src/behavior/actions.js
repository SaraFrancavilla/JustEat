import { api } from "../client.js";
import { CFG, info } from "../config.js";
import { carryingCount, parcelsHere } from "../world/helpers.js";
import { W, syncCaches, clearIntention } from "../world/state.js";
import {
  getMissionPolicy,
  completeDeliverRuleMissionsIfSatisfied,
} from "../llm/missions.mjs";

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

export function markActionIssued() {
  W.prevActionFinished = false;
}

export function finishAction() {
  W.prevActionFinished = true;
}

export function canPickupNow(mission, carriedCount) {
  if (!canIssueAction()) return false;

  const hardLimit = CFG.REACT_HARD_CARRY_LIMIT ?? 15;
  if (carriedCount >= hardLimit) return false;

  if (mission?.mode === "WAIT") return false;
  if (mission?.avoidPickup) return false;

  return true;
}

export function canDeliverNow(mission, carriedCount) {
  if (!canIssueAction()) return false;
  if (carriedCount <= 0) return false;

  if (mission?.mode === "WAIT") return false;
  if (mission?.avoidDelivery) return false;

  if (Number.isFinite(mission?.exactDeliveryCount)) {
    return carriedCount === Number(mission.exactDeliveryCount);
  }

  if (
    Number.isFinite(mission?.minDeliveryCount) &&
    carriedCount < Number(mission.minDeliveryCount)
  ) {
    return false;
  }

  if (
    Number.isFinite(mission?.maxDeliveryCount) &&
    carriedCount > Number(mission.maxDeliveryCount)
  ) {
    return false;
  }

  if (
    Number.isFinite(mission?.minExclusiveDeliveryCount) &&
    carriedCount <= Number(mission.minExclusiveDeliveryCount)
  ) {
    return false;
  }

  if (
    Number.isFinite(mission?.maxExclusiveDeliveryCount) &&
    carriedCount >= Number(mission.maxExclusiveDeliveryCount)
  ) {
    return false;
  }

  return true;
}

export function coerceActionToMission(intent, mission) {
  if (!intent) return null;

  let normalized = intent;
  if (intent.type === "DELIVER") {
    normalized = { ...intent, type: ActionType.PUTDOWN };
  }

  if (!mission) return normalized;

  if (mission.mode === "WAIT") {
    return waitAction("mission_wait");
  }

  if (normalized.type === ActionType.PICKUP) {
    const carriedCount = carryingCount();
    if (!canPickupNow(mission, carriedCount)) return null;
  }

  if (normalized.type === ActionType.PUTDOWN) {
    const carriedCount = carryingCount();
    if (!canDeliverNow(mission, carriedCount)) return null;
  }

  return normalized;
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

export async function executeActionIntent(intent, missionOverride = null) {
  if (!intent || !canIssueAction()) return false;

  const mission = missionOverride ?? getMissionPolicy();
  const finalIntent = coerceActionToMission(intent, mission);
  if (!finalIntent) return false;

  if (finalIntent.type === ActionType.WAIT) {
    return false;
  }

  if (finalIntent.type === ActionType.PICKUP) {
    const carriedCountBeforePickup = carryingCount();
    const parcelsAtFeetBeforePickup = parcelsHere();

    if (!canPickupNow(mission, carriedCountBeforePickup)) {
      info(
        "[MISSION] Pickup blocked:",
        `carrying ${carriedCountBeforePickup}`,
        `exactCount ${mission?.exactDeliveryCount ?? "none"}`,
        `avoidPickup ${mission?.avoidPickup ?? false}`
      );
      return false;
    }

    if (!parcelsAtFeetBeforePickup.length) {
      return false;
    }

    markActionIssued();

    let picked = null;
    let pickupOk = false;

    try {
      picked = await api.pickup();
      pickupOk = true;
    } catch (err) {
      console.error("[ACTION] api.pickup failed:", err);
    } finally {
      finishAction();
    }

    if (!pickupOk) {
      return false;
    }

    const effectivePicked = mergeUniqueParcels(
      Array.isArray(picked) ? picked : [],
      parcelsAtFeetBeforePickup
    );

    if (!effectivePicked.length) {
      return false;
    }

    if (!W.carrying) W.carrying = new Set();

    let newlyAdded = 0;

    for (const p of effectivePicked) {
      const id = String(p?.id ?? "");
      if (!id) continue;

      const alreadyHad = W.carrying.has(id);
      const prev = W.parcels.get(id) ?? {};

      W.parcels.set(id, {
        ...prev,
        id,
        x: Number(W.me?.x ?? p?.x ?? prev.x ?? 0),
        y: Number(W.me?.y ?? p?.y ?? prev.y ?? 0),
        reward: Number(p?.reward ?? prev.reward ?? 0),
        carriedBy: W.me?.id ?? prev.carriedBy ?? null,
      });

      W.carrying.add(id);
      if (!alreadyHad) newlyAdded += 1;
    }

    syncCaches();
    clearIntention();
    info(`Picked up ${newlyAdded} package(s). (Now carrying ${carryingCount()})`);
    return newlyAdded > 0;
  }

  if (finalIntent.type === ActionType.PUTDOWN) {
    const carriedCountBeforeDrop = carryingCount();

    if (!canDeliverNow(mission, carriedCountBeforeDrop)) {
      info(
        "[MISSION] Delivery blocked:",
        `carrying ${carriedCountBeforeDrop}`,
        `exactCount ${mission?.exactDeliveryCount ?? "none"}`,
        `avoidDelivery ${mission?.avoidDelivery ?? false}`
      );
      return false;
    }

    markActionIssued();

    let dropped = null;
    let putdownOk = false;

    try {
      dropped = await api.putdown();
      putdownOk = true;
    } catch (err) {
      console.error("[ACTION] api.putdown failed:", err);
    } finally {
      finishAction();
    }

    if (!putdownOk) {
      return false;
    }

    const droppedIds = new Set(
      (Array.isArray(dropped) ? dropped : [])
        .map((p) => String(p?.id ?? ""))
        .filter(Boolean)
    );

    if (!droppedIds.size && carriedCountBeforeDrop > 0) {
      for (const id of [...W.carrying]) droppedIds.add(String(id));
    }

    if (!droppedIds.size) {
      return false;
    }

    for (const id of droppedIds) {
      W.carrying?.delete(id);
      W.parcels.delete(id);
    }

    syncCaches();
    clearIntention();
    info(`Delivered ${droppedIds.size} package(s). (Now carrying ${carryingCount()})`);

    completeDeliverRuleMissionsIfSatisfied(carriedCountBeforeDrop);
    return true;
  }

  return false;
}