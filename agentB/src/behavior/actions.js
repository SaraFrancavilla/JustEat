import api from "../client.js";
import { CFG, debug, info } from "../config.js";
import { carryingCount, parcelsHere, carriedParcels, blacklistGoal, onDeliveryTile } from "../world/helpers.js";
import { W, syncCaches, clearIntention } from "../world/state.js";
import {
  completeDeliverRuleMissionsIfSatisfied,
  completeDropRuleMissionsIfSatisfied,
} from "../llm/missions.mjs";
import { deliveryAllowed, deliveryRequiredCarryTarget, normalizeMissionPolicy } from "../llm/mission-policies.js";

export const ActionType = {
  MOVE: "MOVE",
  PICKUP: "PICKUP",
  PUTDOWN: "PUTDOWN",
  WAIT: "WAIT",
};

// how long a parcel dropped on the ground for a drop_rule mission (i.e. NOT
// on a real delivery tile) stays off-limits to this agent's own pickup
// logic. the parcel physically remains on the tile after the drop, so
// without this the very next parcels-sensing update re-adds it underfoot
// and the agent - or baseline, the instant the one-shot mission archives -
// grabs it straight back and carries it off to a normal delivery tile,
// undoing the drop the mission required (the exact observed failure). long
// on purpose: once the mission's satisfied there is no benefit to ever
// reclaiming that specific parcel, and doing so risks forfeiting the drop
// reward, so we simply leave it there for the rest of any realistic match
const DROP_RULE_LEAVE_BLACKLIST_MS = 300000;

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
  if (!canIssueAction()) {
    debug('[ACTION] canPickupNow => blocked: cannot issue action (prevActionFinished=false)');
    return false;
  }
  const hardLimit = CFG.REACT_HARD_CARRY_LIMIT ?? 15;
  if (carriedCount >= hardLimit) {
    debug('[ACTION] canPickupNow => blocked: reached hard carry limit', { carriedCount, hardLimit });
    return false;
  }

  if (missionOrPolicy == null) return true;
  const policy = normalizeMissionPolicy(missionOrPolicy);
  if (policy?.wait?.mustWait) {
    debug('[ACTION] canPickupNow => blocked: mission wait active', { policy });
    return false;
  }
  if (policy?.pickup?.enabled === false) {
    debug('[ACTION] canPickupNow => blocked: pickup disabled by policy', { policy });
    return false;
  }

  // physical limits here, not delivery limits
  if (Number.isFinite(policy?.pickup?.maxCarry) && carriedCount >= policy.pickup.maxCarry) {
    debug('[ACTION] canPickupNow => blocked: reached mission maxCarry', { carriedCount, maxCarry: policy.pickup.maxCarry });
    return false;
  }
  if (Number.isFinite(policy?.pickup?.exactCarry) && carriedCount >= policy.pickup.exactCarry) {
    debug('[ACTION] canPickupNow => blocked: reached mission exactCarry', { carriedCount, exactCarry: policy.pickup.exactCarry });
    return false;
  }

  const maxTotalScore = policy?.delivery?.maxTotalScore;
  if (Number.isFinite(maxTotalScore)) {
    const currentTotal = carriedParcels().reduce((s, p) => s + Number(p?.reward ?? 0), 0);
    if (currentTotal >= maxTotalScore) {
      debug('[ACTION] canPickupNow => blocked: total carried score already at/over cap', { currentTotal, maxTotalScore });
      return false;
    }
  }

  return true;
}

export function canDeliverNow(missionOrPolicy, carriedCount) {
  if (!canIssueAction()) return false;
  if (carriedCount <= 0) return false;

  if (missionOrPolicy == null) return true;
  const policy = normalizeMissionPolicy(missionOrPolicy);
  if (policy?.wait?.mustWait) return false;
  if (policy?.delivery?.enabled === false) return false;
  if (!deliveryAllowed(policy, { carriedCount })) {
    debug('[ACTION] canDeliverNow => blocked: delivery count does not satisfy mission rule', { carriedCount });
    return false;
  }
  const carryTarget = deliveryRequiredCarryTarget(policy);
  if (Number.isFinite(carryTarget) && carriedCount < carryTarget) {
    debug('[ACTION] canDeliverNow => blocked: carrying fewer parcels than mission target', { carriedCount, carryTarget });
    return false;
  }

  const d = policy?.delivery;
  if (d && (Number.isFinite(d.minTotalScore) || Number.isFinite(d.maxTotalScore))) {
    const total = carriedParcels().reduce((s, p) => s + Number(p?.reward ?? 0), 0);
    if (Number.isFinite(d.minTotalScore) && total < d.minTotalScore) {
      debug('[ACTION] canDeliverNow => blocked: carried total below delivery.minTotalScore', { total, minTotalScore: d.minTotalScore });
      return false;
    }
    if (Number.isFinite(d.maxTotalScore) && total > d.maxTotalScore) {
      debug('[ACTION] canDeliverNow => blocked: carried total exceeds delivery.maxTotalScore', { total, maxTotalScore: d.maxTotalScore });
      return false;
    }
  }

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
    debug('[ACTION] Attempting PICKUP', { policy, carriedCountBeforePickup, parcelsAtFeetLength: parcelsAtFeet.length });
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
    const newlyAddedParcels = [];
    for (const p of effectivePicked) {
      const id = String(p?.id ?? "");
      if (!id) continue;
      if (!W.carrying.has(id)) {
        newlyAddedParcels.push(p);
        W.carrying.add(id);
      }
    }
    syncCaches();
    clearIntention();
    if (newlyAddedParcels.length > 0) {
      const pickedScores = newlyAddedParcels
        .sort((a, b) => Number(b.reward ?? 0) - Number(a.reward ?? 0))
        .map((p) => `${String(p.id)}:${Number(p.reward ?? 0)}`);
      info(`Picked up ${newlyAddedParcels.length} package(s) [${pickedScores.join(", ")}]. (Now carrying ${carryingCount()})`);
    }
    return newlyAddedParcels.length > 0;
  }

  if (finalIntent.type === ActionType.PUTDOWN) {
    const carriedCountBeforeDrop = carryingCount();
    if (!canDeliverNow(policy, carriedCountBeforeDrop)) return false;
    const carriedSnapshotBeforeDrop = snapshotCarriedParcels();
    // enforce delivery parcel-score constraints before attempting putdown
    const d = policy?.delivery;
    if (d && Number.isFinite(d.maxParcelScore)) {
      const violating = carriedSnapshotBeforeDrop.find((p) => Number(p?.reward ?? 0) > d.maxParcelScore);
      if (violating) {
        debug('[ACTION] Blocking PUTDOWN => parcel exceeds delivery.maxParcelScore', { maxParcelScore: d.maxParcelScore, violatingParcel: violating });
        return false;
      }
    }
    // total-score min/max already enforced above by canDeliverNow()
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

    // where this putdown happened, independent of what the ack contains -
    // prefer the server's own reported position for a dropped parcel when
    // present, otherwise the freshest server-confirmed position
    // (W.lastServerPos, never the optimistic-only W.me - see events.js).
    // this is what actually determines whether a drop_rule mission's
    // exact-tile requirement was satisfied, and it holds regardless of
    // whether the ack below is empty or not
    const serverDroppedList = Array.isArray(dropped) ? dropped : [];
    const firstDropped = serverDroppedList[0];
    const dropPosition =
      Number.isFinite(Number(firstDropped?.x)) && Number.isFinite(Number(firstDropped?.y))
        ? { x: Number(firstDropped.x), y: Number(firstDropped.y) }
        : (W.lastServerPos ?? W.me);
    const droppedOnDeliveryTile = onDeliveryTile();

    const droppedIds = new Set(serverDroppedList.map((p) => String(p?.id ?? "")).filter(Boolean));
    // the putdown ack normally comes back empty for a non-scored ground
    // drop - dropping somewhere that isn't a real delivery tile, which is
    // exactly what a drop_rule mission's own target usually is, since
    // nothing was "delivered" for the server to report back. that's the
    // expected response here, not a sign the drop failed - WHERE it landed
    // is already established above from dropPosition, independent of this
    for (const id of [...(W.carrying ?? [])]) droppedIds.add(String(id));

    if (!droppedIds.size) return false;

    for (const id of droppedIds) {
      W.carrying?.delete(id);
      W.parcels.delete(id);
    }

    syncCaches();
    clearIntention();

    completeDeliverRuleMissionsIfSatisfied(carriedCountBeforeDrop);
    completeDropRuleMissionsIfSatisfied(dropPosition, droppedIds.size);

    const deliveredParcels = carriedSnapshotBeforeDrop.filter((p) => droppedIds.has(String(p.id)));
    const deliveredTotalScore = deliveredParcels.reduce((sum, p) => sum + Number(p.reward ?? 0), 0);
    const deliveredScores = deliveredParcels
      .sort((a, b) => Number(b.reward ?? 0) - Number(a.reward ?? 0))
      .map((p) => `${String(p.id)}:${Number(p.reward ?? 0)}`);

    // distinguish normal deliveries from mission-specific ground drops
    info(
      `${droppedOnDeliveryTile ? "Delivered" : "Dropped"} ${droppedIds.size} package(s) for ${deliveredTotalScore} total score. ` +
      `[${deliveredScores.join(", ")}] (Now carrying ${carryingCount()})`
    );

    return true;
  }

  return false;
}

export function executeBaselineActionIntent(intent, hint = null) {
  return executeActionIntent(intent, hint, "baseline");
}

// how long a just-dropped handoff parcel stays off-limits to this agent's
// own pickup logic, so it doesn't grab it right back before the teammate
// gets there. must stay >= HANDOFF_RETRY_COOLDOWN_MS in mainLoop.js - the
// meet radius there is short now, so the teammate's remaining walk is short too
const HANDOFF_PICKUP_BLACKLIST_MS = 18000;

// puts the carried parcel down right here, not on a delivery tile, so a
// teammate can pick it up and deliver it themselves (handoff_bonus).
// bypasses canDeliverNow()/the delivery-tile requirement since it's not a
// scoring delivery. only ever call with exactly one parcel carried - the
// underlying putdown() drops everything held at once
export async function executeHandoffDrop() {
  if (!canIssueAction()) return null;
  const carriedCountBeforeDrop = carryingCount();
  if (carriedCountBeforeDrop !== 1) {
    debug('[ACTION] executeHandoffDrop => refused: expected exactly 1 carried parcel', { carriedCountBeforeDrop });
    return null;
  }

  const [parcelId] = [...(W.carrying ?? [])];
  const beforeSnapshot = W.parcels?.get?.(String(parcelId)) ?? null;

  markActionIssued();
  let dropped = null;
  let putdownOk = false;
  try {
    dropped = await api.putdown();
    putdownOk = true;
  } catch (err) {
    console.error("[ACTION] api.putdown (handoff) failed", err);
  } finally {
    finishAction();
  }

  if (!putdownOk) return null;

  const droppedIds = new Set((Array.isArray(dropped) ? dropped : []).map((p) => String(p?.id ?? "")).filter(Boolean));
  if (!droppedIds.size) droppedIds.add(String(parcelId));

  const droppedAt = { x: Number(W.me?.x ?? 0), y: Number(W.me?.y ?? 0) };
  const droppedParcels = [];
  for (const id of droppedIds) {
    W.carrying?.delete(id);
    // unlike a normal delivery this parcel stays in W.parcels - still on
    // the map, just no longer carried. next onParcelsSensing will refresh it
    const prev = W.parcels?.get?.(id) ?? beforeSnapshot ?? {};
    const updated = { ...prev, id, x: droppedAt.x, y: droppedAt.y, carriedBy: null };
    W.parcels?.set?.(id, updated);
    droppedParcels.push(updated);
    blacklistGoal(updated, HANDOFF_PICKUP_BLACKLIST_MS);
  }

  syncCaches();
  clearIntention();
  info(`Handoff: dropped ${droppedParcels.length} package(s) at (${droppedAt.x},${droppedAt.y}) for teammate to collect. [${droppedParcels.map((p) => `${p.id}:${Number(p.reward ?? 0)}`).join(", ")}]`);

  return droppedParcels;
}
