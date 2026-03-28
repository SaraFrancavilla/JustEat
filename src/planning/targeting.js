import { W } from "../world/state.js";
import { manhattan, key } from "../utils/math.js";
import{DIRS} from "../utils/directions.js";
import {aStar} from "../planning/astar.js";
import { carriedParcels, isGoalBlacklisted, validGoal} from "../world/helpers.js";
import {inKnownBounds} from "../world/tiles.js";
import {CFG} from "../config.js";

export function nearestDeliveryFrom(x, y) {
    let best = null;
    let d = Infinity;

    for (const z of W.deliveryZones) {
        const dist = manhattan(x, y, z.x, z.y);
        if (dist < d) {
            d = dist;
            best = z;
        }
    }

    return best;
}

export function nearestDelivery() {
    return nearestDeliveryFrom(W.me.x, W.me.y);
}

export function utility(p) {
    const distToParcel = manhattan(W.me.x, W.me.y, p.x, p.y);
    const dz = nearestDeliveryFrom(p.x, p.y);
    const distToDelivery = dz ? manhattan(p.x, p.y, dz.x, dz.y) : 0;

    return Math.pow(p.reward, CFG.DECAY_WEIGHT) /
        (1 + distToParcel + 0.35 * distToDelivery);
}

export function bestParcel() {
    let best = null;
    let bestU = -Infinity;

    for (const p of W.parcelList) {
        if (p.carriedBy) continue;
        if (isGoalBlacklisted(p)) continue;

        const pk = key(p.x, p.y);
        const cooldown = W.noPickupUntil.get(pk) ?? 0;
        if (cooldown > Date.now() && samePos(p, W.me)) continue;

        const u = utility(p);
        if (u > bestU) {
            bestU = u;
            best = p;
        }
    }

    return best;
}

export function bestKnownApproachTile(tx, ty) {
    let best = null;
    let bestScore = Infinity;

    for (const t of W.tiles.values()) {
        const path = aStar(W.me.x, W.me.y, t.x, t.y);
        if (path === null) continue;

        const guessedPenalty = t.guessed ? 0.2 : 0;
        const score =
            path.length +
            2 * manhattan(t.x, t.y, tx, ty) +
            guessedPenalty +
            (W.visitCount.get(key(t.x, t.y)) ?? 0);

        if (score < bestScore) {
            bestScore = score;
            best = { x: t.x, y: t.y, path };
        }
    }

    return best;
}

export function frontierTiles() {
    const arr = [];

    for (const t of W.tiles.values()) {
        let frontier = false;

        for (const d of DIRS) {
            const nx = t.x + d.dx;
            const ny = t.y + d.dy;
            const nk = key(nx, ny);

            if (!inKnownBounds(nx, ny)) continue;
            if (!W.tiles.has(nk) && !W.tempBlocked.has(nk)) {
                frontier = true;
                break;
            }
        }

        if (frontier) arr.push({ x: t.x, y: t.y });
    }

    return arr;
}

export function bestFrontierTarget() {
    let best = null;
    let bestScore = Infinity;

    for (const t of frontierTiles()) {
        if (isGoalBlacklisted(t)) continue;

        const path = aStar(W.me.x, W.me.y, t.x, t.y);
        if (path === null) continue;

        const score = path.length + 2 * (W.visitCount.get(key(t.x, t.y)) ?? 0);
        if (score < bestScore) {
            bestScore = score;
            best = { x: t.x, y: t.y, path };
        }
    }

    return best;
}

export function planPathToTarget(target) {
    if (!target) return [];
    if (isGoalBlacklisted(target)) return null;
    if (!validGoal(target)) return null;

    const direct = aStar(W.me.x, W.me.y, target.x, target.y);
    if (direct !== null) return direct;

    const approach = bestKnownApproachTile(target.x, target.y);
    if (approach && Array.isArray(approach.path) && approach.path.length > 0) {
        return approach.path;
    }

    return null;
}

/**
 * Checks the current situation for reactive actions like picking up or 
 * dropping off parcels based on the total reward of carried parcels and distance to delivery zones, 
 * or the presence of parcels to pick up on the current tile.
 */
export function deliberate() {
    const carried = carriedParcels();
    const total = carried.reduce((s, p) => s + p.reward, 0);
    const dz = nearestDelivery();

    if (carried.length && dz && !isGoalBlacklisted(dz)) {
        const d = manhattan(W.me.x, W.me.y, dz.x, dz.y);
        if (total >= CFG.DELIVER_REWARD_THRESHOLD || d <= CFG.DELIVER_DIST_THRESHOLD) {
            return { type: "DELIVER", target: dz };
        }
    }

    const p = bestParcel();
    if (p) return { type: "PICKUP", target: p };

    const frontier = bestFrontierTarget();
    if (frontier) return { type: "EXPLORE", target: { x: frontier.x, y: frontier.y } };

    return { type: "EXPLORE", target: null };
}