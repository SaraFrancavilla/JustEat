import { W, syncCaches, intention, clearIntention } from "./world/state.js";
import { reactiveAction } from "./behavior/reactive.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import { deliberate, planPathToTarget, completeSpawnPatrol } from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal } from "./world/helpers.js";
import { CFG, debug } from "./config.js";
import { key } from "./utils/math.js";
import {pddlRequestInFlight, usingPddlPath, setUsingPddlPath} from "./planning/targeting.js";


let busy = false;

// Local retry tracking for oscillation/stuck situations
let lastFailedTargetKey = null;
let failedTargetCount = 0;


function sameRoundedPos(pos, expected) {
  return Math.round(Number(pos.x)) === Number(expected.x) &&
         Math.round(Number(pos.y)) === Number(expected.y);
}

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

function applyMoveBoxStep(step) {
  if (!step || step.type !== "movebox") return;
  if (!step.boxFrom || !step.boxTo) return;

  const fromKey = key(step.boxFrom.x, step.boxFrom.y);
  const toKey = key(step.boxTo.x, step.boxTo.y);

  if (W.boxPos.has(fromKey)) {
    W.boxPos.delete(fromKey);
    W.boxPos.add(toKey);
  }
}

export async function tick() {
  debug("Tick...");

  if (!W.me || busy || pddlRequestInFlight) return;
  busy = true;

  try {

    syncCaches();

    // Immediate pickup / putdown always has priority
    if (await reactiveAction()) {
      clearTargetFailureMemory();
      return;
    }

    if (!usingPddlPath){

      const next = deliberate();
      debug("Deliberate chose:", next);

      const needNewPlan =
        !intention.type ||
        next.type !== intention.type ||
        !sameTarget(next.target, intention.target) ||
        intention.steps >= CFG.REPLAN_STEPS ||
        !Array.isArray(intention.path);

      if (needNewPlan) {
        let path = [];

        if (next.target) {
          path = await planPathToTarget(next.target);

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
        
          // Delivery tiles should not be sticky when empty / inactive
          if (tile?.delivery) {
            blacklistGoal(intention.target);
          }

          // Complete PATROL when reached
          if (intention.type === "PATROL") {
            completeSpawnPatrol();
          }

          clearIntention();
          clearTargetFailureMemory(intention.target);
          await fallbackMove(null);
        }

        return;
      }
    }

    intention.steps++;

    // Follow current plan if there is still a path
    if (Array.isArray(intention.path) && intention.path.length > 0) {
      // const step = intention.path.shift();
      const step = intention.path[0];
      const dir = typeof step === "string" ? step : step?.dir;
      if (!dir) {
        clearIntention();
        await fallbackMove(null);
        await reactiveAction();
        return;
      }

      //MOVING THINGS AROUND
      if (step && typeof step === "object" && step.fromPddl) {
        const expectedBefore = step.type === "movebox" ? step.agentFrom : step.from;

        if (expectedBefore && !sameRoundedPos(W.me, expectedBefore)) {
          debug("[PDDL] Plan out of sync BEFORE step. Clearing plan.", {
            step,
            actual: { x: W.me.x, y: W.me.y },
            expectedBefore
          });

          clearIntention();
          setUsingPddlPath(false);
          clearTargetFailureMemory();
          return;
        }
      }


      debug("Trying to move in direction", dir, "towards", intention.target, "step:", step);

      const ok = await tryMoveDir(dir);

      if (!ok) {

        // const isPddlStep = step && typeof step === "object" && step.fromPddl;

        if (usingPddlPath) {
          debug("[PDDL] Step failed. Clearing PDDL plan without blacklisting target:", step);

          clearIntention();
          setUsingPddlPath(false);
          clearTargetFailureMemory();

          await fallbackMove(null);
          await reactiveAction();
          return;
        }else{

          const fails = registerTargetFailure(intention.target);
          debug("Movement failed towards", intention.target, "fail count:", fails);


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
      }

      intention.path.shift();

      if (step.type === "movebox") {
        debug('[PDDL] updating box position:', step.boxFrom, '->', step.boxTo);
        applyMoveBoxStep(step);
      }

      // Replan on the next tick so the route can adapt if the moved box opens
      // new space or if the environment changed while moving.
      clearTargetFailureMemory();
      await reactiveAction();
      return;
    } else setUsingPddlPath(false);

   await fallbackMove(intention.target ?? null);
    await reactiveAction();

  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}