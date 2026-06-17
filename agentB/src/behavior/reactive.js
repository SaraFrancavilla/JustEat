import { carryingCount, onDeliveryTile, parcelsHere } from "../world/helpers.js";
import {
  canIssueAction,
  pickupAction,
  putdownAction,
  canPickupNow,
  canDeliverNow,
} from "./actions.js";
import { carriedEffectiveTotal, positiveParcelsHere } from "../planning/targeting.js";
import { normalizeMissionPolicy, hasRestrictiveParcelRules } from "../llm/mission-policies.js";

const REACTIVE_HARD_PICKUP_LIMIT = 15;

export function proposeReactiveAction(mission = null) {
  if (!canIssueAction()) return null;

  const carriedCountNow = carryingCount();
  const hereParcels = parcelsHere();
  const onDelTile = onDeliveryTile();
  const policy = normalizeMissionPolicy(mission);

  // 1. Can we deliver?
  if (carriedCountNow > 0 && onDelTile && canDeliverNow(policy, carriedCountNow)) {
    if (hasRestrictiveParcelRules(policy)) {
      const eff = carriedEffectiveTotal(policy);
      if (eff < 0) return null; // Mission says these parcels are invalid here
    }
    return putdownAction();
  }

  // 2. Can we pick up?
  if (carriedCountNow >= REACTIVE_HARD_PICKUP_LIMIT) return null;
  if (!canPickupNow(policy, carriedCountNow)) return null;

  const availableHere = hasRestrictiveParcelRules(policy)
    ? positiveParcelsHere(policy, carriedCountNow, { isOpportunistic: true, allowZeroReward: false })
    : hereParcels;

  if (availableHere.length > 0) return pickupAction();

  return null;
}

export function proposeBaselineReactiveAction(hint = null) {
  return proposeReactiveAction(null);
}