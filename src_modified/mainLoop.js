import { W } from "./world/state.js";
import { reactiveAction } from "./behavior/reactive.js";
import { fallbackMove, tryMoveDir } from "./behavior/movement.js";
import { deliberate, planPathToTarget} from "./planning/targeting.js";
import { samePos, sameTarget} from "./utils/directions.js";
import { syncCaches, markVisited, intention, clearIntention } from "./world/state.js";
import { blacklistGoal } from "./world/helpers.js";
import {CFG, debug} from "./config.js";
import { onlineSolver, PddlExecutor } from "@unitn-asa/pddl-client";


let busy = false;

export async function tick() {

    console.log('Tick...');
    // if i do not exist or i am busy i simply wait for the next tick
    if (!W.me || busy) return;
    //else i'm busy and i avoid concurrent ticks
    busy = true;

    try {
        syncCaches();
        markVisited(W.me.x, W.me.y);

        //if i did somehting reactive like picking up or dropping off parcels, 
        // i wait for the next tick to synchronize the map and deliberate again
        if (await reactiveAction()) return;

        const next = deliberate();

        // check if we need to replan: 
        // if we don't have an intention, 
        // or the next intention is different from the current one, 
        // or we have been following the same intention for too long, 
        // or we don't have a path
        const needNewPlan =
            !intention.type ||
            next.type !== intention.type ||
            !sameTarget(next.target, intention.target) ||
            intention.steps >= CFG.REPLAN_STEPS ||
            !Array.isArray(intention.path);


        if (needNewPlan) {
            //use the online solver and the planner as in the github repo
            //onlineSolver, PddlExecutor 
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

            debug("Known", W.tiles.size, "Parcels", W.parcelList.length, "Deliveries", W.deliveryZones.length);
            debug("New plan", intention.type, intention.target, "path", Array.isArray(intention.path) ? intention.path.length : "null");
        }

        intention.steps++;

        if (Array.isArray(intention.path) && intention.path.length > 0) {
            const dir = intention.path.shift();
            const ok = await tryMoveDir(dir);

            if (!ok) {
                if (intention.target) blacklistGoal(intention.target);
                clearIntention();
                await fallbackMove(next.target);
            }

            await reactiveAction();
            return;
        }

        if (next.target && samePos(W.me, next.target)) {
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