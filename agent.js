/**
 * ================================================================
 * Deliveroo Agent - BDI Architecture
 * ================================================================
 */

import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

/* ============================================================
CONFIG
============================================================ */

const HOST = "https://deliveroojs.onrender.com/";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImI3NTlmYSIsIm5hbWUiOiJhbm9ueW1vdXMiLCJyb2xlIjoidXNlciIsImlhdCI6MTc3NDI3MzQ4N30.-NTMZ2MzUF9W9CcsKdah5pvqTCB23NZ9lAN0ortyvRc";
const LOG_LEVEL = 2;

const CFG = {
    TICK_RATE_MS: 100,
    REPLAN_STEPS: 4,
    ASTAR_MAX_EXPANSIONS: 4000,
    DELIVER_REWARD_THRESHOLD: 8,
    DELIVER_DIST_THRESHOLD: 4,
    DECAY_WEIGHT: 1.5,
    TEMP_BLOCK_MS: 1200,
    AGENT_BLOCK_MS: 600,
    NO_GOAL_MS: 2500,
    NO_PICKUP_AFTER_DELIVERY_MS: 1000
};

/* ============================================================
LOGGING
============================================================ */

const debug = (...a) => LOG_LEVEL >= 2 && console.log("[DBG]", ...a);
const info  = (...a) => LOG_LEVEL >= 1 && console.log("[INF]", ...a);
const warn  = (...a) => console.warn("[WRN]", ...a);

/* ============================================================
CLIENT
============================================================ */

const client = new DeliverooApi(HOST, TOKEN);

const api = {
    move: d => client.move ? client.move(d) : client.emitMove(d),
    pickup: () => client.pickup ? client.pickup() : client.emitPickup(),
    putdown: ids => client.putdown ? client.putdown(ids) : client.emitPutdown(ids)
};

/* ============================================================
UTILITIES
============================================================ */

const R = v => Math.round(v);
const key = (x, y) => `${R(x)},${R(y)}`;

const manhattan = (ax, ay, bx, by) =>
    Math.abs(R(ax) - R(bx)) + Math.abs(R(ay) - R(by));

const DIRS = [
    { dx: 0, dy: 1, dir: "up" },
    { dx: 0, dy: -1, dir: "down" },
    { dx: 1, dy: 0, dir: "right" },
    { dx: -1, dy: 0, dir: "left" }
];

const DELTA = {
    up: [0, 1],
    down: [0, -1],
    right: [1, 0],
    left: [-1, 0]
};

function samePos(a, b) {
    return !!a && !!b && R(a.x) === R(b.x) && R(a.y) === R(b.y);
}

function sameTarget(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.id && b.id) return String(a.id) === String(b.id);
    return samePos(a, b);
}

function inverseDir(dir) {
    if (dir === "up") return "down";
    if (dir === "down") return "up";
    if (dir === "left") return "right";
    if (dir === "right") return "left";
    return null;
}

function targetToken(t) {
    if (!t) return null;
    if (t.id) return `id:${String(t.id)}`;
    if (Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y))) {
        return `xy:${key(t.x, t.y)}`;
    }
    return null;
}

/* ============================================================
WORLD STATE
============================================================ */

const W = {
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

let parcelsDirty = false;
let deliveryDirty = false;

let intention = {
    type: null,
    target: null,
    path: null,
    steps: 0
};

/* ============================================================
TILES
============================================================ */

function hasKnownBounds() {
    return Number.isFinite(W.minX) &&
           Number.isFinite(W.maxX) &&
           Number.isFinite(W.minY) &&
           Number.isFinite(W.maxY);
}

function inKnownBounds(x, y) {
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

function makeTile(x, y, delivery = false, guessed = false) {
    return {
        x: R(x),
        y: R(y),
        delivery: !!delivery,
        guessed: !!guessed
    };
}

function setTile(x, y, delivery = false, guessed = false) {
    const rx = R(x);
    const ry = R(y);
    const k = key(rx, ry);
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

function normalizeTileArgs(...args) {
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

function seedLocalMap() {
    if (!W.me) return;

    const x = R(W.me.x);
    const y = R(W.me.y);

    setTile(x, y, false, false);

    for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        const nk = key(nx, ny);

        if (!inKnownBounds(nx, ny)) continue;
        if (!W.tiles.has(nk) && !W.tempBlocked.has(nk)) {
            W.tiles.set(nk, makeTile(nx, ny, false, true));
        }
    }
}

/* ============================================================
EVENTS
============================================================ */

client.onYou(me => {
    W.me = { ...me };
    setTile(me.x, me.y, false, false);
    seedLocalMap();
    debug("Position", R(me.x), R(me.y));
});

client.onTile((...args) => {
    const t = normalizeTileArgs(...args);
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return;

    setTile(t.x, t.y, t.delivery, false);

    if (t.delivery) {
        W.learnedDelivery.add(key(t.x, t.y));
        debug("DELIVERY TILE LEARNED", key(t.x, t.y), "type", t.rawType);
    }
});

client.onParcelsSensing(list => {
    const seen = new Set();

    for (const raw of list) {
        const p = raw?.parcel ?? raw;
        if (!p?.id) continue;

        const id = String(p.id);
        const prev = W.parcels.get(id);

        const parcel = {
            id,
            x: Number(p.x),
            y: Number(p.y),
            reward: Number(p.reward ?? 0),
            carriedBy: p.carriedBy ?? prev?.carriedBy ?? null
        };

        W.parcels.set(id, parcel);

        if (parcel.carriedBy === W.me?.id) W.carrying.add(id);
        else W.carrying.delete(id);

        seen.add(id);
        setTile(parcel.x, parcel.y, false, true);
    }

    for (const [id, p] of W.parcels) {
        const mine = p.carriedBy === W.me?.id || W.carrying.has(id);
        if (!seen.has(id) && !mine) {
            W.parcels.delete(id);
        }
    }

    parcelsDirty = true;
});

client.onAgentsSensing(agents => {
    W.agentPos.clear();
    W.boxPos.clear();

    for (const a of agents) {
        if (a.id === W.me?.id) continue;

        const pos = key(a.x, a.y);

        const isBox =
            a.box ||
            a.type === "box" ||
            a.type === "crate" ||
            /^[Cc]$/.test(a.type ?? "");

        if (isBox) W.boxPos.add(pos);
        else W.agentPos.add(pos);
    }
});

/* ============================================================
CACHE SYNC
============================================================ */

function syncCaches() {
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

/* ============================================================
HELPERS
============================================================ */

function carriedParcels() {
    return W.parcelList.filter(
        p => p.carriedBy === W.me?.id || W.carrying.has(p.id)
    );
}

function onDeliveryTile() {
    const k = key(W.me.x, W.me.y);
    const tile = W.tiles.get(k);
    return !!tile?.delivery || W.learnedDelivery.has(k);
}

function parcelsHere() {
    const here = key(W.me.x, W.me.y);
    return W.parcelList.filter(
        p => !p.carriedBy && key(p.x, p.y) === here
    );
}

function markVisited(x, y) {
    const k = key(x, y);
    W.visitCount.set(k, (W.visitCount.get(k) ?? 0) + 1);
}

function isWalkable(x, y, goalKey = null) {
    const k = key(x, y);

    if (!inKnownBounds(x, y)) return false;
    if (!W.tiles.has(k)) return false;
    if (k !== goalKey && W.boxPos.has(k)) return false;
    if (k !== goalKey && W.agentPos.has(k)) return false;
    if (W.tempBlocked.has(k)) return false;

    return true;
}

function canPickupHere() {
    const k = key(W.me.x, W.me.y);
    return (W.noPickupUntil.get(k) ?? 0) <= Date.now();
}

function blacklistGoal(target, ms = CFG.NO_GOAL_MS) {
    const tok = targetToken(target);
    if (!tok) return;
    W.badGoals.set(tok, Date.now() + ms);
}

function isGoalBlacklisted(target) {
    const tok = targetToken(target);
    if (!tok) return false;
    return (W.badGoals.get(tok) ?? 0) > Date.now();
}

function validGoal(target) {
    if (!target) return false;
    if (!Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
    if (!inKnownBounds(target.x, target.y)) return false;

    const k = key(target.x, target.y);
    return W.tiles.has(k);
}

/* ============================================================
A*
============================================================ */

class MinHeap {
    constructor() {
        this.data = [];
    }

    push(n) {
        this.data.push(n);
        let i = this.data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].f <= this.data[i].f) break;
            [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
            i = p;
        }
    }

    pop() {
        if (!this.data.length) return null;

        const top = this.data[0];
        const last = this.data.pop();

        if (this.data.length) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let l = i * 2 + 1;
                let r = i * 2 + 2;
                let s = i;

                if (l < this.data.length && this.data[l].f < this.data[s].f) s = l;
                if (r < this.data.length && this.data[r].f < this.data[s].f) s = r;
                if (s === i) break;

                [this.data[i], this.data[s]] = [this.data[s], this.data[i]];
                i = s;
            }
        }

        return top;
    }

    isEmpty() {
        return this.data.length === 0;
    }
}

function aStar(sx, sy, gx, gy) {
    const start = key(sx, sy);
    const goal = key(gx, gy);

    if (start === goal) return [];

    if (!validGoal({ x: gx, y: gy })) return null;

    const open = new MinHeap();
    const came = new Map();
    const gScore = new Map();
    const closed = new Set();

    open.push({ k: start, x: R(sx), y: R(sy), f: manhattan(sx, sy, gx, gy) });
    gScore.set(start, 0);

    let expansions = 0;

    while (!open.isEmpty() && expansions++ < CFG.ASTAR_MAX_EXPANSIONS) {
        const n = open.pop();
        if (!n || closed.has(n.k)) continue;
        closed.add(n.k);

        if (n.k === goal) {
            const path = [];
            let k = n.k;
            while (came.has(k)) {
                const step = came.get(k);
                path.unshift(step.dir);
                k = step.prev;
            }
            return path;
        }

        for (const d of DIRS) {
            const nx = n.x + d.dx;
            const ny = n.y + d.dy;
            const nk = key(nx, ny);

            if (!isWalkable(nx, ny, goal)) continue;

            const ng = (gScore.get(n.k) ?? Infinity) + 1;
            if (ng < (gScore.get(nk) ?? Infinity)) {
                came.set(nk, { prev: n.k, dir: d.dir });
                gScore.set(nk, ng);
                open.push({
                    k: nk,
                    x: nx,
                    y: ny,
                    f: ng + manhattan(nx, ny, gx, gy)
                });
            }
        }
    }

    return null;
}

/* ============================================================
TARGETING
============================================================ */

function nearestDeliveryFrom(x, y) {
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

function nearestDelivery() {
    return nearestDeliveryFrom(W.me.x, W.me.y);
}

function utility(p) {
    const distToParcel = manhattan(W.me.x, W.me.y, p.x, p.y);
    const dz = nearestDeliveryFrom(p.x, p.y);
    const distToDelivery = dz ? manhattan(p.x, p.y, dz.x, dz.y) : 0;

    return Math.pow(p.reward, CFG.DECAY_WEIGHT) /
        (1 + distToParcel + 0.35 * distToDelivery);
}

function bestParcel() {
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

function bestKnownApproachTile(tx, ty) {
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

function frontierTiles() {
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

function bestFrontierTarget() {
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

function planPathToTarget(target) {
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

function deliberate() {
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

/* ============================================================
REACTIVE ACTIONS
============================================================ */

function clearIntention() {
    intention = {
        type: null,
        target: null,
        path: null,
        steps: 0
    };
}

async function reactiveAction() {
    const carried = carriedParcels();
    const hereKey = key(W.me.x, W.me.y);

    if (carried.length && onDeliveryTile()) {
        const dropped = await api.putdown();

        if (Array.isArray(dropped) && dropped.length) {
            W.learnedDelivery.add(hereKey);
            setTile(W.me.x, W.me.y, true, false);

            for (const p of dropped) {
                const id = String(p.id ?? "");
                if (!id) continue;

                W.carrying.delete(id);
                W.parcels.delete(id);
            }

            parcelsDirty = true;
            deliveryDirty = true;
            clearIntention();

            W.noPickupUntil.set(hereKey, Date.now() + CFG.NO_PICKUP_AFTER_DELIVERY_MS);

            info("Delivered immediately", dropped.length);
            return true;
        }
    }

    if (canPickupHere()) {
        const picked = await api.pickup();

        if (Array.isArray(picked) && picked.length) {
            for (const p of picked) {
                const id = String(p.id);
                const prev = W.parcels.get(id) ?? {};

                W.parcels.set(id, {
                    ...prev,
                    id,
                    x: Number(p.x ?? W.me.x),
                    y: Number(p.y ?? W.me.y),
                    reward: Number(p.reward ?? prev.reward ?? 0),
                    carriedBy: W.me.id
                });

                W.carrying.add(id);
            }

            parcelsDirty = true;
            clearIntention();
            info("Picked immediately", picked.length);
            return true;
        }
    }

    return false;
}

/* ============================================================
MOVEMENT
============================================================ */

async function tryMoveDir(dir) {
    const [dx, dy] = DELTA[dir];
    const nx = R(W.me.x) + dx;
    const ny = R(W.me.y) + dy;
    const nk = key(nx, ny);

    debug("Trying move", dir, "to", nk);

    if (!inKnownBounds(nx, ny)) {
        W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
        debug("Move skipped out-of-bounds", dir, nk);
        return false;
    }

    const ok = await api.move(dir);

    if (!ok) {
        W.tempBlocked.set(nk, Date.now() + CFG.TEMP_BLOCK_MS);
        debug("Move failed", dir, nk);
        return false;
    }

    W.me.x = nx;
    W.me.y = ny;
    W.lastMove = dir;

    setTile(nx, ny, false, false);
    seedLocalMap();

    info("Move", dir);
    return true;
}

function rankedDirsToward(target = null) {
    const out = DIRS.map(d => {
        const nx = R(W.me.x) + d.dx;
        const ny = R(W.me.y) + d.dy;
        const nk = key(nx, ny);

        let score = 0;

        if (!inKnownBounds(nx, ny)) score += 1000;
        if (target) score += 5 * manhattan(nx, ny, target.x, target.y);
        score += 2 * (W.visitCount.get(nk) ?? 0);

        if (W.tempBlocked.has(nk)) score += 30;
        if (W.agentPos.has(nk)) score += 8;
        if (W.boxPos.has(nk)) score += 20;

        if (W.lastMove && inverseDir(W.lastMove) === d.dir) score += 1;

        const tile = W.tiles.get(nk);
        if (!tile) score += 10;
        else if (tile.guessed) score -= 0.2;

        return { dir: d.dir, nx, ny, nk, score };
    });

    out.sort((a, b) => a.score - b.score);
    return out;
}

async function fallbackMove(target = null) {
    const candidates = rankedDirsToward(target);
    debug("Fallback candidates", candidates.map(c => `${c.dir}:${c.score.toFixed(1)}`).join(" "));

    for (const c of candidates) {
        if (!inKnownBounds(c.nx, c.ny)) continue;
        if (W.boxPos.has(c.nk)) continue;
        if (W.tempBlocked.has(c.nk)) continue;

        const ok = await tryMoveDir(c.dir);
        if (ok) return true;
    }

    return false;
}

/* ============================================================
MAIN LOOP
============================================================ */

let busy = false;

async function tick() {
    if (!W.me || busy) return; 
    busy = true;

    try {
        syncCaches();
        markVisited(W.me.x, W.me.y);

        if (await reactiveAction()) return;

        const next = deliberate();

        const needNewPlan =
            !intention.type ||
            next.type !== intention.type ||
            !sameTarget(next.target, intention.target) ||
            intention.steps >= CFG.REPLAN_STEPS ||
            !Array.isArray(intention.path);

        if (needNewPlan) {
            let path = [];

            if (next.target) {
                path = planPathToTarget(next.target);

                if (path === null) {
                    blacklistGoal(next.target);
                    debug("Reject unreachable target", next.type, next.target);
                    clearIntention();
                    await fallbackMove(null);
                    await reactiveAction();
                    return;
                }

                if (path.length === 0 && !samePos(W.me, next.target)) {
                    blacklistGoal(next.target);
                    debug("Reject zero-path nonlocal target", next.type, next.target);
                    clearIntention();
                    await fallbackMove(null);
                    await reactiveAction();
                    return;
                }
            }

            intention.type = next.type;
            intention.target = next.target;
            intention.steps = 0;
            intention.path = path;

            debug("Known", W.tiles.size, "Parcels", W.parcelList.length, "Deliveries", W.deliveryZones.length);
            debug("New plan", intention.type, intention.target, "path", Array.isArray(intention.path) ? intention.path.length : "null");
        }

        intention.steps++;

        if (Array.isArray(intention.path) && intention.path.length > 0) {
            const dir = intention.path.shift();
            const ok = await tryMoveDir(dir);

            if (!ok) {
                if (intention.target) blacklistGoal(intention.target);
                clearIntention();
                await fallbackMove(next.target);
            }

            await reactiveAction();
            return;
        }

        if (next.target && samePos(W.me, next.target)) {
            await reactiveAction();
            return;
        }

        await fallbackMove(next.target);
        await reactiveAction();

    } catch (err) {
        warn("Tick error", err?.message ?? err);
        clearIntention();
    } finally {
        busy = false;
    }
}

setInterval(tick, CFG.TICK_RATE_MS);
console.log("Deliveroo Agent is ready!");