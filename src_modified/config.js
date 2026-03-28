export const HOST = "https://deliveroojs.onrender.com/";
export const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImY3Y2NhZCIsIm5hbWUiOiJhbm9ueW1vdXMiLCJyb2xlIjoidXNlciIsImlhdCI6MTc3NDY5OTEzMX0.ZZm4Lx3TWhLoygvvQ8ygFmZOxK-l-jhDmWieHjDHUgA";

export const LOG_LEVEL = 2;

export const CFG = {
    TICK_RATE_MS: 100,
    REPLAN_STEPS: 4,
    ASTAR_MAX_EXPANSIONS: 4000,
    DELIVER_REWARD_THRESHOLD: 8,
    DELIVER_DIST_THRESHOLD: 4,
    DECAY_WEIGHT: 1.5,
    TEMP_BLOCK_MS: 1200,
    NO_GOAL_MS: 2500,
    NO_PICKUP_AFTER_DELIVERY_MS: 1000
};


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


export const debug = (...a) => LOG_LEVEL >= 2 && console.log("[DBG]", ...a);
export const info  = (...a) => LOG_LEVEL >= 1 && console.log("[INF]", ...a);
export const warn  = (...a) => console.warn("[WRN]", ...a);