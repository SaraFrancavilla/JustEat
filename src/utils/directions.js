import { R } from "./math.js";

export const DIRS = [
    { dx: 0, dy: 1, dir: "up" },
    { dx: 0, dy: -1, dir: "down" },
    { dx: 1, dy: 0, dir: "right" },
    { dx: -1, dy: 0, dir: "left" }
];

export const DELTA = {
    up: [0, 1],
    down: [0, -1],
    right: [1, 0],
    left: [-1, 0]
};

export function inverseDir(dir) {
    return {
        up: "down",
        down: "up",
        left: "right",
        right: "left"
    }[dir] ?? null;
}

export function samePos(a, b) {
    return !!a && !!b && R(a.x) === R(b.x) && R(a.y) === R(b.y);
}

export function sameTarget(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.id && b.id) return String(a.id) === String(b.id);
    return samePos(a, b);
}