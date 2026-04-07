import { W, syncCaches, intention, clearIntention } from "./world/state.js";
import { reactiveAction } from "./behavior/reactive.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import { deliberate, planPathToTarget } from "./planning/targeting.js";
import { samePos, sameTarget } from "./utils/directions.js";
import { blacklistGoal } from "./world/helpers.js";
import { CFG, debug } from "./config.js";
import { key } from "./utils/math.js";

let busy = false;

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

export async function tick() {
  console.log("Tick...");

  if (!W.me || busy) return;
  busy = true;

  try {
    syncCaches();

    // Immediate pickup / putdown always has priority
    if (await reactiveAction()) {
      clearTargetFailureMemory();
      return;
    }

    const next = deliberate();

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

      debug("Known", W.tiles.size, "Parcels", W.parcelList.length, "Deliveries", W.deliveryTiles?.length ?? 0);
      debug("New plan", intention.type, intention.target, "path", Array.isArray(intention.path) ? intention.path.length : "null");
    }

    if (intention.target && samePos(W.me, intention.target)) {
      const didSomething = await reactiveAction();
      const tile = W.tiles.get(key(W.me.x, W.me.y));

      if (!didSomething) {
        // Stay on spawner tiles when empty-handed: it's a valid waiting behavior
        if (tile?.spawner && W.carrying.size === 0) {
          clearTargetFailureMemory(intention.target);
          return;
        }

        // Delivery tiles should not be sticky when empty / inactive
        if (tile?.delivery) {
          blacklistGoal(intention.target);
        }

        clearIntention();
        clearTargetFailureMemory(intention.target);
        await fallbackMove(null);
      }

      return;
    }

    intention.steps++;

    // Follow current plan if there is still a path
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
          // keep the same intention, just force a quick local dodge
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