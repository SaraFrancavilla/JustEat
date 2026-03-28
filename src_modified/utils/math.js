export const R = v => Math.round(v);

export const key = (x, y) => `${R(x)},${R(y)}`;

// export const manhattan = (ax, ay, bx, by) =>
//     Math.abs(R(ax) - R(bx)) + Math.abs(R(ay) - R(by));

export const manhattan = (ax, ay, bx, by) => {
    if (![ax, ay, bx, by].every(Number.isFinite)) {
        console.warn("⚠️ NaN detected in manhattan:", ax, ay, bx, by);
        return Infinity;
    }

    return Math.abs(Math.round(ax) - Math.round(bx)) +
           Math.abs(Math.round(ay) - Math.round(by));
};

export function samePos(a, b) {
    return !!a && !!b && R(a.x) === R(b.x) && R(a.y) === R(b.y);
}

export function sameTarget(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.id && b.id) return String(a.id) === String(b.id);
    return samePos(a, b);
}

export function targetToken(t) {
    if (!t) return null;
    if (t.id) return `id:${String(t.id)}`;
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
        return `xy:${key(t.x, t.y)}`;
    }
    return null;
}