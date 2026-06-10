// maxBridge.js — turns the fire-and-forget Max outlet into an awaitable async call.
// Runs inside node.script (Node for Max). Each call sends [liveapi_call reqId kind json]
// out node.script's outlet; the patch routes it to the [v8 liveapi.js] executor, which
// replies [liveapi_reply reqId ok json] back into node.script's inlet.
const Max = require("max-api");

const pending = new Map(); // reqId -> { resolve, reject, timer }
let seq = 0;
const nextId = () => `req_${++seq}`;

// One reply handler for all round-trips.
Max.addHandler("liveapi_reply", (reqId, ok, payloadJson) => {
  const p = pending.get(reqId);
  if (!p) return; // late/unknown -> ignore
  clearTimeout(p.timer);
  pending.delete(reqId);
  let payload;
  try { payload = JSON.parse(payloadJson); } catch { payload = payloadJson; }
  if (ok === 1 || ok === true) p.resolve(payload);
  else p.reject(new Error(typeof payload === "string" ? payload : (payload && payload.message) || JSON.stringify(payload)));
});

function callMax(kind, request = {}, { timeoutMs = 8000 } = {}) {
  const reqId = nextId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`Live op '${kind}' timed out — is Ableton responsive?`));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    Max.outlet("liveapi_call", reqId, kind, JSON.stringify(request));
  });
}

// The `live` object the Agent expects: live.call(kind, args) -> Promise.
const live = { call: (kind, args) => callMax(kind, args) };

module.exports = { callMax, live };
