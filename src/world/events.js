import client from "../client.js";
import { W, syncCaches } from "./state.js";
import { setTile, normalizeTileArgs } from "./tiles.js";
import { key, R } from "../utils/math.js";
import { debug } from "../config.js";
import { LLMCoordinationAgent } from "../llm/agent.mjs";
import { analyzeMapStrategyWithLLM } from "./mapAnalysis.js";
import { rebuildBoxPositionsFromTiles } from "./helpers.js";

function syncSingleTileCrateState(x, y) {
  const k = key(R(x), R(y));
  const tile = W.tiles.get(k);
  if (!tile) return;

  if (tile.hasCrate) W.boxPos.add(k);
  else W.boxPos.delete(k);
}

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
  syncSingleTileCrateState(x, y);
});

client.onMap((width, height, tiles) => {
  W.mapWidth = width;
  W.mapHeight = height;
  W.minX = 0;
  W.maxX = width - 1;
  W.minY = 0;
  W.maxY = height - 1;

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

  analyzeMapStrategyWithLLM(LLMCoordinationAgent).catch(console.error);
});

client.onParcelsSensing(list => {
  W.parcels.clear();

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
        carriedBy: p.carriedBy ?? null
      });
    }
  }
});

client.onAgentsSensing(list => {
  W.agentPos.clear();

  for (const agent of list) {
    if (!agent?.id || !Number.isFinite(agent.x) || !Number.isFinite(agent.y)) {
      continue;
    }

    if (agent.id === W.me?.id) continue;

    const k = key(R(agent.x), R(agent.y));
    W.agentPos.add(k);
  }
});