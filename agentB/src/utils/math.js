export const R = v => Math.round(v);

export const key = (x, y) => `${R(x)},${R(y)}`;


export const manhattan = (ax, ay, bx, by) => {
    if (
        !Number.isFinite(ax) ||
        !Number.isFinite(ay) ||
        !Number.isFinite(bx) ||
        !Number.isFinite(by)
    ) {
        return Infinity;
    }

    const dx = R(ax) - R(bx);
    const dy = R(ay) - R(by);
    return Math.abs(dx) + Math.abs(dy);
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