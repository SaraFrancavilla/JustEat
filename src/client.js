import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { HOST, TOKEN } from "./config.js";

const client = new DeliverooApi(HOST, TOKEN);

export const api = {
    move: d => client.move ? client.move(d) : client.emitMove(d),
    pickup: () => client.pickup ? client.pickup() : client.emitPickup(),
    putdown: ids => client.putdown ? client.putdown(ids) : client.emitPutdown(ids)
};

export default client;