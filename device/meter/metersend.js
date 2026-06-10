// metersend.js — node.script in the ClaudeMeter device. Receives the throttled
// per-track metrics from the Max patch and POSTs them to the main ClaudeCopilot
// panel's HTTP server (127.0.0.1:8723/meter). Runs in its OWN subprocess, so even
// if it stalls it can't take down Max or the main panel. No LiveAPI, no deps.
//
// PROTOCOL with the patch (build-meter.js must match exactly):
//   in  "trackindex N"  — once at load, from metertrack.js (0.. tracks, -1 master,
//                         -2-r returns, -999 unknown)
//   in  "metrics <peak> <rms> <low> <lowmid> <mid> <high> [<playing> <beats>]"
//                       — ~12 Hz linear amplitudes; playing = transport 0/1 and
//                         beats = song position (from plugsync~), both optional so
//                         older baked meters keep working
//   out "rec open <path>" / "rec 1" / "rec 0"
//                       — recording commands for [route rec] -> [sfrecord~ 2];
//                         they arrive as the RESPONSE BODY of the /meter POST, so
//                         the main panel can start/stop a wav capture on THIS track
//                         without any extra connection.
const Max = require("max-api");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let track = -999; // sentinel = unknown (encoding: 0.. regular, -1 master, -2-r returns)

// PORT DISCOVERY: the panel's server prefers 8723 but falls back to 8724+ when the
// port is taken — it writes the REAL bound port to ~/.claude-copilot/webui.port.
// Re-read it (throttled) so the meter fleet always feeds the live panel.
const PORT_FILE = path.join(os.homedir(), ".claude-copilot", "webui.port");
let port = 8723, lastPortRead = 0;
function refreshPort() {
  const now = Date.now();
  if (now - lastPortRead < 5000) return;
  lastPortRead = now;
  try {
    const p = parseInt(fs.readFileSync(PORT_FILE, "utf8"), 10);
    if (p > 1024 && p < 65536) port = p;
  } catch (e) { /* panel not started yet — keep the default */ }
}
refreshPort();

Max.addHandler("trackindex", (i) => {
  const t = parseInt(i, 10);
  if (t === track) return;
  track = t;
  Max.post("ClaudeMeter on track " + track + (track === -1 ? " (master)" : track <= -2 && track > -900 ? " (return " + (-2 - track) + ")" : ""));
});

function applyCommand(cmd) {
  // one command per response: {rec:"open", path} | {rec:1} | {rec:0}
  if (!cmd || cmd.rec === undefined) return;
  try {
    if (cmd.rec === "open" && cmd.path) Max.outlet("rec", "open", String(cmd.path));
    else if (cmd.rec === 1 || cmd.rec === 0) Max.outlet("rec", cmd.rec);
  } catch (e) {}
}

// "metrics <peak> <rms> <low> <lowmid> <mid> <high> [<playing> <beats>]"
Max.addHandler("metrics", (...a) => {
  if (!Number.isFinite(track) || track <= -900) return; // don't report an unidentified meter
  const n = a.map(Number);
  const payload = { track, peak: n[0], rms: n[1] };
  if (n.length >= 6) payload.bands = { low: n[2], lowmid: n[3], mid: n[4], high: n[5] };
  else if (n.length >= 5) payload.bands = { low: n[2], mid: n[3], high: n[4] }; // legacy 3-band
  if (n.length >= 8) { payload.playing = n[6] > 0.5 ? 1 : 0; payload.beat = n[7]; }
  const data = JSON.stringify(payload);
  try {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/meter", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (r) => {
        // the response may carry a recording command for this track
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (d) => (body += d));
        r.on("end", () => { if (body) { try { applyCommand(JSON.parse(body)); } catch (e) {} } });
      }
    );
    req.on("error", () => refreshPort()); // panel not there (or moved ports) — re-discover, throttled
    req.write(data); req.end();
  } catch (e) {}
});

Max.post("ClaudeMeter sender ready");
