// activityLog.js — a transparent, append-only record of EVERY tool the agent runs and
// the REAL result (param before→after, changed yes/no, errors, audible/silent, what
// loaded). So you can see exactly what happened under the hood instead of trusting the
// agent's prose. Written to ~/.claude-copilot/activity.log (readable text).
//   tail -f ~/.claude-copilot/activity.log     # watch live
//   node scripts/show-activity.js              # last 40 lines, pretty
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = path.join(os.homedir(), ".claude-copilot", "activity.log");
const MAX_BYTES = 512 * 1024; // keep the last ~512KB

function ensure() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {} }
function ts() { try { return new Date().toISOString().replace("T", " ").slice(0, 19); } catch { return "?"; } }

// Pull the few fields that actually tell you whether the action DID something.
function outcome(name, out, error) {
  if (error) return "✗ ERROR: " + String((error && error.message) || error);
  if (!out) return "(no result)";
  const r = (out && out.result !== undefined) ? out.result : out;
  if (r == null) return out.detail || "ok";
  const bits = [];
  if (r.error) bits.push("✗ " + r.error);
  if (r.value !== undefined) { let v; try { v = JSON.stringify(r.value); } catch { v = String(r.value); } bits.push("= " + String(v).slice(0, 100)); }
  if (r.changed === false) bits.push("NO CHANGE");
  if (r.changed === true) bits.push("changed " + r.before + "→" + r.after);
  if (r.param && r.before !== undefined) bits.push("'" + r.param + "' " + r.before + "→" + r.after);
  if (r.loaded) bits.push("loaded '" + r.loaded + "'" + (r.added === false ? " (but device count didn't rise!)" : ""));
  if (r.lastInChain) bits.push("last-in-chain=" + r.lastInChain);
  if (r.audible === false) bits.push("⚠ SILENT (no signal)");
  if (r.audible === true) bits.push("audible " + (r.peakDb != null ? r.peakDb + "dB" : ""));
  if (r.wrote != null) bits.push("wrote " + r.wrote + " notes" + (r.verified === false ? " (UNVERIFIED)" : ""));
  if (r.silent && r.silent.length) bits.push("SILENT tracks: " + r.silent.join(", "));
  if (r.ok === false && !r.error) bits.push("failed");
  if (!bits.length && out.detail) bits.push(out.detail);
  return bits.join(" · ") || "ok";
}

function log(name, input, out, error) {
  if (process.env.CLAUDE_COPILOT_NO_REMOTE) return ""; // test runs must NOT pollute the real log
  ensure();
  let inp = "";
  try { inp = JSON.stringify(input || {}); if (inp.length > 220) inp = inp.slice(0, 217) + "…"; } catch { inp = "?"; }
  const line = ts() + "  " + name + "  " + inp + "  →  " + outcome(name, out, error);
  try {
    fs.appendFileSync(FILE, line + "\n");
    // trim if it grew too big
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) { const buf = fs.readFileSync(FILE); fs.writeFileSync(FILE, buf.slice(buf.length - Math.floor(MAX_BYTES * 0.7))); }
  } catch {}
  return line;
}

function read(n = 40) {
  try { const lines = fs.readFileSync(FILE, "utf8").trim().split("\n"); return lines.slice(-n); } catch { return []; }
}

module.exports = { log, read, FILE };
