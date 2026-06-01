import { api } from "../client.js";
import { W, clearIntention } from "../world/state.js";
import { onDeliveryTile, carriedParcels, parcelsHere } from "../world/helpers.js";
import { info } from "../config.js";

function activeMissionPolicy() {
  if (W.activeMission?.accepted && W.activeMission?.status === "active") {
    return W.activeMission.policy ?? {};
  }
  return {};
}

function deliveryAllowed(carriedCount) {
  const delivery = activeMissionPolicy().delivery;
  if (!delivery) return true;

  if (Number.isFinite(delivery.exactCount)) {
    return carriedCount === delivery.exactCount;
  }

  const min = Number.isFinite(delivery.minParcels) ? delivery.minParcels : 0;
  const max = Number.isFinite(delivery.maxParcels) ? delivery.maxParcels : Infinity;

  return carriedCount >= min && carriedCount <= max;
}

function pickupAllowed(carriedCount) {
  const pickup = activeMissionPolicy().pickup;
  if (!pickup) return true;

  if (Number.isFinite(pickup.maxCarry) && carriedCount >= pickup.maxCarry) {
    return false;
  }

  return true;
}

function mustWaitNow() {
  const wait = activeMissionPolicy().wait;
  if (!wait) return false;
  return Number.isFinite(wait.until) && Date.now() < wait.until;
}

export async function reactiveAction() {
  if (mustWaitNow()) {
    info("[MISSION] Waiting due to active mission.");
    return false;
  }

  const carried = carriedParcels();

  // Deliver immediately if on a delivery tile and carrying something,
  // but only if the active mission allows it.
  if (carried.length && onDeliveryTile()) {
    if (!deliveryAllowed(carried.length)) {
      info(
        "[MISSION] Delivery blocked:",
        `carrying ${carried.length}`,
        `mission ${JSON.stringify(activeMissionPolicy().delivery ?? {})}`
      );
    } else {
      const dropped = await api.putdown();

      if (Array.isArray(dropped) && dropped.length) {
        for (const p of dropped) {
          const id = String(p.id ?? "");
          if (!id) continue;
          W.carrying.delete(id);
          W.parcels.delete(id);
        }

        clearIntention();
        info("Delivered", dropped.length, "package(s)");

        // If this was a delivery-rule mission, consider it completed
        if (W.activeMission?.objectiveType === "deliver_rule") {
          W.activeMission.status = "completed";
          info("[MISSION] Delivery mission completed.");
        }

        return true;
      }
    }
  }

  const carryLimit = W.strategy?.carryTarget ?? 2;
  const missionPickupCap = activeMissionPolicy().pickup?.maxCarry;
  const effectivePickupCap = Number.isFinite(missionPickupCap)
    ? Math.min(20, missionPickupCap)
    : 20;

  if (
    carried.length < effectivePickupCap &&
    pickupAllowed(carried.length) &&
    parcelsHere().length > 0
  ) {
    const picked = await api.pickup();

    if (Array.isArray(picked) && picked.length) {
      for (const p of picked) {
        const id = String(p.id);
        const prev = W.parcels.get(id) ?? {};

        W.parcels.set(id, {
          ...prev,
          id,
          x: Number(p.x ?? W.me.x),
          y: Number(p.y ?? W.me.y),
          reward: Number(p.reward ?? prev.reward ?? 0),
          carriedBy: W.me.id
        });

        W.carrying.add(id);
      }

      clearIntention();
      info(
        `Picked up ${picked.length} package(s). (Carrying ${carried.length + picked.length}/${carryLimit})`
      );
      return true;
    }
  }

  return false;
}