import { W, visitedSpawns, syncCaches, intention, clearIntention } from "./world/state.js";
import { reactiveAction } from "./behavior/reactive.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import { deliberate, planPathToTarget, completeSpawnPatrol, getOldestUnseenSpawn } from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal } from "./world/helpers.js";
import { CFG, debug } from "./config.js";
import { key } from "./utils/math.js";

import { LLMCoordinationAgent } from "./llm/agent.mjs";
import client from "./client.js";

let busy = false;

// LLM runtime state
let llmAgent = null;
let llmBusy = false;
let tickCounter = 0;

const LLM_COORDINATION_INTERVAL = 80;
const TEAMMATE_ID =
  process.env.TEAMMATE_ID ||
  process.argv.find((a) => a.startsWith("--teamId="))?.split("=")[1] ||
  null;

// Local retry tracking for oscillation/stuck situations
let lastFailedTargetKey = null;
let failedTargetCount = 0;

function targetKey(target) {
  if (!target) return null;
  return `${Number(target.x)},${Number(target.y)}`;
}

function registerTargetFailure(target) {
  const k = targetKey(target);
  if (!k) return 0;

  if (k === lastFailedTargetKey) {
    failedTargetCount += 1;
  } else {
    lastFailedTargetKey = k;
    failedTargetCount = 1;
  }

  return failedTargetCount;
}

function clearTargetFailureMemory(target = null) {
  if (!target) {
    lastFailedTargetKey = null;
    failedTargetCount = 0;
    return;
  }

  const k = targetKey(target);
  if (k === lastFailedTargetKey) {
    lastFailedTargetKey = null;
    failedTargetCount = 0;
  }
}

// Only create LLM agent once we actually know who we are
function getLLMAgent() {
  if (!llmAgent && W.me) {
    llmAgent = new LLMCoordinationAgent(client);
  }
  return llmAgent;
}

function toPoint(v) {
  if (!v || v.x == null || v.y == null) return null;
  return { x: Number(v.x), y: Number(v.y) };
}

function dist2(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function nearestDeliveryTarget() {
  if (!W.me || !Array.isArray(W.deliveryTiles) || W.deliveryTiles.length === 0) {
    return null;
  }

  let best = null;
  let bestD = Infinity;

  for (const t of W.deliveryTiles) {
    const d = dist2(W.me, t);
    if (d < bestD) {
      bestD = d;
      best = { x: t.x, y: t.y };
    }
  }

  return best;
}

function missionIsActive() {
  return Boolean(
    W.activeMission?.accepted && W.activeMission?.status === "active"
  );
}

function missionNextAction() {
  const mission = W.activeMission;
  if (!mission || mission.status !== "active") return null;

  if (mission.objectiveType === "wait") {
    const until = mission.policy?.wait?.until ?? 0;
    if (Date.now() < until) {
      return { type: "WAIT", target: null };
    }

    W.activeMission.status = "completed";
    W._lastMissionId = null;
    console.log("[MISSION] Wait mission completed.");
    return null;
  }

  if (mission.objectiveType === "deliver_rule") {
    return null;
  }

  return null;
}

function ensureMissionPlanConsistency() {
  if (!missionIsActive()) return;

  if (W._lastMissionId !== W.activeMission.id) {
    clearIntention();
    W._lastMissionId = W.activeMission.id;
    console.log("[MISSION] Cleared previous intention for mission replanning.");
  }
}

function normalizeLLMPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  if (!plan.objective) return null;

  if (plan.objective === "collect_parcel") {
    const target = toPoint(plan.targetPosition);
    if (!target) {
      console.log("[LLM] collect_parcel rejected: missing/invalid targetPosition");
      return null;
    }

    if (plan.targetParcelId) {
      const parcel =
        W.parcels.get(plan.targetParcelId) ||
        W.parcelList.find((p) => p.id === plan.targetParcelId);

      if (parcel && parcel.carriedBy) {
        console.log(`[LLM] collect_parcel rejected: parcel ${plan.targetParcelId} already carried by ${parcel.carriedBy}`);
        return null;
      }
    }

    return { type: "COLLECT", target };
  }

  if (plan.objective === "deliver_now") {
    let target = null;

    // Prefer the LLM's chosen tile if it's actually a delivery tile
    if (plan.targetPosition) {
      const requested = toPoint(plan.targetPosition);
      const isValid = [...W.deliveryTiles.values()].some(
        t => t.x === requested?.x && t.y === requested?.y
      );
      if (isValid) target = requested;
    }

    // Fall back to nearest if the LLM's choice was invalid
    if (!target) target = nearestDeliveryTarget();
    if (!target) return null;

    return { type: "DELIVER", target };
  }

  if (plan.objective === "explore") {
    // Try to patrol a known spawn tile first
    const spawnTarget = getOldestUnseenSpawn(); 
    if (spawnTarget) {
      return { type: "PATROL", target: spawnTarget };
    }
    
    // If no spawns need checking, explore the frontiers
    return null; 
  }

  console.log(`[LLM] Plan rejected: unknown objective "${plan.objective}"`);
  return null;
}

function consumeLLMPlan() {
  const agent = getLLMAgent();
  if (!agent) return null;
  if (llmBusy) return null;
  if (missionIsActive()) return null;

  const plan = agent.getPendingPlan();
  
  if (!plan) return null;

  const normalized = normalizeLLMPlan(plan);
  agent.acknowledgePlan();

  if (normalized) {
    console.log(`[LLM] Using plan: ${plan.objective} -> Normalized to: ${normalized.type}`);
    return normalized;
  }

  return null;
}

function maybeTriggerLLMCoordination() {
  if (!W.me) return;
  if (llmBusy) return;
  if (missionIsActive()) return;

  tickCounter += 1;

  // Only coordinate every N ticks
  if (tickCounter % LLM_COORDINATION_INTERVAL !== 0) return;

  const agent = getLLMAgent();
  if (!agent) return;

  const request = JSON.stringify({
    request: "Coordinate the next best high-level action for the team.",
    instructions: "I have provided your current state. Use getvisibleparcels to see what is around you. If parcels are visible, calculate the distance to them (using x/y coordinates). DO NOT target a parcel if the distance to it is greater than or equal to its 'reward' value, because it will despawn before you arrive. If valid parcels exist, use send_plan_to_bdi with objective 'collect_parcel'. If NO valid parcels are visible, use send_plan_to_bdi with objective 'explore' and DO NOT include a targetPosition.",
    teammateId: TEAMMATE_ID,
    me: {
      id: W.me.id,
      name: W.me.name,
      position: { x: W.me.x, y: W.me.y },
      score: W.me.score
    },
    mapInfo: {
      width: W.mapWidth,
      height: W.mapHeight,
      walkableTileCount: W.tiles.size
    },
    carryingCount: W.carrying?.size ?? 0,
    currentIntention: intention.type
      ? { type: intention.type, target: intention.target }
      : null
  });

  llmBusy = true; // Set thinking flag
  console.log("[LLM] Triggering coordination.");

  agent
    .coordinate(request)
    .catch((err) => {
      console.error("[LLM] coordination error:", err);
    })
    .finally(() => {
      llmBusy = false; // Release thinking flag when done
    });
}

const SENSOR_RADIUS = 5; 

function updateSpatialMemory() {
  if (!W.me || !W.spawnTiles) return;

  const now = Date.now();
  for (const t of W.spawnTiles) {
    const dist = Math.abs(W.me.x - t.x) + Math.abs(W.me.y - t.y);
    
    // If the spawn tile is within our vision radius, mark it as "seen recently"
    if (dist <= SENSOR_RADIUS) {
      visitedSpawns.set(`${t.x},${t.y}`, now);
    }
  }
}

export async function tick() {
  if (!W.me || busy) return;
  busy = true;

  try {
    syncCaches();

    // Update internal memory
    updateSpatialMemory(); 

    const missionAction = missionNextAction();

    ensureMissionPlanConsistency();

    if (missionIsActive() && missionAction?.type === "WAIT") {
      if (intention.type !== "WAIT") {
        clearIntention();
        intention.type = "WAIT";
        intention.target = null;
        intention.steps = 0;
        intention.path = [];
        console.log("[MISSION] Entered WAIT mode.");
      }

      return;
    }

    // Immediate pickup / putdown always has priority
    if (await reactiveAction()) {
      clearTargetFailureMemory();
      return;
    };

    // Leave early if patrol target entered vision and is empty
    if (intention.type === "PATROL" && intention.target) {
        const lastSeen = visitedSpawns.get(`${intention.target.x},${intention.target.y}`) || 0;
        const timeUnseen = (Date.now() - lastSeen) / 1000;
        
        // if within sensor radius
        if (timeUnseen < 1) {
            const hasParcel = W.parcelList.some(p => p.x === intention.target.x && p.y === intention.target.y);
            if (!hasParcel) {
                // empty tile: clear intention and target the next unseen tile in this area
                clearIntention();
            }
        }
    }

    // Trigger LLM coordination in background
    maybeTriggerLLMCoordination();

    // If an LLM plan is available, use it; otherwise normal BDI deliberation
    const llmNext = consumeLLMPlan();
    const next = llmNext || deliberate();

    // Only log if the LLM actually gave us a plan right now
    if (llmNext) {
        console.log(`[DECISION] Switched to new LLM plan: ${next.type} at target:`, next.target);
    }

    const needNewPlan =
      !intention.type ||
      next.type !== intention.type ||
      !sameTarget(next.target, intention.target) ||
      intention.steps >= CFG.REPLAN_STEPS ||
      !Array.isArray(intention.path);

    if (needNewPlan) {
      let path = [];

      if (next.target) {
        path = planPathToTarget(next.target);

        if (path === null) {
          blacklistGoal(next.target);
          debug("Reject unreachable target", next.type, next.target);
          clearIntention();
          await fallbackMove(null);
          await reactiveAction();
          return;
        }

        if (path.length === 0 && !samePos(W.me, next.target)) {
          blacklistGoal(next.target);
          debug("Reject zero-path nonlocal target", next.type, next.target);
          clearIntention();
          await fallbackMove(null);
          await reactiveAction();
          return;
        }
      }

      intention.type = next.type;
      intention.target = next.target;
      intention.steps = 0;
      intention.path = path;

      clearTargetFailureMemory();
    }

    if (intention.target && samePos(W.me, intention.target)) {
      const didSomething = await reactiveAction();
      const tile = W.tiles.get(key(W.me.x, W.me.y));

      if (!didSomething) {
        if (tile?.delivery) {
          blacklistGoal(intention.target);
        }

        if (intention.type === "PATROL") {
          completeSpawnPatrol();
        }

        clearIntention();
        clearTargetFailureMemory(intention.target);
        await fallbackMove(null);
      }

      return;
    }

    intention.steps++;

    if (Array.isArray(intention.path) && intention.path.length > 0) {
      const dir = intention.path.shift();
      const ok = await tryMoveDir(dir);

      if (!ok) {
        const fails = registerTargetFailure(intention.target);

        if (intention.target && fails >= 3) {
          blacklistGoal(intention.target);
          debug("Blacklisting repeatedly failing target", intention.target, "fails", fails);
          clearIntention();
        } else {
          intention.steps = 0;
        }

        await fallbackMove(intention.target);
        await reactiveAction();
        return;
      }

      clearTargetFailureMemory(intention.target);
      await reactiveAction();
      return;
    }

    await fallbackMove(next.target);
    await reactiveAction();
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}
