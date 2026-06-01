import { W, visitedSpawns } from "../world/state.js";
import { manhattan, key, R } from "../utils/math.js";
import { DIRS } from "../utils/directions.js";
import { aStar } from "./astar.js";
import { carriedParcels, isGoalBlacklisted, validGoal } from "../world/helpers.js";
import { inKnownBounds } from "../world/tiles.js";
import { CFG } from "../config.js";


let forcedDeliveryTarget = null;
let currentSpawnPatrolTarget = null;
let existFrontier = true;
let currentExploreTarget = null;

const VISION_RADIUS = 5;

export function nearestDeliveryFrom(x, y) {
  let best = null;
  let d = Infinity;

  for (const z of W.deliveryTiles) {
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
  let candidates = [];

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;

    // Fast fail check: Manhattan distance vs Reward
    const mDist = manhattan(W.me.x, W.me.y, p.x, p.y);
    if (mDist > p.reward) {
        continue; // impossible to reach
    }

    // Calculate utility score
    const u = utility(p);
    candidates.push({ parcel: p, u: u });
  }

  // Sort from highest utility to lowest
  candidates.sort((a, b) => b.u - a.u);

  // Run A* pathfinding only on the best candidates until we find a reachable one
  for (const c of candidates) {
    const path = aStar(W.me.x, W.me.y, c.parcel.x, c.parcel.y);
    
    if (!path || path.length + 1 >= c.parcel.reward) {
        continue; // Too far, despawns before we arrive. Check the next best one.
    }
    
    // found best reachable parcel
    return c.parcel;
  }
  
  return null;
}

function bestAdjacentParcel() {
  let best = null;
  let bestReward = -Infinity;

  for (const p of W.parcelList) {
    if (p.carriedBy) continue;
    if (isGoalBlacklisted(p)) continue;
    if (manhattan(W.me.x, W.me.y, p.x, p.y) !== 1) continue;

    const reward = Number(p.reward ?? 0);
    if (reward > bestReward) {
      bestReward = reward;
      best = p;
    }
  }

  return best;
}

export function bestKnownApproachTile(tx, ty) {
  let best = null;
  let bestScore = Infinity;

  // Get all walkable tiles and their Manhattan dist to target
  const candidates = [];
  for (const t of W.tiles.values()) {
    // Skip walls/obstacles immediately
    if (t.walkable === false) continue; 
    
    const dist = manhattan(t.x, t.y, tx, ty);
    candidates.push({ tile: t, dist });
  }

  // Sort candidates by distance (closest first)
  candidates.sort((a, b) => a.dist - b.dist);

  // Run A* pathfinding only on the 10 closest walkable tiles
  const topCandidates = candidates.slice(0, 10);

  for (const c of topCandidates) {
    const t = c.tile;
    const path = aStar(W.me.x, W.me.y, t.x, t.y);
    
    if (path === null) continue;

    const guessedPenalty = t.guessed ? 0.2 : 0;
    const score = path.length + (2 * c.dist) + guessedPenalty;

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

// Dynamically clear spawn points that are empty in our vision
function updateVisibleSpawns() {
  if (!W.me) return;
  const now = Date.now();

  for (const s of W.spawnTiles) {
    // Chebyshev distance for square vision
    const dist = Math.max(Math.abs(W.me.x - s.x), Math.abs(W.me.y - s.y));
    
    if (dist <= VISION_RADIUS) {
      const hasParcel = W.parcelList.some(p => p.x === s.x && p.y === s.y);
      if (!hasParcel) {
        // if it's visible and it's empty -> mark it as visited
        visitedSpawns.set(`${s.x},${s.y}`, now);
      }
    }
  }
}

export function getOldestUnseenSpawn() {
  if (!W.spawnAreas || W.spawnAreas.length === 0) return null;

  const now = Date.now();
  let bestTarget = null;
  let bestClusterScore = -Infinity;

  // Evaluate each area
  for (const cluster of W.spawnAreas) {
    const unseenTiles = [];
    let maxTimeUnseen = 0;

    // Find which tiles in this specific area still need to be checked
    for (const t of cluster) {
      if (isGoalBlacklisted(t)) continue;
      const lastSeen = visitedSpawns.get(`${t.x},${t.y}`) || 0;
      const timeUnseenSeconds = (now - lastSeen) / 1000;

      // 15 second cooldown before we check a tile again
      if (timeUnseenSeconds >= 15) {
        unseenTiles.push(t);
        if (timeUnseenSeconds > maxTimeUnseen) {
          maxTimeUnseen = timeUnseenSeconds;
        }
      }
    }

    // If the whole area was seen recently, skip it entirely
    if (unseenTiles.length === 0) continue;

    // Find the closest unseen tile within this area to walk towards
    let closestUnseen = null;
    let minDist = Infinity;
    for (const t of unseenTiles) {
      const d = manhattan(W.me.x, W.me.y, t.x, t.y);
      if (d < minDist) {
        minDist = d;
        closestUnseen = t;
      }
    }

    // Score the area: staleness of the area - distance to the closest edge of it
    const score = maxTimeUnseen - (minDist * 2);

    if (score > bestClusterScore) {
      bestClusterScore = score;
      bestTarget = { x: closestUnseen.x, y: closestUnseen.y };
    }
  }

  if (bestTarget) {
    currentSpawnPatrolTarget = bestTarget; 
  }
  return bestTarget;
}

function nextSpawnPatrolTarget() {
  updateVisibleSpawns(); // clear visible spawns

  if (currentSpawnPatrolTarget && !isGoalBlacklisted(currentSpawnPatrolTarget)) {
    // if still valid, check if it is still unseen and not blacklisted
    const lastSeen = visitedSpawns.get(`${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`) || 0;
    
    // if not seen in the last 2 seconds, keep walking to it
    if (Date.now() - lastSeen > 2000) {
      return currentSpawnPatrolTarget;
    }
    // if just seen as empty don't go there
    currentSpawnPatrolTarget = null;
  }

  // find oldest unseen spawn point (not blacklisted)
  return getOldestUnseenSpawn();
}

export function completeSpawnPatrol() {
  if (currentSpawnPatrolTarget) {
      visitedSpawns.set(`${currentSpawnPatrolTarget.x},${currentSpawnPatrolTarget.y}`, Date.now());
  }
  currentSpawnPatrolTarget = null;
}

/**
 * Decide what to do next: deliver parcels, pick up parcels, explore frontiers or patrol spawwns
 */
export function deliberate() {
  // ensure map memory is fresh before making any decisions
  updateVisibleSpawns();

  const carried = carriedParcels();
  const total = carried.reduce((s, p) => s + p.reward, 0);
  const dz = nearestDelivery();

  if (!carried.length) {
    forcedDeliveryTarget = null;
  }

  const softLimit = W.strategy?.carryTarget ?? 2;
  const hardLimit = 15; 

  const adjacentParcel = bestAdjacentParcel();
  if (adjacentParcel && carried.length < hardLimit) {
    forcedDeliveryTarget = null;
    return { type: "PICKUP", target: adjacentParcel };
  }

  const p = bestParcel();
  const isParcelVeryClose = p && manhattan(W.me.x, W.me.y, p.x, p.y) <= 3;

  if (isParcelVeryClose && carried.length < hardLimit) {
    forcedDeliveryTarget = null;
    return { type: "PICKUP", target: p };
  }

  if (carried.length && forcedDeliveryTarget) {
    const lockedValid = validGoal(forcedDeliveryTarget) && !isGoalBlacklisted(forcedDeliveryTarget);

    if (lockedValid) {
      return { type: "DELIVER", target: forcedDeliveryTarget };
    } else {
      forcedDeliveryTarget = null; 
    }
  }

  if (carried.length > 0 && dz && !isGoalBlacklisted(dz)) {
    const d = manhattan(W.me.x, W.me.y, dz.x, dz.y);

    if (carried.length >= softLimit || d <= 1 || total >= 80 || carried.length === W.parcelList.length) {
      forcedDeliveryTarget = { x: dz.x, y: dz.y };
      return { type: "DELIVER", target: dz };
    }

    if (total >= CFG.DELIVER_REWARD_THRESHOLD && d <= CFG.DELIVER_DIST_THRESHOLD) {
      const path = planPathToTarget(dz);
      if (path && path.length > 0) {
        forcedDeliveryTarget = { x: dz.x, y: dz.y };
        return { type: "DELIVER", target: dz };
      }
    }
  }

  if (p) {
    return { type: "PICKUP", target: p };
  } 

  // No parcels available: patrol
  if (W.spawnTiles.length > 0) {
    const patrol = nextSpawnPatrolTarget();
    if (patrol) {
      return { type: "PATROL", target: patrol };
    }
  }

  // Go explore if no parcels and all spawns have been checked recently
  const frontiers = frontierTiles();
  if (frontiers.length > 0) {
    
    // Clear explore target if we are standing on it
    if (currentExploreTarget && samePos(W.me, currentExploreTarget)) {
       currentExploreTarget = null;
    }

    // if we are already exploring a valid frontier, keep going
    if (currentExploreTarget && !isGoalBlacklisted(currentExploreTarget)) {
      const stillValid = frontiers.some(f => f.x === currentExploreTarget.x && f.y === currentExploreTarget.y);
      if (stillValid) {
        return { type: "EXPLORE", target: currentExploreTarget };
      }
    }

    // if we don't have a target, pick the closest one
    let bestFrontier = null;
    let closestDist = Infinity;
    
    for (const f of frontiers) {
      if (isGoalBlacklisted(f)) continue;
      const d = manhattan(W.me.x, W.me.y, f.x, f.y);
      if (d < closestDist) {
        closestDist = d;
        bestFrontier = { x: f.x, y: f.y };
      }
    }
    
    if (bestFrontier) {
      currentExploreTarget = bestFrontier;
      return { type: "EXPLORE", target: bestFrontier };
    }
  }

  currentExploreTarget = null;
  return { type: "EXPLORE", target: null };
}