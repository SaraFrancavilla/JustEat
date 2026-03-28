import { key, manhattan } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";


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

export function aStar(sx, sy, gx, gy) {
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