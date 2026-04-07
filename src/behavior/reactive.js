import { api } from "../client.js";
import { W, clearIntention } from "../world/state.js";
import { onDeliveryTile, carriedParcels, parcelsHere } from "../world/helpers.js";
import { info } from "../config.js";

export async function reactiveAction() {
  const carried = carriedParcels();

  // 1. Deliver immediately if on a delivery tile and carrying something
  if (carried.length && onDeliveryTile()) {
    const dropped = await api.putdown();

    if (Array.isArray(dropped) && dropped.length) {
      for (const p of dropped) {
        const id = String(p.id ?? "");
        if (!id) continue;
        W.carrying.delete(id);
        W.parcels.delete(id);
      }

      clearIntention();
      info("Delivered immediately", dropped.length);
      return true;
    }
  }

  // 2. Pickup parcels on the current tile if any are present
  if (parcelsHere().length > 0) {
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
      info("Picked immediately", picked.length);
      return true;
    }
  }

  return false;
}