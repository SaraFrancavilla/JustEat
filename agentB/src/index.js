import fs from "fs";
import dotenv from "dotenv";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { startMapDebug } from "./world/state.js";

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

async function askToken() {
    if (process.env.DELIVEROO_TOKEN?.trim()) {
        console.log("Using token from environment variable.");
        return;
    }

    const rl = createInterface({ input, output });
    try {
        const token = (await rl.question("Insert your DeliverooJS token: ")).trim();
        if (token) {
            process.env.DELIVEROO_TOKEN = token;
        }
    } finally {
        rl.close();
    }
}

console.log("Welcome to the Deliveroo Agent!");
await askToken();
const { CFG } = await import("./config.js");
await import("./client.js");
await import("./world/events.js");
const { tick } = await import("./mainLoop.js");

setInterval(tick, CFG.TICK_RATE_MS);

console.log("Deliveroo Agent is ready!");

// startMapDebug(8000);