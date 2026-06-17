import { seedLocalMap } from "./tiles.js";
import { isSpawnTile } from "./helpers.js";

export const W = {
  me: null,
  parcels: new Map(),
  parcelList: [],
  tiles: new Map(),

  spawnTiles: [],
  spawnAreas: [],
  deliveryTiles: [],
  baseTiles: [],
  specialTiles: [],
  oneWayTiles: [],

  agentPos: new Set(),
  boxPos: new Set(),
  carrying: new Set(),
  tempBlocked: new Map(),
  badGoals: new Map(),
  badNeighbors: new Map(),
  recentPos: [],

  mapWidth: null,
  mapHeight: null,

  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
  lastMove: null,

  agents: new Map(),
  agentList: [],

  mapProfile: null,
  strategy: {
    mapType: "Unknown",
    carryTarget: 3,
  },

  gameParams: {
    sensorRadius:     null,
    decayInterval:    null,
    movementDuration: null,
    measured:         false,
  },

  prevActionFinished: true,

  ruleState: {
    stepPause: { stepsSincePause: 0, waitingUntil: 0 },
    avoidPickupUntil: 0,
  },
};

export const visitedSpawns = new Map();

// Initialize measurement states
const _decaySamples  = new Map();
const _decayReadings = [];
const _moveSamples   = [];
let   _lastMoveTime  = null;
let   _lastMovePos   = null;

function _tryFinalize() {
  const g = W.gameParams;
  if (!g.measured && g.sensorRadius !== null && g.decayInterval !== null && g.movementDuration !== null) {
    g.measured = true;
    console.log("[PARAMS] Measured:", JSON.stringify(g));
  }
}

// Measures decay interval from reward changes on the same parcel over time
export function measureDecay(rawList) {
  if (W.gameParams.decayInterval !== null) return;
  const now = Date.now();

  for (const p of rawList) {
    if (!p?.id || p.carriedBy) continue;
    const reward = Number(p.reward ?? 0);
    const id = String(p.id);

    if (!_decaySamples.has(id)) {
      _decaySamples.set(id, { reward, time: now });
      continue;
    }

    const prev = _decaySamples.get(id);
    const dReward = prev.reward - reward;
    const dTime   = now - prev.time;

    if (dReward > 0 && dTime > 50) {
      // rate = reward lost per ms
      _decayReadings.push(dReward / dTime);
      _decaySamples.set(id, { reward, time: now });

      if (_decayReadings.length >= 5) {
        const sorted = [..._decayReadings].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        W.gameParams.decayInterval = Math.round(1 / median);
        _tryFinalize();
      }
    }
  }
}

// Measures sensor radius

export function measureSensorRadius(visiblePositions) {
  if (W.gameParams.sensorRadius !== null) return;
  if (!W.me || W.mapWidth === null || W.mapHeight === null) return;

  const mx = Math.round(W.me.x);
  const my = Math.round(W.me.y);

  // Max visible distance in each cardinal direction
  let maxUp = 0, maxDown = 0, maxLeft = 0, maxRight = 0;

  for (const pos of visiblePositions) {
    const px = Math.round(pos.x);
    const py = Math.round(pos.y);
    const dx = px - mx;
    const dy = py - my;

    if (dx === 0 && dy < 0) maxUp    = Math.max(maxUp,    -dy);
    if (dx === 0 && dy > 0) maxDown  = Math.max(maxDown,   dy);
    if (dy === 0 && dx < 0) maxLeft  = Math.max(maxLeft,  -dx);
    if (dy === 0 && dx > 0) maxRight = Math.max(maxRight,  dx);
  }

  // How far the map extends in each direction from agent position
  const roomUp    = my;                    // tiles above (y=0 is top)
  const roomDown  = W.mapHeight - 1 - my;
  const roomLeft  = mx;
  const roomRight = W.mapWidth  - 1 - mx;

  // A direction is "map-bounded" if we see as far as the map goes
  // (within 1 tile tolerance for walkability gaps)
  const bounded = (seen, room) => seen === 0 || seen >= room - 1;

  const allBounded =
    bounded(maxUp, roomUp) &&
    bounded(maxDown, roomDown) &&
    bounded(maxLeft, roomLeft) &&
    bounded(maxRight, roomRight);

  if (allBounded) {
    W.gameParams.sensorRadius = -1;
  } else {
    // Real limited sensor: take the max observed distance
    const maxDist = Math.max(maxUp, maxDown, maxLeft, maxRight);
    if (maxDist > 0) W.gameParams.sensorRadius = maxDist;
    else return; // not enough data yet
  }

  _tryFinalize();
}

// Measures the real movement duration as median of observed deltas

export function measureMovementDuration(x, y) {
  if (W.gameParams.movementDuration !== null) return;
  const now = Date.now();

  const moved = !_lastMovePos || _lastMovePos.x !== x || _lastMovePos.y !== y;
  _lastMovePos = { x, y };
  if (!moved) return;

  if (_lastMoveTime !== null) {
    const delta = now - _lastMoveTime;
    if (delta > 20 && delta < 2000) {
      _moveSamples.push(delta);
      if (_moveSamples.length >= 6) {
        const sorted = [..._moveSamples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        W.gameParams.movementDuration = Math.round(median);
        _tryFinalize();
      }
    }
  }

  _lastMoveTime = now;
}


export function rememberRecentPos(x, y) {
  const k = `${Math.round(Number(x))},${Math.round(Number(y))}`;
  if (!k) return;
  W.recentPos.push(k);
  if (W.recentPos.length > 8) W.recentPos.shift();
}

export let deliveryDirty = false;
export function setDeliveryDirty(v) { deliveryDirty = v; }

export function syncCaches() {
  W.parcelList = [...W.parcels.values()];

  W.spawnTiles = [];
  W.deliveryTiles = [];
  W.baseTiles = [];
  W.specialTiles = [];
  W.oneWayTiles = [];
  W.spawnAreas = [];

  for (const t of W.tiles.values()) {
    if (isSpawnTile(t))  W.spawnTiles.push({ x: t.x, y: t.y });
    if (t.delivery)      W.deliveryTiles.push({ x: t.x, y: t.y });
    if (t.base)          W.baseTiles.push({ x: t.x, y: t.y });
    if (t.special)       W.specialTiles.push({ x: t.x, y: t.y, type: t.type });
    if (t.oneWay)        W.oneWayTiles.push({ x: t.x, y: t.y, dir: t.oneWay });
  }

  const unvisited = new Set(W.spawnTiles.map(t => `${t.x},${t.y}`));
  for (const t of W.spawnTiles) {
    const k = `${t.x},${t.y}`;
    if (!unvisited.has(k)) continue;

    const cluster = [];
    const queue = [t];
    unvisited.delete(k);

    while (queue.length > 0) {
      const curr = queue.shift();
      cluster.push(curr);
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nk = `${curr.x + dx},${curr.y + dy}`;
        if (unvisited.has(nk)) {
          unvisited.delete(nk);
          queue.push({ x: curr.x + dx, y: curr.y + dy });
        }
      }
    }

    W.spawnAreas.push(cluster);
  }

  const now = Date.now();
  for (const [k, until] of W.tempBlocked) if (until <= now) W.tempBlocked.delete(k);
  for (const [k, until] of W.badGoals)    if (until <= now) W.badGoals.delete(k);

  seedLocalMap();
}

export let intention = {
  type: null, target: null, path: null, steps: 0
};

export function updateVisibleAgents(rawAgents = []) {
  W.agents.clear();
  W.agentList = [];

  for (const a of rawAgents ?? []) {
    if (!a?.id) continue;

    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const agent = {
      id: a.id,
      name: a.name ?? null,
      teamName: a.teamName ?? a.team ?? a.group ?? null,
      x,
      y,
      score: Number(a.score ?? 0),
    };

    W.agents.set(agent.id, agent);
    W.agentList.push(agent);
  }
}

export function clearIntention() {
  intention.type = null;
  intention.target = null;
  intention.path = null;
  intention.steps = 0;
}


let _mapDebugInterval = null;

export function startMapDebug(intervalMs = 10000) {
  if (_mapDebugInterval) return;

  _mapDebugInterval = setInterval(() => {
    const totalTiles   = W.tiles.size;
    const walkable     = [...W.tiles.values()].filter(t => t.walkable !== false).length;
    const delivery     = W.deliveryTiles.length;
    const spawn        = W.spawnTiles.length;
    const mapArea      = W.mapWidth * W.mapHeight;
    const coverage     = mapArea > 0 ? ((totalTiles / mapArea) * 100).toFixed(1) : "?";

    console.log(
      `[MAP DEBUG] Known: ${totalTiles}/${mapArea} tiles (${coverage}%) | ` +
      `walkable: ${walkable} | delivery: ${delivery} | spawn: ${spawn}`
    );

    if (delivery > 0) {
      const dStr = W.deliveryTiles.map(t => `(${t.x},${t.y})`).join(" ");
      console.log(`[MAP DEBUG] Delivery tiles: ${dStr}`);
    } else {
      console.log(`[MAP DEBUG] ⚠️  NO DELIVERY TILES KNOWN`);
    }

    _printAsciiMap();

  }, intervalMs);
}

function _printAsciiMap() {
  if (!W.mapWidth || !W.mapHeight) return;

  const W_ = Math.min(W.mapWidth,  60);
  const H_ = Math.min(W.mapHeight, 60);

  const lines = [];
  for (let y = 0; y < H_; y++) {
    let row = "";
    for (let x = 0; x < W_; x++) {
      const k = `${x},${y}`;
      const t = W.tiles.get(k);
      const isMe = W.me && Math.round(W.me.x) === x && Math.round(W.me.y) === y;

      if      (isMe)           row += "A";
      else if (!t)             row += "?";   // unknown
      else if (!t.walkable)    row += "█";   // wall
      else if (t.delivery)     row += "D";   // delivery
      else if (isSpawnTile(t)) row += "S";   // spawn
      else if (t.hasCrate)     row += "C";  // yellow tile with crate on it
      else if (t.crateTrack)   row += "Y";   // yellow tile crate can be pushed onto
      else                     row += "·";   // walkable
    }
    lines.push(row);
  }

  console.log("[ASCII MAP]\n" + lines.join("\n"));
}
