import { W} from "./state.js";
import { R, key } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";


function hasKnownBounds() {
    return Number.isFinite(W.minX) &&
           Number.isFinite(W.maxX) &&
           Number.isFinite(W.minY) &&
           Number.isFinite(W.maxY);
}

export function inKnownBounds(x, y) {
    if (!hasKnownBounds()) return true;
    const rx = R(x);
    const ry = R(y);
    return rx >= W.minX && rx <= W.maxX && ry >= W.minY && ry <= W.maxY;
}

function updateBounds(x, y) {
    const rx = R(x);
    const ry = R(y);
    W.minX = Math.min(W.minX, rx);
    W.maxX = Math.max(W.maxX, rx);
    W.minY = Math.min(W.minY, ry);
    W.maxY = Math.max(W.maxY, ry);
}

export function makeTile(x, y, delivery = false, guessed = false) {
    return {
        x: R(x),
        y: R(y),
        delivery: !!delivery,
        guessed: !!guessed
    };
}

/**
 * Sets the tile at (x, y) with the given properties. 
 * If `delivery` is true, marks it as a delivery tile.
 * If `guessed` is true and the tile was not previously known, marks it as a guessed tile.
 * Also updates the known bounds of the map based on the tile's coordinates.
 * If the tile is marked as a delivery tile, sets the deliveryDirty flag to true 
 * to trigger cache updates.
 */
export function setTile(x, y, delivery = false, guessed = false) {
    const rx = R(x);
    const ry = R(y);
    const k = key(rx, ry); // Use rounded coordinates as the key to ensure consistency in tile representation
    const prev = W.tiles.get(k);

    const isDelivery = !!delivery || !!prev?.delivery || W.learnedDelivery.has(k);
    W.tiles.set(k, {
        x: rx,
        y: ry,
        delivery: isDelivery,
        guessed: !!guessed && !prev
    });

    updateBounds(rx, ry);

    if (isDelivery) deliveryDirty = true;
}

export function normalizeTileArgs(...args) {
    const first = args[0];

    if (
        first &&
        typeof first === "object" &&
        Number.isFinite(Number(first.x)) &&
        Number.isFinite(Number(first.y))
    ) {
        const raw =
            first.delivery ??
            first.isDelivery ??
            first.type ??
            first.kind ??
            first.color ??
            first.tileType;

        const rawStr = String(raw ?? "").trim().toLowerCase();

        const delivery =
            raw === true ||
            raw === 1 ||
            rawStr === "true" ||
            rawStr === "delivery" ||
            rawStr === "red" ||
            rawStr === "2";

        return {
            x: Number(first.x),
            y: Number(first.y),
            delivery,
            rawType: rawStr
        };
    }

    const [x, y, raw] = args;
    const rawStr = String(raw ?? "").trim().toLowerCase();

    const delivery =
        raw === true ||
        raw === 1 ||
        rawStr === "true" ||
        rawStr === "delivery" ||
        rawStr === "red" ||
        rawStr === "2";

    return {
        x: Number(x),
        y: Number(y),
        delivery,
        rawType: rawStr
    };
}

/**
 * Updates local map information around the agent's current position.
 * If the agent's current tile is not known, it is added to the map. 
 * Then, for each adjacent tile, if it is not already known and not temporarily blocked, 
 * it is added as a guessed tile. This helps the agent build a local map of its surroundings 
 * and can inform future pathfinding and decision-making.
 */
export function seedLocalMap() {
    if (!W.me) return;

    const x = R(W.me.x);
    const y = R(W.me.y);

    setTile(x, y, false, false);

    for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        const nk = key(nx, ny);

        if (!inKnownBounds(nx, ny)) continue;
        // If we don't have information about this tile and it's not temporarily blocked, 
        // we can mark it as a guessed tile.
        if (!W.tiles.has(nk) && !W.tempBlocked.has(nk)) {
            W.tiles.set(nk, makeTile(nx, ny, false, true));
        }
    }
}