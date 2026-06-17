import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { HOST, getToken } from "./config.js";
import { W } from "./world/state.js";

const socket = await DjsConnect(HOST, getToken());

function buildReplyFn(rawReply, rawMsg, senderId) {
  if (typeof rawReply === "function") return rawReply;
  if (typeof rawMsg?.reply === "function") return rawMsg.reply;
  if (typeof rawMsg?.respond === "function") return rawMsg.respond;
  if (typeof rawMsg?.replyCallback === "function") return rawMsg.replyCallback;

  if (senderId == null) return null;

  return async (text) => {
    const msg = String(text ?? "").trim();
    if (!msg) return false;
    return new Promise((resolve) => {
      socket.emit("say", senderId, msg, (status) => resolve(status ?? true));
    });
  };
}

const client = {
  socket,

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
    socket.on("msg", (id, name, msg, reply) => {
      const safeReply = buildReplyFn(reply, msg, id);
      cb?.(id, name, msg, safeReply);
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