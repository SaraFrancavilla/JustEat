import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { HOST, getToken } from "./config.js";
import { W } from "./world/state.js";

const socket = await DjsConnect(HOST, getToken());

const client = {
  onConnect: (cb) => socket.on("connect", cb),
  onDisconnect: (cb) => socket.on("disconnect", cb),
  onYou: (cb) => socket.on("you", cb),
  onTile: (cb) => socket.on("tile", cb),
  onMap: (cb) => socket.on("map", cb),

  // server-pushed roster of every connected agent (id/name/teamId/teamName),
  // independent of vision range - fires 'connected'/'disconnected' for each
  onAgentConnected: (cb) => socket.on("controller", cb),

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