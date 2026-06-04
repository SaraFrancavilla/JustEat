import { info } from "../config.js";
import {
  carryingCount,
  parcelsHere,
  onDeliveryTile,
  carriedParcels,
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

  // info(
  //   "[DEBUG reactive]",
  //   "count", carriedCount,
  //   "knownCarried", carriedParcels().length,
  //   "parcelsHere", hereParcels.map((p) => `${p.id}@${p.x},${p.y}`).join(","),
  //   "onDelivery", onDelTile
  // );

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