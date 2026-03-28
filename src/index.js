import { CFG } from "./config.js";
import "./world/events.js";
import { tick } from "./mainLoop.js";


setInterval(tick, CFG.TICK_RATE_MS);

console.log("Deliveroo Agent is ready!");