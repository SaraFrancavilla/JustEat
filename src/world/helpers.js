import { W } from "./state.js";
import { key, targetToken } from "../utils/math.js";
import { inKnownBounds } from "./tiles.js";
import { CFG } from "../config.js";


export function carriedParcels() {
    return W.parcelList.filter(
        p => p.carriedBy === W.me?.id || W.carrying.has(p.id)
    );
}

export function onDeliveryTile() {
    const k = key(W.me.x, W.me.y);
    const tile = W.tiles.get(k);
    return !!tile?.delivery || W.learnedDelivery.has(k);
}

export function parcelsHere() {
    const here = key(W.me.x, W.me.y);
    return W.parcelList.filter(
        p => !p.carriedBy && key(p.x, p.y) === here
    );
}

export function markVisited(x, y) {
    const k = key(x, y);
    W.visitCount.set(k, (W.visitCount.get(k) ?? 0) + 1);
}

export function isWalkable(x, y, goalKey = null) {
    const k = key(x, y);

    if (!inKnownBounds(x, y)) return false;
    if (!W.tiles.has(k)) return false;
    if (k !== goalKey && W.boxPos.has(k)) return false;
    if (k !== goalKey && W.agentPos.has(k)) return false;
    if (W.tempBlocked.has(k)) return false;

    return true;
}

export function canPickupHere() {
    const k = key(W.me.x, W.me.y);
    return (W.noPickupUntil.get(k) ?? 0) <= Date.now();
}

export function blacklistGoal(target, ms = CFG.NO_GOAL_MS) {
    const tok = targetToken(target);
    if (!tok) return;
    W.badGoals.set(tok, Date.now() + ms);
}

export function isGoalBlacklisted(target) {
    const tok = targetToken(target);
    if (!tok) return false;
    return (W.badGoals.get(tok) ?? 0) > Date.now();
}

export function validGoal(target) {
    if (!target) return false;
    if (!Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
    if (!inKnownBounds(target.x, target.y)) return false;

    const k = key(target.x, target.y);
    return W.tiles.has(k);
}
