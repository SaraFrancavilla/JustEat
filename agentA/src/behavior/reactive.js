import { W } from "../world/state.js";
import { samePos } from "../utils/directions.js";
import {
  carryingCount,
  parcelsHere,
  onDeliveryTile,
} from "../world/helpers.js";
import {
  canIssueAction,
  pickupAction,
  putdownAction,
  canPickupNow,
  canDeliverNow,
} from "./actions.js";

const REACTIVE_HARD_PICKUP_LIMIT = 15;

export function proposeReactiveAction(mission = null) {
  if (!canIssueAction()) return null;

  const carriedCount = carryingCount();
  const hereParcels = parcelsHere();
  const onDelTile = onDeliveryTile();

  // a coordination hint (moveTo/meetRadius/WAIT) suppresses opportunistic
  // pickups so the agent moves to rendezvous. exception: a collect_parcel
  // handoff is itself a directed pickup, but only once actually at the
  // handoff tile - without the samePos check it fired on every tile
  // crossed en route
  if (mission && (mission.mode === "WAIT" || mission.moveTo || Number.isFinite(mission.meetRadius))) {
    if (carriedCount > 0 && onDelTile && canDeliverNow(mission, carriedCount)) {
      return putdownAction();
    }
    if (
      mission.llmType === "PICKUP" &&
      mission.moveTo &&
      samePos(W.me, mission.moveTo) &&
      carriedCount < REACTIVE_HARD_PICKUP_LIMIT &&
      canPickupNow(mission, carriedCount) &&
      hereParcels.length > 0
    ) {
      return pickupAction();
    }
    return null;
  }

  if (carriedCount > 0 && onDelTile && canDeliverNow(mission, carriedCount)) {
    return putdownAction();
  }

  if (
    carriedCount < REACTIVE_HARD_PICKUP_LIMIT &&
    canPickupNow(mission, carriedCount) &&
    hereParcels.length > 0
  ) {
    return pickupAction();
  }

  return null;
}