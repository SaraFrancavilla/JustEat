import client from "../client.js";
import { W } from "./state.js";
import { setTile, normalizeTileArgs } from "./tiles.js";
import { key, R } from "../utils/math.js";
import { debug } from "../config.js";

client.onYou(me => {
  W.me = { ...me };

  const k = key(R(me.x), R(me.y));
  if (!W.tiles.has(k)) {
    setTile(me.x, me.y, "3", false);
  }

  debug("Position", me.x, me.y);
});

client.onTile(tile => {
  const { x, y, type } = normalizeTileArgs(tile);
  setTile(x, y, type, false);
});

client.onMap((width, height, tiles) => {
  W.minX = 0;
  W.maxX = width - 1;
  W.minY = 0;
  W.maxY = height - 1;

  const types = [...new Set(tiles.map(t => t.type))];
  console.log("[MAP] Tile types found:", types);

  for (const tile of tiles) {
    const { x, y, type } = normalizeTileArgs(tile);
    setTile(x, y, type, false);
  }

  console.log("[MAP] Tiles loaded:", W.tiles.size);
  console.log(
    "[MAP] Delivery tiles:",
    [...W.tiles.values()].filter(t => t.delivery).length
  );

  console.log(
    "[DBG] Sample delivery tile",
    [...W.tiles.values()].find(t => t.delivery)
  );
});

client.onParcelsSensing(list => {
  W.parcels.clear();

  for (const raw of list) {
    const p = raw?.parcel ?? raw;
    if (!p?.id) continue;

    // Store free parcels and parcels the agent is carrying — skip other agents' carried parcels
    const carriedByMe = p.carriedBy === W.me?.id;
    const isFree = p.carriedBy == null;

    if (isFree || carriedByMe) {
      W.parcels.set(String(p.id), {
        id: p.id,
        x: Number(p.x),
        y: Number(p.y),
        reward: Number(p.reward ?? 0),
        carriedBy: p.carriedBy ?? null
      });
    }
  }
});