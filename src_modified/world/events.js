import client from "../client.js";
import { W, setParcelsDirty } from "./state.js";
import { setTile } from "./tiles.js";
import { key } from "../utils/math.js";
import { debug } from "../config.js";

client.onYou(me => {
    W.me = { ...me };
    setTile(me.x, me.y);
    debug("Position", me.x, me.y);
});

client.onTile(tile => {
    setTile(tile.x, tile.y, tile.delivery);
    if (tile.delivery) {
        W.learnedDelivery.add(key(tile.x, tile.y));
    }
});

// client.onParcelsSensing(list => {
//     W.parcels.clear();

//     for (const p of list) {
//         W.parcels.set(p.id, p);
//     }

//     W.parcelList = [...W.parcels.values()];
//     setParcelsDirty(true);
// });

client.onParcelsSensing(list => {
    W.parcels.clear();

    for (const raw of list) {
        const p = raw?.parcel ?? raw; 

        if (!p?.id) continue;

        W.parcels.set(p.id, {
            id: p.id,
            x: Number(p.x),
            y: Number(p.y),
            reward: Number(p.reward ?? 0),
            carriedBy: p.carriedBy ?? null
        });
    }

    W.parcelList = [...W.parcels.values()];
});