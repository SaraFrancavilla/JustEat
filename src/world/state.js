import { seedLocalMap } from "./tiles.js";
import { isSpawnTile } from "./helpers.js";

export const W = {
  me: null,
  parcels: new Map(),
  parcelList: [],
  tiles: new Map(),

  spawnTiles: [],
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

  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
  lastMove: null
};

export let deliveryDirty = false;
export function setDeliveryDirty(v) { deliveryDirty = v; }

export function syncCaches() {
  // Always rebuild — events.js writes W.parcels directly
  W.parcelList = [...W.parcels.values()];

  W.spawnTiles = [];
  W.deliveryTiles = [];
  W.baseTiles = [];
  W.specialTiles = [];
  W.oneWayTiles = [];

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