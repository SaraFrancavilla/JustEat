import { carryingCount, onDeliveryTile, parcelsHere, isGoalBlacklisted } from "../world/helpers.js";
import { W } from "../world/state.js";
import { samePos } from "../utils/directions.js";
import {
  canIssueAction,
  pickupAction,
  putdownAction,
  canPickupNow,
  canDeliverNow,
} from "./actions.js";
import { carriedEffectiveTotal, positiveParcelsHere, dropRuleTarget } from "../planning/targeting.js";
import { normalizeMissionPolicy, hasRestrictiveParcelRules } from "../llm/mission-policies.js";

const REACTIVE_HARD_PICKUP_LIMIT = 15;

export function proposeReactiveAction(mission = null) {
  if (!canIssueAction()) return null;

  const carriedCountNow = carryingCount();
  // exclude blacklisted parcels here too - otherwise a just-dropped handoff
  // parcel gets grabbed right back next tick, since this reactive layer runs
  // independently of bestAdjacentParcel/bestNearbyParcel/bestParcel
  const hereParcels = parcelsHere().filter((p) => !isGoalBlacklisted(p));
  const onDelTile = onDeliveryTile();
  const policy = normalizeMissionPolicy(mission);

  // 1. Can we deliver?
  if (carriedCountNow > 0 && canDeliverNow(policy, carriedCountNow)) {
    // a drop_rule mission (e.g. "drop a parcel on tile (4,4)") can target a
    // tile that was never flagged as a normal delivery tile at all - putdown
    // itself has no such restriction (executeHandoffDrop already drops on
    // arbitrary tiles for handoffs), so standing on the mission's own
    // resolved target is just as valid a drop spot as a real delivery tile.
    // skipped outright when already on an ordinary delivery tile - only
    // worth resolving otherwise
    let onMissionDropTarget = false;
    if (!onDelTile) {
      const missionDropTarget = dropRuleTarget(policy);
      if (missionDropTarget && samePos(W.me, missionDropTarget)) {
        // W.me alone isn't trustworthy for a one-shot, exact-tile action:
        // movement.js sets it optimistically the instant a move's ack
        // resolves, which can be a full tick or more ahead of the next
        // genuine server-pushed "you" update actually confirming the agent
        // landed there. an ordinary delivery tolerates that gap (nearby
        // tiles are usually also valid delivery tiles), but a drop_rule
        // mission has exactly one tile that counts - putting the parcel
        // down before the server itself agrees we're on it risks it
        // landing wherever the server actually had us positioned instead
        // (observed in practice: the mission was reported "complete" while
        // the parcel was actually delivered at a real, different delivery
        // tile). cross-check against W.lastServerPos, which comes straight
        // from onYou and is never touched by the optimistic update
        onMissionDropTarget = !W.lastServerPos || samePos(W.lastServerPos, missionDropTarget);
      }
    }
    if (onDelTile || onMissionDropTarget) {
      if (hasRestrictiveParcelRules(policy)) {
        const eff = carriedEffectiveTotal(policy);
        if (eff < 0) return null; // Mission says these parcels are invalid here
      }
      return putdownAction();
    }
  }

  // 2. Can we pick up?
  if (carriedCountNow >= REACTIVE_HARD_PICKUP_LIMIT) return null;
  if (!canPickupNow(policy, carriedCountNow)) return null;

  const availableHere = hasRestrictiveParcelRules(policy)
    ? positiveParcelsHere(policy, carriedCountNow, { isOpportunistic: true, allowZeroReward: false }).filter(
        (p) => !isGoalBlacklisted(p)
      )
    : hereParcels;

  if (availableHere.length > 0) return pickupAction();

  return null;
}

export function proposeBaselineReactiveAction(hint = null) {
  return proposeReactiveAction(null);
}