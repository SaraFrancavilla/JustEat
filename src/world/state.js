import { seedLocalMap } from "./tiles.js";
import { key } from "../utils/math.js";

export const W = {
    me: null,
    tiles: new Map(),
    parcels: new Map(),
    parcelList: [],
    deliveryZones: [],
    agentPos: new Set(),
    boxPos: new Set(),
    carrying: new Set(),
    tempBlocked: new Map(),
    visitCount: new Map(),
    noPickupUntil: new Map(),
    learnedDelivery: new Set(),
    badGoals: new Map(),
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    lastMove: null
};

export let parcelsDirty = false;
export let deliveryDirty = false;

export function setParcelsDirty(v) { parcelsDirty = v; }
export function setDeliveryDirty(v) { deliveryDirty = v; }

/**
 * Updates caches of parcels and delivery zones, and cleans up expired temporary blocks and bad goals.
 * 
 * The `parcelsDirty` and `deliveryDirty` flags indicate whether the parcel list and delivery zone 
 * list need to be updated based on changes to the underlying parcels and tiles data. 
 * This allows us to avoid unnecessary updates and only refresh these lists when there have been changes that affect them.
 * 
 * Also removes expired entries from `tempBlocked`, `badGoals`, and `noPickupUntil` maps based on the current timestamp,
 * and seeds the local map.
 */
export function syncCaches() {
    if (parcelsDirty) {
        W.parcelList = [...W.parcels.values()];
        parcelsDirty = false;
    }

    if (deliveryDirty) {
        W.deliveryZones = [];
        for (const t of W.tiles.values()) {
            if (t.delivery) W.deliveryZones.push({ x: t.x, y: t.y });
        }
        deliveryDirty = false;
    }

    const now = Date.now();

    for (const [k, until] of W.tempBlocked) {
        if (until <= now) W.tempBlocked.delete(k);
    }

    for (const [k, until] of W.badGoals) {
        if (until <= now) W.badGoals.delete(k);
    }

    for (const [k, until] of W.noPickupUntil) {
        if (until <= now) W.noPickupUntil.delete(k);
    }

    seedLocalMap();
}

/**
* Marks the tile at (x, y) as visited by incrementing its visit count in the `visitCount` map.
*/
export function markVisited(x, y) {
    const k = key(x, y);
    W.visitCount.set(k, (W.visitCount.get(k) ?? 0) + 1);
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

