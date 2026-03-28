import { api } from "../client.js";
import {DELTA, DIRS, inverseDir} from "../utils/directions.js";
import {R, key, manhattan} from "../utils/math.js";
import {inKnownBounds, seedLocalMap, setTile} from "../world/tiles.js";
import { W } from "../world/state.js";
import { debug, info, CFG } from "../config.js";


export async function tryMoveDir(dir) {
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

export function rankedDirsToward(target = null) {
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

export async function fallbackMove(target = null) {
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
