import { api } from "../client.js";
import { W , setParcelsDirty, setDeliveryDirty, clearIntention} from "../world/state.js";
import { onDeliveryTile, canPickupHere, carriedParcels } from "../world/helpers.js";
import { key } from "../utils/math.js";
import { info } from "../config.js";  


/**This module implements reactive behaviors that can interrupt the current plan 
* when certain conditions are met, such as being on a delivery tile with parcels 
* to drop off, or being on a pickup tile with parcels available to pick up. 
* These actions take priority over the current intention and can help the agent 
* adapt to dynamic changes in the environment without needing to replan immediately.*/

export async function reactiveAction() {
    const carried = carriedParcels();
    const hereKey = key(W.me.x, W.me.y);

    if (carried.length && onDeliveryTile()) {
        const dropped = await api.putdown();

        if (Array.isArray(dropped) && dropped.length) {
            W.learnedDelivery.add(hereKey);
            setTile(W.me.x, W.me.y, true, false);

            for (const p of dropped) {
                const id = String(p.id ?? "");
                if (!id) continue;

                W.carrying.delete(id);
                W.parcels.delete(id);
            }

            // Mark parcels and delivery status as dirty to trigger updates in the next tick
            setParcelsDirty(true);
            setDeliveryDirty(true);
            clearIntention();

            W.noPickupUntil.set(hereKey, Date.now() + CFG.NO_PICKUP_AFTER_DELIVERY_MS);

            info("Delivered immediately", dropped.length);
            return true;
        }
    }

    if (canPickupHere()) {
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

            //set parcels dirty to trigger updates in the next tick, 
            setParcelsDirty(true);
            clearIntention();
            info("Picked immediately", picked.length);
            return true;
        }
    }

    return false;
}
