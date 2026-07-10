import { W } from '../world/state.js';
import { normalizeMissionPolicy } from './mission-policies.js';
import { key, manhattan } from '../utils/math.js';

// How many nearby tiles to include in the problem
const MAX_TILES   = 80;
const MAX_PARCELS = 6;

/**
 * Returns a safe PDDL identifier from coordinates.
 * e.g. tile at (3,5) → "t3_5"
 */
function tileId(x, y) {
  return `t${x}_${y}`;
}

function parcelId(id) {
  return `p_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Builds the full PDDL problem string.
 * @param {object} mission  - raw mission from inbox (can be null)
 * @returns {string}        - complete PDDL problem text
 */
export function buildProblem(mission = null) {
  const policy  = normalizeMissionPolicy(mission);
  const me      = W.me;
  const meId    = 'agent1';
  const myPos   = { x: Math.round(me.x), y: Math.round(me.y) };
  const movementTarget = policy.movement.moveTo ?? policy.movement.meetTarget ?? null;

  // ── 1. Collect candidate tiles ──────────────────────────────────────────
  const allTiles   = [...(W.tiles?.values?.() ?? [])].filter(t => t.walkable !== false);
  const delivTiles = [...(W.deliveryTiles?.values?.() ?? [])];

  // Sort by manhattan distance from agent, keep MAX_TILES closest
  const nearTiles = allTiles
    .sort((a, b) => manhattan(myPos.x, myPos.y, a.x, a.y) - manhattan(myPos.x, myPos.y, b.x, b.y))
    .slice(0, MAX_TILES);

  // Always include delivery tiles even if far
  const tileSet = new Map();
  for (const t of [...nearTiles, ...delivTiles]) {
    tileSet.set(key(t.x, t.y), { x: t.x, y: t.y });
  }
  if (movementTarget && W.tiles?.has?.(key(movementTarget.x, movementTarget.y))) {
    tileSet.set(key(movementTarget.x, movementTarget.y), {
      x: Number(movementTarget.x),
      y: Number(movementTarget.y),
    });
  }
  const tiles = [...tileSet.values()];

  // ── 2. Collect candidate parcels ────────────────────────────────────────
  const carriedIds = new Set(
    [...(W.carrying ?? [])].map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
  );

  const forbiddenPickupKeys = new Set(
    (policy.pickup.forbiddenTiles ?? []).map(t => key(t.x, t.y))
  );

  const freeParcels = (W.parcelList ?? [])
    .filter(p => !p.carriedBy && !carriedIds.has(p.id))
    .filter(p => tileSet.has(key(p.x, p.y)))
    .sort((a, b) => b.reward - a.reward)
    .slice(0, MAX_PARCELS);

  const heldParcels = (W.parcelList ?? []).filter(p => carriedIds.has(p.id));

  // ── 3. Determine carry count predicate ─────────────────────────────────
  const currentCarry = heldParcels.length;
  const carryPred = `(carry-count-${Math.min(currentCarry, 3)} ${meId})`;

  // ── 4. Forbidden/preferred delivery tiles ──────────────────────────────
  const forbiddenDelivKeys = new Set(
    (policy.delivery.forbiddenTiles ?? []).map(t => key(t.x, t.y))
  );
  const zeroRewardKeys = new Set(
    (policy.delivery.zeroRewardTiles ?? []).map(t => key(t.x, t.y))
  );

  // ── 5. Preferred delivery tile (goal target) ───────────────────────────
  let goalDelivTile = null;
  if (policy.delivery.preferredTiles?.length > 0) {
    goalDelivTile = policy.delivery.preferredTiles[0];
  } else if (delivTiles.length > 0) {
    // pick closest delivery tile
    goalDelivTile = delivTiles.reduce((best, t) => {
      const d = manhattan(myPos.x, myPos.y, t.x, t.y);
      return d < best.d ? { ...t, d } : best;
    }, { d: Infinity });
  }

  // ── 6. Build goal ───────────────────────────────────────────────────────
  const exactCarry = policy.pickup.exactCarry;
  let goalLines = [];

  if (movementTarget) {
    goalLines.push(`(at ${meId} ${tileId(movementTarget.x, movementTarget.y)})`);
  } else if (Number.isFinite(exactCarry)) {
    // Goal: hold exactly N parcels and be on a delivery tile
    const targetParcels = freeParcels.slice(0, exactCarry);
    for (const p of targetParcels) {
      goalLines.push(`(holding ${meId} ${parcelId(p.id)})`);
    }
    if (goalDelivTile) {
      goalLines.push(`(at ${meId} ${tileId(goalDelivTile.x, goalDelivTile.y)})`);
    }
  } else if (heldParcels.length > 0 && goalDelivTile) {
    // Goal: deliver all currently held parcels
    for (const p of heldParcels) {
      goalLines.push(`(delivered ${parcelId(p.id)})`);
    }
  } else if (freeParcels.length > 0) {
    // Goal: pick up best parcel
    const best = freeParcels[0];
    goalLines.push(`(holding ${meId} ${parcelId(best.id)})`);
  }

  if (goalLines.length === 0) {
    // Fallback: reach nearest delivery tile
    if (goalDelivTile) {
      goalLines.push(`(at ${meId} ${tileId(goalDelivTile.x, goalDelivTile.y)})`);
    }
  }

  // ── 7. Assemble PDDL ────────────────────────────────────────────────────
  const tileObjects  = tiles.map(t => tileId(t.x, t.y)).join(' ');
  const parcelObjs   = [...freeParcels, ...heldParcels].map(p => parcelId(p.id)).join(' ');

  // Connectivity (4-directional)
  const connLines = [];
  const tileKeySet = new Set(tiles.map(t => key(t.x, t.y)));
  for (const t of tiles) {
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nk = key(t.x + dx, t.y + dy);
      if (tileKeySet.has(nk)) {
        connLines.push(`(connected ${tileId(t.x, t.y)} ${tileId(t.x+dx, t.y+dy)})`);
      }
    }
  }

  const delivLines  = delivTiles
    .filter(t => tileSet.has(key(t.x, t.y)))
    .map(t => `(delivery-tile ${tileId(t.x, t.y)})`);

  const parcelAtLines = freeParcels
    .map(p => `(parcel-at ${parcelId(p.id)} ${tileId(p.x, p.y)})`);

  const holdingLines  = heldParcels
    .map(p => `(holding ${meId} ${parcelId(p.id)})`);

  const forbidPickupLines = [...forbiddenPickupKeys]
    .filter(k => tileSet.has(k))
    .map(k => {
      const [x, y] = k.split(',').map(Number);
      return `(forbidden-pickup ${tileId(x, y)})`;
    });

  const forbidDelivLines = [...forbiddenDelivKeys]
    .filter(k => tileSet.has(k))
    .map(k => {
      const [x, y] = k.split(',').map(Number);
      return `(forbidden-delivery ${tileId(x, y)})`;
    });

  const zeroRewardLines = [...zeroRewardKeys]
    .filter(k => tileSet.has(k))
    .map(k => {
      const [x, y] = k.split(',').map(Number);
      return `(zero-reward-delivery ${tileId(x, y)})`;
    });

  return `
(define (problem deliveroo-mission)
  (:domain deliveroo)

  (:objects
    ${meId} - agent
    ${tileObjects} - location
    ${parcelObjs || '; no parcels'} - parcel
  )

  (:init
    (at ${meId} ${tileId(myPos.x, myPos.y)})
    ${carryPred}

    ; connectivity
    ${connLines.join('\n    ')}

    ; delivery tiles
    ${delivLines.join('\n    ')}

    ; parcels on ground
    ${parcelAtLines.join('\n    ')}

    ; parcels in hand
    ${holdingLines.join('\n    ')}

    ; mission constraints
    ${forbidPickupLines.join('\n    ')}
    ${forbidDelivLines.join('\n    ')}
    ${zeroRewardLines.join('\n    ')}
  )

  (:goal
    (and
      ${goalLines.join('\n      ')}
    )
  )
)
`.trim();
}
