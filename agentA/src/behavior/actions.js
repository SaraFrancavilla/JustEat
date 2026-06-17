import { api } from "../client.js";
import { CFG, info } from "../config.js";
import { carryingCount, parcelsHere } from "../world/helpers.js";
import { W, syncCaches, clearIntention } from "../world/state.js";

export const ActionType = {
  MOVE: "MOVE",
  PICKUP: "PICKUP",
  PUTDOWN: "PUTDOWN",
  WAIT: "WAIT",
};

export function moveAction(direction) { return { type: ActionType.MOVE, direction }; }
export function pickupAction() { return { type: ActionType.PICKUP }; }
export function putdownAction() { return { type: ActionType.PUTDOWN }; }
export function waitAction(reason = null) { return { type: ActionType.WAIT, reason }; }

export function canIssueAction() { return W.prevActionFinished !== false; }

export function markActionIssued() {
  W.prevActionFinished = false;

  clearTimeout(W._actionFailsafe);
  W._actionFailsafe = setTimeout(() => {
    if (W.prevActionFinished === false) {
      console.warn("[FAILSAFE] Action timeout! Forcing prevActionFinished = true to unfreeze.");
      W.prevActionFinished = true;
    }
  }, 1000);
}

export function finishAction() {
  W.prevActionFinished = true;
  clearTimeout(W._actionFailsafe);
}

export function canPickupNow(hint, carriedCount) {
  if (!canIssueAction()) return false;
  if (carriedCount >= (CFG.REACT_HARD_CARRY_LIMIT ?? 15)) return false;
  if (hint?.mode === "WAIT") return false;
  if (hint?.avoidPickup) return false;
  return true;
}

export function canDeliverNow(hint, carriedCount) {
  if (!canIssueAction()) return false;
  if (carriedCount <= 0) return false;
  if (hint?.mode === "WAIT") return false;
  if (hint?.avoidDelivery) return false;
  if (Number.isFinite(hint?.exactDeliveryCount)) {
    return carriedCount === Number(hint.exactDeliveryCount);
  }
  if (Number.isFinite(hint?.minDeliveryCount) && carriedCount < Number(hint.minDeliveryCount)) return false;
  if (Number.isFinite(hint?.maxDeliveryCount) && carriedCount > Number(hint.maxDeliveryCount)) return false;
  return true;
}

export function coerceActionToMission(intent, hint) {
  if (!intent) return null;

  let normalized = intent;
  if (intent.type === "DELIVER") normalized = { ...intent, type: ActionType.PUTDOWN };
  if (!hint) return normalized;

  if (hint.mode === "WAIT") return waitAction("hint_wait");

  if (normalized.type === ActionType.PICKUP) {
    if (!canPickupNow(hint, carryingCount())) return null;
  }
  if (normalized.type === ActionType.PUTDOWN) {
    if (!canDeliverNow(hint, carryingCount())) return null;
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

function snapshotCarriedParcels() {
  const ids = [...(W.carrying ?? [])];
  const out = [];

  for (const id of ids) {
    const parcel = W.parcels?.get?.(String(id));
    if (!parcel) {
      out.push({
        id: String(id),
        reward: 0,
      });
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

function formatDeliveredParcelScores(parcels = []) {
  const sorted = [...parcels].sort((a, b) => Number(b.reward ?? 0) - Number(a.reward ?? 0));
  return sorted.map((p) => `${String(p.id)}:${Number(p.reward ?? 0)}`);
}

export async function executeActionIntent(intent, hint = null) {
  if (!intent || !canIssueAction()) return false;

  const finalIntent = coerceActionToMission(intent, hint);
  if (!finalIntent) return false;

  if (finalIntent.type === ActionType.WAIT) return false;

  // ── Pickup ───────────────────────────────────────────────────────────────
  if (finalIntent.type === ActionType.PICKUP) {
    const carriedCountBeforePickup = carryingCount();
    const parcelsAtFeet = parcelsHere();

    if (!canPickupNow(hint, carriedCountBeforePickup)) {
      info("[HINT] Pickup blocked: carrying", carriedCountBeforePickup);
      return false;
    }
    if (!parcelsAtFeet.length) return false;

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

    if (!pickupOk) return false;

    const effectivePicked = mergeUniqueParcels(
      Array.isArray(picked) ? picked : [],
      parcelsAtFeet
    );
    if (!effectivePicked.length) return false;

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
      if (!alreadyHad) newlyAdded++;
    }

    syncCaches();
    clearIntention();
    info(`Picked up ${newlyAdded} package(s). (Now carrying ${carryingCount()})`);
    return newlyAdded > 0;
  }

  // ── Putdown ──────────────────────────────────────────────────────────────
  if (finalIntent.type === ActionType.PUTDOWN) {
    const carriedCountBeforeDrop = carryingCount();

    if (!canDeliverNow(hint, carriedCountBeforeDrop)) {
      info("[HINT] Delivery blocked: carrying", carriedCountBeforeDrop);
      return false;
    }

    const carriedSnapshot = snapshotCarriedParcels();

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

    if (!putdownOk) return false;

    const droppedIds = new Set(
      (Array.isArray(dropped) ? dropped : [])
        .map((p) => String(p?.id ?? ""))
        .filter(Boolean)
    );

    if (!droppedIds.size && carriedCountBeforeDrop > 0) {
      for (const id of [...(W.carrying ?? [])]) droppedIds.add(String(id));
    }
    if (!droppedIds.size) return false;

    const deliveredParcels = carriedSnapshot.filter((p) => droppedIds.has(String(p.id)));
    const deliveredScores = formatDeliveredParcelScores(deliveredParcels);
    const deliveredTotalScore = deliveredParcels.reduce(
      (sum, p) => sum + Number(p.reward ?? 0),
      0
    );

    for (const id of droppedIds) {
      W.carrying?.delete(id);
      W.parcels.delete(id);
    }

    syncCaches();
    clearIntention();

    info(
      `Delivered ${droppedIds.size} package(s) for ${deliveredTotalScore} total score. ` +
      `[${deliveredScores.join(", ")}] (Now carrying ${carryingCount()})`
    );

    return true;
  }

  return false;
}