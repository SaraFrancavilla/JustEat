import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { HOST, TOKEN } from "./config.js";

const socket = await DjsConnect(HOST, TOKEN);

const client = {
  onConnect:        cb => socket.on('connect', cb),
  onDisconnect:     cb => socket.on('disconnect', cb),
  onYou:            cb => socket.on('you', cb),
  onTile:           cb => socket.on('tile', cb),
  onMap:            (...args) => socket.on('map', ...args),
  onParcelsSensing: cb => socket.on('sensing', data => cb(data?.parcels ?? [])),
  onAgentsSensing:  cb => socket.on('sensing', data => cb(data?.agents ?? [])),
  onMsg:            cb => socket.on('msg', cb),
  move:             dir => new Promise(resolve => socket.emit('move', dir, status => resolve(status))),
  pickup:           () => new Promise(resolve => socket.emit('pickup', picked => resolve(picked))),
  putdown:          (ids = null) => new Promise(resolve => socket.emit('putdown', ids, dropped => resolve(dropped))),
  say:              (toId, msg) => new Promise(resolve => socket.emit('say', toId, msg, status => resolve(status))),
  ask:              (toId, msg) => new Promise(resolve => socket.emit('ask', toId, msg, reply => resolve(reply))),
  shout:            msg => new Promise(resolve => socket.emit('shout', msg, status => resolve(status))),
};

export const api = {
  move: (d) => client.move(d),
  pickup: () => client.pickup(),
  putdown: (ids) => client.putdown(ids),
};

export default client;