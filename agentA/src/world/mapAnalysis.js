import { W } from "./state.js";
import { key } from "../utils/math.js";

// Basic helper to count walkable neighbors
function countWalkableNeighbors(x, y) {
    const dirs = [[0,1], [1,0], [0,-1], [-1,0]];
    let count = 0;
    for (const [dx, dy] of dirs) {
        const k = key(x + dx, y + dy);
        const tile = W.tiles.get(k);
        if (tile && tile.walkable) count++;
    }
    return count;
}

export function isCrateMap() {
  if (W.boxPos?.size > 0) return true;

  for (const tile of W.tiles.values()) {
    if (
      tile?.hasCrate ||
      tile?.crateTrack ||
      tile?.crate ||
      tile?.type === 5 ||
      tile?.pushable
    ) {
      return true;
    }
  }

  return false;
}

export function computeMapProfile() {
    let totalNeighbors = 0;
    let chokePoints = 0;
    let walkableCount = 0;

    for (const [k, tile] of W.tiles.entries()) {
        if (!tile.walkable) continue;
        
        walkableCount++;
        const neighbors = countWalkableNeighbors(tile.x, tile.y);
        totalNeighbors += neighbors;
        
        if (neighbors <= 2) chokePoints++; // Corridors and dead-ends
    }

    const avgBranchingFactor = walkableCount > 0 ? (totalNeighbors / walkableCount) : 0;

    const deliveryCount = W.deliveryTiles.length;

    W.mapProfile = {
        walkableTiles: walkableCount,
        deliveryTiles: deliveryCount,
        chokePointRatio: walkableCount > 0 ? Number((chokePoints / walkableCount).toFixed(2)) : 0,
        avgBranchingFactor: Number(avgBranchingFactor.toFixed(2))
    };

    return W.mapProfile;
}

export function classifyBaseMapType(avgBranchingFactor) {
  const bf = Number(avgBranchingFactor ?? 3);

  if (bf > 3.5) return "Open";
  if (bf < 2.5) return "Hallways";
  return "Hub";
}

export function classifyCarryTarget(baseType, hasCrates) {
  if (baseType === "Open") return hasCrates ? 3 : 4;
  if (baseType === "Hallways") return 1;
  return hasCrates ? 2 : 3;
}

export function computeStrategy() {
  const profile = W.mapProfile ?? computeMapProfile();
  const hasCrates = isCrateMap();
  const baseType = classifyBaseMapType(profile.avgBranchingFactor, hasCrates);
  const mapType = hasCrates ? `${baseType} with crates` : baseType;
  const carryTarget = classifyCarryTarget(baseType, hasCrates);

  W.strategy = {
    mapType,
    carryTarget,
    baseType,
    hasCrates,
  };

  return W.strategy;
}