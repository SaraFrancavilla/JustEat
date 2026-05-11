export const HOST = "https://deliveroojs.onrender.com/";  //"https://deliveroojs.bears.disi.unitn.it/"
export const TOKEN = process.env.DELIVEROO_TOKEN?.trim();
 
export const LOG_LEVEL = 2; // 0 = no logs, 1 = info, 2 = debug
    
//added parameters for pddl
export const CFG = {
    TICK_RATE_MS: 100,
    REPLAN_STEPS: 10,
    ASTAR_MAX_EXPANSIONS: 4000,
    DELIVER_REWARD_THRESHOLD: 8,
    DELIVER_DIST_THRESHOLD: 4,
    DECAY_WEIGHT: 1.5,
    TEMP_BLOCK_MS: 1200,
    NO_GOAL_MS: 2500,
    NO_PICKUP_AFTER_DELIVERY_MS: 1000,
    PDDL_BOX_RADIUS: 6,
    PDDL_BOX_THRESHOLD: 3,
    PDDL_TOTAL_THRESHOLD: 6
};


export function syncCaches() {
    if (parcelsDirty) {
        W.parcelList = [...W.parcels.values()];
        parcelsDirty = false;
    }

    if (deliveryDirty) {
        W.deliveryTiles = [];
        for (const t of W.tiles.values()) {
            if (t.delivery) W.deliveryTiles.push({ x: t.x, y: t.y });
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