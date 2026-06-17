import client from "../client.js";
import { W, syncCaches, measureDecay, measureSensorRadius, measureMovementDuration } from "./state.js";
import { setTile, normalizeTileArgs } from "./tiles.js";
import { key, R } from "../utils/math.js";
import { debug } from "../config.js";
import { rebuildBoxPositionsFromTiles } from "./helpers.js";

function syncSingleTileCrateState(x, y) {
  const k = key(R(x), R(y));
  const tile = W.tiles.get(k);
  if (!tile) return;

  if (tile.hasCrate) W.boxPos.add(k);
  else W.boxPos.delete(k);
}

function markServerAck(reason) {
  if (W.prevActionFinished === false) {
    W.prevActionFinished = true;
    debug("[ACK] prevActionFinished <- true via", reason);
  }
}

client.onYou((me) => {
  const prevMe = W.me ? { ...W.me } : null;
  measureMovementDuration(me.x, me.y);
  W.me = { ...me };

  const k = key(R(me.x), R(me.y));
  if (!W.tiles.has(k)) {
    setTile(me.x, me.y, "3", false);
  }

  markServerAck("onYou");
  debug("Position", me.x, me.y, "prev", prevMe?.x, prevMe?.y);
});

client.onTile((tile) => {
  const { x, y, type } = normalizeTileArgs(tile);
  setTile(x, y, type, false);
  syncSingleTileCrateState(x, y);

  if (W.boxPos?.size > 0) {
    markServerAck("onTile");
  }
});

client.onMap((width, height, tiles) => {
  W.mapWidth = width + 1;
  W.mapHeight = height + 1;
  W.minX = 0;
  W.maxX = width; // last valid index (0-based)
  W.minY = 0;
  W.maxY = height; // last valid index (0-based)

  if (Array.isArray(tiles) && tiles.length > 0 && Array.isArray(tiles[0])) {
    for (let y = 0; y < tiles.length; y++) {
      const row = tiles[y];
      for (let x = 0; x < row.length; x++) {
        const type = String(row[x]).trim();
        setTile(x, y, type, false);
      }
    }
  } else {
    for (const tile of tiles) {
      const { x, y, type } = normalizeTileArgs(tile);
      setTile(x, y, type, false);
    }
  }

  rebuildBoxPositionsFromTiles();
  syncCaches();
});

client.onParcelsSensing((list) => {
  W.parcels.clear();
  measureDecay(list);
  measureSensorRadius(list.map(p => ({ x: Number(p.x), y: Number(p.y) })));

  for (const raw of list) {
    const p = raw?.parcel ?? raw;

    if (!p?.id || String(p.id) === "undefined") {
      continue;
    }

    const carriedByMe = p.carriedBy === W.me?.id;
    const isFree = p.carriedBy == null;

    if (isFree || carriedByMe) {
      W.parcels.set(String(p.id), {
        id: p.id,
        x: Number(p.x),
        y: Number(p.y),
        reward: Number(p.reward ?? 0),
        carriedBy: p.carriedBy ?? null,
      });
    }
  }
});

client.onAgentsSensing((list) => {
  W.agentPos.clear();
  measureSensorRadius(list.map(a => ({ x: Number(a.x), y: Number(a.y) })));

  for (const agent of list) {
    if (!agent?.id || !Number.isFinite(agent.x) || !Number.isFinite(agent.y)) {
      continue;
    }

    if (agent.id === W.me?.id) continue;

    const k = key(R(agent.x), R(agent.y));
    W.agentPos.add(k);
  }
});