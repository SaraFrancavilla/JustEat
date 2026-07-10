import { W, intention } from '../world/state.js';
import { sendPlanToA } from "../coordination/outbox.js";

const positionHistory = [];
const MAX_HISTORY = 10;

// State Inspection Tools

async function getMyState() {
  try {
    const carryingArray = [...W.carrying].map(p => {
      if (typeof p === 'string') {
        const parcel = W.parcels?.get(p);
        return parcel ? { id: parcel.id, reward: parcel.reward } : { id: p };
      }
      return { id: p.id ?? '?', reward: p.reward ?? '?' };
    });

    console.log('[DEBUG] W.carrying contents:', [...W.carrying].map(p => JSON.stringify(p)));

    return JSON.stringify({
      id: W.me?.id || "unknown",
      name: W.me?.name || "unknown",
      position: { x: W.me?.x, y: W.me?.y },
      score: W.me?.score || 0,
      carrying: carryingArray.length,
      carriedParcels: carryingArray.map(p => ({ id: p.id, reward: p.reward })),
      currentIntention: intention?.type
        ? { type: intention.type, target: intention.target, hasPath: !!intention.path }
        : null,
    }, null, 2);
  } catch (error) {
    return `Error reading state: ${error.message}`;
  }
}

function getMapInfo() {
  try {
    const allTiles = [...(W.tiles?.values?.() ?? [])];
    const walkableTiles = allTiles.filter(t => t.walkable !== false);
    const directedTiles = allTiles.filter(t => t.direction);
    const deliveryTiles = [...(W.deliveryTiles?.values?.() ?? [])];

    const walkableSet = new Set(walkableTiles.map(t => `${t.x},${t.y}`));
    const branchingFactors = walkableTiles.map(t => {
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      return dirs.filter(([dx,dy]) => walkableSet.has(`${t.x+dx},${t.y+dy}`)).length;
    });
    const avgBranching = branchingFactors.length > 0
      ? (branchingFactors.reduce((a,b) => a+b, 0) / branchingFactors.length).toFixed(2)
      : null;

    const directedRatio = walkableTiles.length > 0
      ? (directedTiles.length / walkableTiles.length).toFixed(2)
      : 0;

    const deliverySpread = deliveryTiles.length > 1
      ? (() => {
          const xs = deliveryTiles.map(t => t.x);
          const ys = deliveryTiles.map(t => t.y);
          return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
        })()
      : 0;

    const dirClusters = [];
    const visited = new Set();

    for (const tile of directedTiles) {
      const key = `${tile.x},${tile.y}`;
      if (visited.has(key)) continue;

      const cluster = directedTiles.filter(t => {
        const dist = Math.abs(t.x - tile.x) + Math.abs(t.y - tile.y);
        return dist <= 3;
      });

      if (cluster.length >= 3) {
        const sameRow = cluster.every(t => t.y === cluster[0].y);
        const sameCol = cluster.every(t => t.x === cluster[0].x);
        const directions = [...new Set(cluster.map(t => t.direction))];

        if (sameRow || sameCol) {
          dirClusters.push({
            center: { x: tile.x, y: tile.y },
            size: cluster.length,
            aligned: sameRow ? 'horizontal' : 'vertical',
            directions
          });
          cluster.forEach(t => visited.add(`${t.x},${t.y}`));
        }
      }
    }

    return JSON.stringify({
      mapWidth: W.map?.width ?? null,
      mapHeight: W.map?.height ?? null,
      walkableTileCount: walkableTiles.length,
      deliveryTileCount: deliveryTiles.length,
      deliveryTiles: deliveryTiles.map(t => ({ x: t.x, y: t.y })),
      deliverySpread,
      avgBranchingFactor: Number(avgBranching),
      directedTileRatio: Number(directedRatio),
      directedTilesSample: directedTiles.slice(0, 10).map(t => ({ x: t.x, y: t.y, direction: t.direction })),
      directedTileClusters: dirClusters
    }, null, 2);
  } catch (error) {
    return `Error reading map info: ${error.message}`;
  }
}

async function getVisibleParcels() {
  try {
    const me = W.me;

    // Normalize carrying set to a set of valid string IDs
    const carriedIds = new Set(
      [...(W.carrying ?? [])]
        .map(p => (typeof p === "string" ? p : p?.id))
        .filter(id => typeof id === "string" && id !== "undefined")
    );

    const agents = [...(W.agents?.values?.() ?? [])].filter(a => a.id !== me?.id);
    const deliveryTiles = [...(W.deliveryTiles?.values?.() ?? [])];

    const freeParcels = W.parcelList
      // not carried by anyone and not already in my carrying set
      .filter(p => !p.carriedBy && !carriedIds.has(p.id))
      .sort((a, b) => b.reward - a.reward)
      .slice(0, 10)
      .map(p => {
        const myDist = Math.abs(p.x - me.x) + Math.abs(p.y - me.y);

        const closestEnemyDist = agents.length > 0
          ? Math.min(...agents.map(a => Math.abs(p.x - a.x) + Math.abs(p.y - a.y)))
          : Infinity;

        const closestDelivery = deliveryTiles.length > 0
          ? deliveryTiles.reduce(
              (best, t) => {
                const d = Math.abs(t.x - p.x) + Math.abs(t.y - p.y);
                return d < best.d ? { d, x: t.x, y: t.y } : best;
              },
              { d: Infinity, x: null, y: null }
            )
          : null;

        const directToDelivery = closestDelivery
          ? Math.abs(closestDelivery.x - me.x) + Math.abs(closestDelivery.y - me.y)
          : null;

        const viaParcelToDelivery = closestDelivery
          ? myDist + closestDelivery.d
          : null;

        const detourCost =
          directToDelivery != null && viaParcelToDelivery != null
            ? viaParcelToDelivery - directToDelivery
            : null;

        return {
          id: p.id,
          position: { x: p.x, y: p.y },
          reward: p.reward,
          myDist,
          closestEnemyDist: isFinite(closestEnemyDist) ? closestEnemyDist : null,
          reachable: myDist <= closestEnemyDist,
          detourCost,
        };
      });

    return JSON.stringify(freeParcels, null, 2);
  } catch (error) {
    return `Error reading parcels: ${error.message}`;
  }
}

async function getDeliveryTiles() {
  try {
    const tiles = [...W.deliveryTiles.values()]
      .slice(0, 5)
      .map(t => ({ x: t.x, y: t.y }));
    return JSON.stringify(tiles, null, 2);
  } catch (error) {
    return `Error reading delivery tiles: ${error.message}`;
  }
}

async function getBlockedInfo() {
  try {
    const blocked = {
      temporarilyBlocked: [...W.tempBlocked.keys()].slice(0, 5),
      blacklistedGoals: [...W.badGoals.entries()]
        .filter(([_, time]) => Date.now() < time)
        .slice(0, 5)
        .map(([goal, time]) => ({ position: goal, unblocksAt: new Date(time).toISOString() }))
    };
    return JSON.stringify(blocked, null, 2);
  } catch (error) {
    return `Error reading blocked info: ${error.message}`;
  }
}

function getStuckStatus() {
  try {
    const pos = { x: Math.round(W.me?.x), y: Math.round(W.me?.y) };
    positionHistory.push(pos);
    if (positionHistory.length > MAX_HISTORY) positionHistory.shift();

    const unique = new Set(positionHistory.map(p => `${p.x},${p.y}`)).size;
    const isStuck = positionHistory.length >= 6 && unique <= 3;
    const recentPath = positionHistory.map(p => `(${p.x},${p.y})`).join(' → ');

    return JSON.stringify({ isStuck, uniquePositions: unique, recentPath });
  } catch (error) {
    return `Error reading stuck status: ${error.message}`;
  }
}

function getAgents() {
  try {
    const me = W.me;
    const deliveryTiles = [...(W.deliveryTiles?.values?.() ?? [])];

    const agents = [...(W.agents?.values?.() ?? [])]
      .filter(a => a.id !== me?.id)
      .map(a => {
        const closestDelivery = deliveryTiles.length > 0
          ? deliveryTiles.reduce((best, t) => {
              const d = Math.abs(t.x - a.x) + Math.abs(t.y - a.y);
              return d < best.d ? { d, x: t.x, y: t.y } : best;
            }, { d: Infinity, x: null, y: null })
          : null;
        return {
          id: a.id,
          x: a.x,
          y: a.y,
          carrying: a.carrying ?? 0,
          distToNearestDelivery: closestDelivery?.d ?? null,
        };
      });

    if (agents.length === 0) {
      return JSON.stringify({ agents: [], congestion: "No other agents visible. All delivery tiles are free." });
    }

    const congestion = deliveryTiles.map(t => ({
      deliveryTile: { x: t.x, y: t.y },
      agentsNearby: agents.filter(a =>
        Math.abs(a.x - t.x) + Math.abs(a.y - t.y) <= 8
      ).length
    }));

    return JSON.stringify({ agents, congestion }, null, 2);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// Communication Tools

let socket = null;

export function setSocket(socketInstance) {
  socket = socketInstance;
}

async function sendMessage(input, recipientOverride = null) {
  if (!socket) return "Error: Socket not initialized";

  try {
    let recipientId = recipientOverride;
    let message = input;

    if (!recipientId) {
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      recipientId = parsed?.recipientId ?? null;
      message = parsed?.message ?? parsed;
    }

    if (!recipientId) {
      return "Error: recipientId missing";
    }

    const msg = typeof message === "string" ? { text: message } : message;
    await socket.say(recipientId, msg);
    return `Sent message to ${recipientId}: ${JSON.stringify(msg)}`;
  } catch (error) {
    return `Error sending message: ${error.message}`;
  }
}

async function broadcastMessage(message) {
  if (!socket) return "Error: Socket not initialized";
  try {
    const msg = typeof message === "string" ? { text: message } : message;
    await socket.shout(msg);
    return `Broadcast: ${JSON.stringify(msg)}`;
  } catch (error) {
    return `Error broadcasting: ${error.message}`;
  }
}

async function askTeammate(input) {
  if (!socket) return "Error: Socket not initialized";
  try {
    const { recipientId, question } = typeof input === "string" ? JSON.parse(input) : input;
    const msg = typeof question === "string" ? { text: question } : question;
    const reply = await socket.ask(recipientId, msg);
    return `Asked ${recipientId}: ${JSON.stringify(msg)}. Reply: ${JSON.stringify(reply)}`;
  } catch (error) {
    return `Error asking teammate: ${error.message}`;
  }
}

// Coordination Tools

const coordination = {
  parcelReservations: new Map(),
  pendingMessages: [],
  bdiFeedback: [],
  lastProcessed: Date.now()
};

// Helper: extract a parcel ID from various input shapes the LLM might send
function extractParcelId(input) {
  if (typeof input === 'object' && input !== null) {
    return input.targetParcelId ?? input.parcelId ?? input.id ?? null;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed.targetParcelId ?? parsed.parcelId ?? parsed.id ?? null;
      }
      // JSON-encoded plain string e.g. "\"p77\""
      return parsed;
    } catch {
      // Plain unquoted string e.g. "p77"
      return input.trim();
    }
  }
  return null;
}

async function reserveParcel(input) {
  try {
    // Normalize input: accept plain string "p1602" or object {"id":"p1602"}
    let parcelId;
    if (typeof input === 'object' && input !== null) {
      parcelId = input.id ?? input.parcelId;
    } else if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        parcelId = parsed.id ?? parsed.parcelId ?? input;
      } catch {
        // plain string like "p1602"
        parcelId = input;
      }
    }

    // Fall back to extractParcelId for any other format
    if (!parcelId) parcelId = extractParcelId(input);

    if (!parcelId) {
      return `Error: could not extract parcel ID from input: ${JSON.stringify(input)}`;
    }

    const myId = W.me?.id || 'unknown';

    if (coordination.parcelReservations.has(parcelId)) {
      const existing = coordination.parcelReservations.get(parcelId);
      if (existing.agentId !== myId) {
        return `Parcel ${parcelId} already reserved by ${existing.agentId}`;
      }
      return `Parcel ${parcelId} already reserved by you`;
    }

    coordination.parcelReservations.set(parcelId, { agentId: myId, timestamp: Date.now() });
    return `Successfully reserved parcel ${parcelId}`;
  } catch (error) {
    return `Error reserving parcel: ${error.message}`;
  }
}

// Reset at the start of each coordination cycle
let planSentThisCycle = false;

export function resetCycleState() {
  planSentThisCycle = false;
}

async function sendPlanToBDI(input) {
  if (planSentThisCycle) {
    return "Error: A plan was already sent this cycle. Output Final Answer now.";
  }
  try {
    const plan = typeof input === "string" ? JSON.parse(input) : input;
    const planMsg = { type: "llm_plan", plan, timestamp: Date.now() };
    coordination.pendingMessages.push(planMsg);
    sendPlanToA(plan);
    planSentThisCycle = true;
    return `Plan registered: ${JSON.stringify(planMsg, null, 2)}`;
  } catch (error) {
    return `Error sending plan: ${error.message}`;
  }
}

async function readBDIFeedback() {
  try {
    const messages = coordination.bdiFeedback.splice(0);
    if (messages.length === 0) return "No new messages from BDI agent.";
    return JSON.stringify(messages, null, 2);
  } catch (error) {
    return `Error reading feedback: ${error.message}`;
  }
}

// Tool Registry Export

export const TOOLS = {
  get_my_state:        getMyState,
  get_map_info:        getMapInfo,
  get_visible_parcels: getVisibleParcels,
  get_delivery_tiles:  getDeliveryTiles,
  get_blocked_info:    getBlockedInfo,
  get_stuck_status:    getStuckStatus,
  get_agents:          getAgents,
  reserve_parcel:      reserveParcel,
  send_plan_to_bdi:    sendPlanToBDI,
  send_message:        sendMessage,
};

export { coordination };