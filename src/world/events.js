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
  W.boxPos.clear();

  const types = [...new Set(tiles.map(t => t.type))];

//console.log("[MAP] onMap called: width=", width, "height=", height, "tiles type=", Array.isArray(tiles) ? "array" : typeof tiles);
  
  // Handle 2D array (row, col) format
  if (Array.isArray(tiles) && tiles.length > 0 && Array.isArray(tiles[0])) {
    //console.log("[MAP] Detected 2D array format");
    for (let y = 0; y < tiles.length; y++) {
      const row = tiles[y];
      for (let x = 0; x < row.length; x++) {
        const type = String(row[x]).trim();
        setTile(x, y, type, false);
      }
    }
  } else {
    // Handle flat array of tile objects
    //console.log("[MAP] Detected flat array format");
    const types = [...new Set(tiles.map(t => t.type))];
    //console.log("[MAP] Tile types found:", types);


  //console.log("[MAP] Tile types found:", types);

  for (const tile of tiles) {
    const { x, y, type } = normalizeTileArgs(tile);
    setTile(x, y, type, false);
  }
}

  // console.log("[MAP] Tiles loaded:", W.tiles.size);
  // console.log(
  //   "[MAP] Delivery tiles:",
  //   [...W.tiles.values()].filter(t => t.delivery).length
  // );

  // console.log(
  //   "[DBG] Sample delivery tile",
  //   [...W.tiles.values()].find(t => t.delivery)
  // );
});

client.onParcelsSensing(list => {
  //console.log('[DBG EVENTS] onParcelsSensing called with', list?.length || 0, 'items');
  
  W.parcels.clear();

  for (const raw of list) {
    const p = raw?.parcel ?? raw;
    if (!p?.id) {
      //console.log('[DBG EVENTS] Skipping invalid parcel:', raw);
      continue;
    }

    // Store free parcels and parcels the agent is carrying — skip other agents' carried parcels
    const carriedByMe = p.carriedBy === W.me?.id;
    const isFree = p.carriedBy == null;

    //console.log('[DBG EVENTS] Parcel', p.id, ':', {
    //  x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy, 
    //  isFree, carriedByMe, willStore: isFree || carriedByMe
    //});

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
  
  //console.log('[DBG EVENTS] After parsing: W.parcels.size =', W.parcels.size);
});

client.onAgentsSensing(list => {
  //console.log('[DBG EVENTS] onAgentsSensing called with', list?.length || 0, 'agents');
  
  W.agentPos.clear();

  for (const agent of list) {
    if (!agent?.id || !Number.isFinite(agent.x) || !Number.isFinite(agent.y)) {
      //console.log('[DBG EVENTS] Skipping invalid agent:', agent);
      continue;
    }

    // Skip self
    if (agent.id === W.me?.id) {
      continue;
    }

    const k = key(R(agent.x), R(agent.y));
    W.agentPos.add(k);
    //console.log('[DBG EVENTS] Agent', agent.id, 'at', agent.x, agent.y, '(key=' + k + ')');
  }
  
  //console.log('[DBG EVENTS] After parsing agents: W.agentPos.size =', W.agentPos.size);
});