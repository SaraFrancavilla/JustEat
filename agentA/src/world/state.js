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

  mapProfile: null,
  strategy: {
    mapType: "Unknown",
    carryTarget: 3,
  },

  gameParams: {
    decayInterval:    null,
    movementDuration: null,
    measured:         false,
  },

  prevActionFinished: true,

  // authoritative roster from the server's 'controller' event - id/name/
  // teamId/teamName for every connected agent, independent of vision range
  knownAgents: new Map(),
};

export const visitedSpawns = new Map();

// ── Empirical measurement state ───────────────────────────
const _decaySamples  = new Map();
const _decayReadings = [];
const _moveSamples   = [];
let   _lastMoveTime  = null;
let   _lastMovePos   = null;

function _tryFinalize() {
  const g = W.gameParams;
  if (!g.measured && g.decayInterval !== null && g.movementDuration !== null) {
    g.measured = true;
    console.log("[PARAMS] Measured:", JSON.stringify(g));
  }
}

/**
 * Measures decay interval from reward changes on the same parcel over time
 */
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

/**
 * Measures the real movement duration as median of observed deltas
 */
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

// keeps W.knownAgents in sync with the server's 'controller' roster events -
// authoritative and vision-independent
export function updateKnownAgent(status, agent) {
  if (!agent?.id) return;
  if (status === "disconnected") {
    W.knownAgents.delete(agent.id);
    return;
  }
  W.knownAgents.set(agent.id, {
    id: agent.id,
    name: agent.name ?? null,
    teamId: agent.teamId ?? null,
    teamName: agent.teamName ?? null,
  });
}

function normTeamField(v) {
  return String(v ?? "").trim().toLowerCase();
}

// true only for an agent confirmed (via the roster) to share our team.
// matches on teamName primarily, not teamId - on this server teamId is
// apparently per-token/session rather than a stable per-team value (two
// agents authenticated under the same team name were observed with two
// different teamIds), so matching on it exclusively made every teammate
// look like a stranger. teamId is kept as a secondary, in case a
// differently-configured server does keep it consistent. an unset team on
// either side never matches, so a soloing agent (e.g. a trusted
// mission-sender with no team) is correctly never a "teammate"
export function isTeammate(id) {
  if (!id || id === W.me?.id) return false;
  const known = W.knownAgents.get(id);
  if (!known) return false;

  const myTeamName = normTeamField(W.me?.teamName);
  const theirTeamName = normTeamField(known.teamName);
  if (myTeamName && theirTeamName && myTeamName === theirTeamName) return true;

  const myTeamId = normTeamField(W.me?.teamId);
  const theirTeamId = normTeamField(known.teamId);
  return !!myTeamId && !!theirTeamId && myTeamId === theirTeamId;
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