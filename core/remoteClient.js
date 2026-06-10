// remoteClient.js — TCP client to the Claude_Copilot Python remote script (port 9001),
// which can load from Live's browser (Max for Live's LiveAPI cannot, on Live 12).
// Falls back gracefully: if the remote script isn't enabled, calls reject fast and
// the loader tools fall back to the (failing) v8 path with a MANUAL_LOAD hint.
const net = require("net");
const PORT = 9001;

function call(req, timeoutMs = 25000) {
  // offline guard for tests / CI — never touch a real Live session
  if (process.env.CLAUDE_COPILOT_NO_REMOTE) return Promise.reject(new Error("remote disabled (CLAUDE_COPILOT_NO_REMOTE)"));
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "";
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} fn(v); };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { return finish(reject, e); }
      finish(resolve, m);
    });
    sock.on("error", () => finish(reject, new Error("Claude_Copilot remote script not running — enable it in Live ▸ Settings ▸ Link/Tempo/MIDI ▸ Control Surface")));
    setTimeout(() => finish(reject, new Error("remote script timed out")), timeoutMs);
  });
}

module.exports = {
  available: () => call({ op: "ping" }, 1500).then((r) => !!(r && r.ok)).catch(() => false),
  load: (kind, track, name) => call({ op: "load", kind, name, track }, 15000),
  list: (category, limit, filter) => call({ op: "list", category, limit, filter }),
  session: () => call({ op: "session" }, 6000),
  meters: () => call({ op: "meters" }, 4000),
  fixMeters: () => call({ op: "fix_meters" }, 6000),
  pollChanges: () => call({ op: "poll_changes" }, 4000),
  tracks: () => call({ op: "tracks" }, 8000),
  track: (track) => call({ op: "track", track }, 8000),
  getParams: (track, device) => call({ op: "get_params", track, device }),
  setParam: (track, device, param, value) => call({ op: "set_param", track, device, param, value }),
  automate: (track, device, param, slot, ramp, points) => call({ op: "automate", track, device, param, slot, ramp, points }),
  automationGet: (track, device, param, slot, points) => call({ op: "automation_get", track, device, param, slot, points }),
  automationClear: (track, device, param, slot) => call({ op: "automation_clear", track, device, param, slot }),
  setProperty: (track, device, property, value) => call({ op: "set_property", track, device, property, value }),
  getDevice: (track, device) => call({ op: "get_device", track, device }),
  loadSound: (track, name) => call({ op: "load_sound", track, name }),
  recordMaster: (bars) => call({ op: "record_master", bars }),
  stopRecord: () => call({ op: "stop_record" }),
  chains: () => call({ op: "chains" }, 10000),
  pitches: () => call({ op: "pitches" }, 10000),
  wtMod: (track, device, target, source, amount) => call({ op: "wt_mod", track, device, target, source, amount }, 8000),
  moveDevice: (track, device, to) => call({ op: "move_device", track, device, to }, 8000),
  cleanupCaptures: () => call({ op: "cleanup_captures" }, 10000),
  diag: () => call({ op: "diag" }, 12000),
  lomGet: (pathArr, prop) => call({ op: "lom_get", path: pathArr, prop }, 5000),
  lomSet: (pathArr, prop, value) => call({ op: "lom_set", path: pathArr, prop, value }, 6000),
  lomCall: (pathArr, method, args) => call({ op: "lom_call", path: pathArr, method, args }, 8000),
};
