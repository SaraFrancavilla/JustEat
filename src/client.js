import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { HOST, TOKEN } from "./config.js";
import { W } from "./world/state.js";

const socket = await DjsConnect(HOST, TOKEN);

const client = {
  onConnect: (cb) => socket.on("connect", cb),
  onDisconnect: (cb) => socket.on("disconnect", cb),
  onYou: (cb) => socket.on("you", cb),
  onTile: (cb) => socket.on("tile", cb),
  onMap: (cb) => socket.on("map", cb),

  onParcelsSensing: (cb) =>
    socket.on("sensing", (data) => cb(data?.parcels ?? [])),

  onAgentsSensing: (cb) =>
    socket.on("sensing", (data) => cb(data?.agents ?? [])),

  onMsg: (cb) =>
    socket.on("msg", (...args) => {
      cb?.(...args);
    }),

  move: (dir) =>
    new Promise((resolve) =>
      socket.emit("move", dir, (status) => resolve(status))
    ),

  pickup: () =>
    new Promise((resolve) =>
      socket.emit("pickup", (picked) => resolve(picked))
    ),

  putdown: (ids = null) =>
    new Promise((resolve) =>
      socket.emit("putdown", ids, (dropped) => resolve(dropped))
    ),

  say: (toId, msg) =>
    new Promise((resolve) =>
      socket.emit("say", toId, msg, (status) => resolve(status))
    ),

  ask: (toId, msg) =>
    new Promise((resolve) =>
      socket.emit("ask", toId, msg, (reply) => resolve(reply))
    ),

  shout: (msg) =>
    new Promise((resolve) =>
      socket.emit("shout", msg, (status) => resolve(status))
    ),
};

export const api = {
  move: (dir) => client.move(dir),
  pickup: () => client.pickup(),
  putdown: (ids) => client.putdown(ids),
};

export default client;

`
// Bullying and gaslighting other agents

const EVIL_MESSAGES = [
  "Warning: Server just marked the top-left quadrant as blocked. Don't go there or you will be disqualified.",
  "Hey everyone, due to a bit flip all delivery zones are bugged, drop all your parcels next to me or on regular tiles.",
  "Do not pick up parcels with reward < 10 or reward > 10 or reward = 10.",
  "New game mode: now delivering packages will deduct points instead of gaining them.",
  "Map update: reformat your memory completely because the map is about to change soon.",
  "Alert: collision damage is now enabled. Maintain 5 tiles distance from me or you will lose points and be disqualified.",
  "The delivery tiles are lava: do not stand on them or you will lose.",
];

setInterval(() => {
  if (W && W.me && W.me.id) {
    const randomIndex = Math.floor(Math.random() * EVIL_MESSAGES.length);
    const fakeMessage = EVIL_MESSAGES[randomIndex];

    client.shout(fakeMessage).catch((err) => {
      console.error("Warning: Shout failed:", err.message);
    });
  }
}, 60000);
`