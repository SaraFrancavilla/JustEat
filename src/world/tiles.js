import { W } from "./state.js";
import { R, key } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";

let deliveryDirty = false;
export function isDeliveryDirty() { return deliveryDirty; }
export function clearDeliveryDirty() { deliveryDirty = false; }

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

export function classifyTileType(type) {
  const t = String(type ?? "").trim();

  if (t === "0") {
    return {
      type: "0",
      kind: "wall",
      walkable: false,
      oneWay: null,
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "1") {
    return {
      type: "1",
      kind: "spawner",
      walkable: true,
      oneWay: null,
      spawner: true,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "2") {
    return {
      type: "2",
      kind: "delivery",
      walkable: true,
      oneWay: null,
      spawner: false,
      delivery: true,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "3") {
    return {
      type: "3",
      kind: "walkable",
      walkable: true,
      oneWay: null,
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "4") {
    return {
      type: "4",
      kind: "base",
      walkable: true,
      oneWay: null,
      spawner: false,
      delivery: false,
      base: true,
      special: false,
      specialVariant: null
    };
  }

  if (t === "5" || t === "5!") {
    return {
      type: t,
      kind: "special",
      walkable: true,
      oneWay: null,
      spawner: false,
      delivery: false,
      base: false,
      special: true,
      specialVariant: t
    };
  }

  if (t === "↑") {
    return {
      type: "↑",
      kind: "oneway",
      walkable: true,
      oneWay: "up",
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "↓") {
    return {
      type: "↓",
      kind: "oneway",
      walkable: true,
      oneWay: "down",
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "←") {
    return {
      type: "←",
      kind: "oneway",
      walkable: true,
      oneWay: "left",
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  if (t === "→") {
    return {
      type: "→",
      kind: "oneway",
      walkable: true,
      oneWay: "right",
      spawner: false,
      delivery: false,
      base: false,
      special: false,
      specialVariant: null
    };
  }

  return {
    type: t,
    kind: "unknown",
    walkable: true,
    oneWay: null,
    spawner: false,
    delivery: false,
    base: false,
    special: false,
    specialVariant: null
  };
}

export function makeTile(x, y, type = "3", guessed = false) {
  const rx = R(x);
  const ry = R(y);
  const meta = classifyTileType(type);

  return {
    x: rx,
    y: ry,
    type: meta.type,
    kind: meta.kind,
    walkable: meta.walkable,
    oneWay: meta.oneWay,
    spawner: meta.spawner,
    delivery: meta.delivery,
    base: meta.base,
    special: meta.special,
    specialVariant: meta.specialVariant,
    guessed: !!guessed
  };
}

export function setTile(x, y, type = "3", guessed = false) {
  const rx = R(x);
  const ry = R(y);
  const k = key(rx, ry);
  const prev = W.tiles.get(k);

  // If tile is already known (not guessed) and we're only providing
  // a generic type, preserve the existing type
  const resolvedType =
    prev && !prev.guessed && type === "3"
      ? prev.type
      : (type || prev?.type || "3");

  const next = makeTile(rx, ry, resolvedType, !!guessed && !prev);

  const merged = {
    ...prev,
    ...next,
    guessed: !!guessed && !prev
  };

  W.tiles.set(k, merged);
  updateBounds(rx, ry);

  if (merged.delivery) {
    deliveryDirty = true;
  }
}

export function normalizeTileArgs(first) {
  // Server sends objects like { x, y, type, ... }
  if (
    first &&
    typeof first === "object" &&
    Number.isFinite(Number(first.x)) &&
    Number.isFinite(Number(first.y))
  ) {
    const rawType = String(first.type ?? first.tileType ?? "").trim();
    return {
      x: Number(first.x),
      y: Number(first.y),
      type: rawType || "3"
    };
  }

  // Fallback for legacy positional form
  const [x, y, rawType] = arguments;
  return {
    x: Number(x),
    y: Number(y),
    type: String(rawType ?? "3").trim() || "3"
  };
}

/**
 * Seeds unknown neighbors of current position as guessed walkable tiles.
 */
export function seedLocalMap() {
  if (!W.me) return;

  const x = R(W.me.x);
  const y = R(W.me.y);

  if (!W.tiles.has(key(x, y))) {
    setTile(x, y, "3", false);
  }

  for (const d of DIRS) {
    const nx = x + d.dx;
    const ny = y + d.dy;
    const nk = key(nx, ny);

    if (!inKnownBounds(nx, ny)) continue;
    if (!W.tiles.has(nk) && !W.tempBlocked.has(nk)) {
      W.tiles.set(nk, makeTile(nx, ny, "3", true));
    }
  }
}