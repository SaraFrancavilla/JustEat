import client from "../client.js";
import { W} from "./state.js";
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


//Save only parcels that are on the map and ignore the ones that are being carried by other agents
client.onParcelsSensing(list => {

    W.parcels.clear();

    for (const raw of list) {
        const p = raw?.parcel ?? raw;
        if (!p?.id) continue;
        
        if (p.carriedBy == null) {
             W.parcels.set(String(p.id), {
                id: p.id,
                x: Number(p.x),
                y: Number(p.y),
                reward: Number(p.reward ?? 0)
            });
        }
    }}
);