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

  activeMission: null,

  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
  lastMove: null,

  mapProfile: null,
  strategy: {
    carryTarget: 3, 
    mapType: "Unknown"
  }

};

export const visitedSpawns = new Map();

export function rememberRecentPos(x, y) {
  const k = `${Math.round(Number(x))},${Math.round(Number(y))}`;
  if (!k) return;

  W.recentPos.push(k);

  if (W.recentPos.length > 8) {
    W.recentPos.shift();
  }
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

  const unvisited = new Set(W.spawnTiles.map(t => `${t.x},${t.y}`));
  W.spawnAreas = [];

  for (const t of W.spawnTiles) {
    const k = `${t.x},${t.y}`;
    if (!unvisited.has(k)) continue;

    const cluster = [];
    const queue = [t];
    unvisited.delete(k);

    while (queue.length > 0) {
      const curr = queue.shift();
      cluster.push(curr);

      // Check all 8 surrounding tiles to see if they are part of this spawn zone
      const dirs = [[0,1], [0,-1], [1,0], [-1,0], [1,1], [1,-1], [-1,1], [-1,-1]];
      for (const [dx, dy] of dirs) {
        const nk = `${curr.x + dx},${curr.y + dy}`;
        if (unvisited.has(nk)) {
          unvisited.delete(nk);
          queue.push({x: curr.x + dx, y: curr.y + dy});
        }
      }
    }
    W.spawnAreas.push(cluster);
  }

  for (const t of W.tiles.values()) {
    if (isSpawnTile(t)) {
      W.spawnTiles.push({ x: t.x, y: t.y });
    }
    if (t.delivery) {
      W.deliveryTiles.push({ x: t.x, y: t.y });
    }
    if (t.base) {
      W.baseTiles.push({ x: t.x, y: t.y });
    }
    if (t.special) {
      W.specialTiles.push({ x: t.x, y: t.y, type: t.type });
    }
    if (t.oneWay) {
      W.oneWayTiles.push({ x: t.x, y: t.y, dir: t.oneWay });
    }
  }

  const now = Date.now();

  for (const [k, until] of W.tempBlocked) {
    if (until <= now) W.tempBlocked.delete(k);
  }

  for (const [k, until] of W.badGoals) {
    if (until <= now) W.badGoals.delete(k);
  }

  seedLocalMap();
}

export let intention = {
  type: null,
  target: null,
  path: null,
  steps: 0
};

export function clearIntention() {
  intention.type = null;
  intention.target = null;
  intention.path = null;
  intention.steps = 0;
}