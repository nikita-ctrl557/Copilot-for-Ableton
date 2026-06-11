// main.js — node.script entry (loaded with @autostart 1). Boots the Claude agent,
// bridges BOTH the in-Ableton jweb panel and a pop-out browser window to it, and
// streams results back. Node is bundled with Max, so no Node install is needed.
//
// Auth modes:
//   "subscription" (default) — `claude` CLI with the user's Pro/Max login (no key)
//   "apikey"                 — direct Anthropic API with an sk-ant- key
//   "local"                  — BETA: an OpenAI-compatible LOCAL server (Ollama,
//                              LM Studio, llama.cpp, Jan, GPT4All). Untested per
//                              provider; tool-calling quality depends on the model.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const Max = require("max-api");
const { live } = require("./maxBridge");
const { startWebUI } = require("./webui");

// --- config under ~/.claude-copilot/config.json (NOT inside the device) ---
const CFG_DIR = path.join(os.homedir(), ".claude-copilot");
const CFG = path.join(CFG_DIR, "config.json");
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } };
function saveCfg(patch) {
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify({ ...loadCfg(), ...patch }, null, 2), { mode: 0o600 }); }
  catch (e) { Max.post("config save failed: " + e.message); }
}

const cfg = loadCfg();
let authMode = cfg.authMode || "subscription";
let model = cfg.model || "claude-fable-5"; // default to the newest model
let effort = ["quick", "standard", "meticulous"].includes(cfg.effort) ? cfg.effort : "standard"; // how hard the copilot tries (settings slider)
let lastInitError = null;
let agent = makeAgent(authMode);
let busy = false;

function makeAgent(mode) {
  try {
    if (mode === "apikey") {
      const { Agent } = require("../../core/agent");
      const a = new Agent({ apiKey: process.env.ANTHROPIC_API_KEY || cfg.apiKey || "", model, live, effort });
      a.setPasses(loadCfg().passes);
      a.setWorkMode(loadCfg().workMode);
      return a;
    }
    if (mode === "local") {
      // BETA: local OpenAI-compatible server. The provider picks the default base
      // URL; the user can override both URL and model in settings.
      const { Agent } = require("../../core/agent");
      const { PROVIDERS } = require("../../core/openaiCompat");
      const c = loadCfg();
      const prov = PROVIDERS[c.localProvider] || PROVIDERS.ollama;
      return new Agent({
        apiKey: c.localApiKey || "", // most local servers ignore it; some want any token
        model: c.localModel || "",
        live,
        effort,
        transport: { kind: "local", baseUrl: c.localBaseUrl || prov.baseUrl, provider: c.localProvider || "ollama" },
      });
    }
    const { CliAgent } = require("./cliAgent"); // subscription via `claude` CLI (clean env)
    return new CliAgent({ model, live, effort });
  } catch (e) {
    lastInitError = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
    Max.post("agent init failed (" + mode + "): " + lastInitError);
    return null;
  }
}

// --- web UI server (resizable browser pop-out) ---
const web = startWebUI({
  chatHtmlPath: path.join(__dirname, "..", "chat.html"),
  onChat: (text) => handleChat(text),
  onConfig: (obj) => handleConfig(obj),
  onVoice: (action) => (action === "voice_stop" ? voiceStop() : voiceStart()),
  onStop: () => stopRun(),
  getStatus: () => statusObj(),
  getState: () => buildPanelState(),
  // publish the REAL bound port (8723 may be taken → fallback 8724+) so the
  // ClaudeMeter fleet can discover where to POST — they read this file.
  onReady: (port) => { try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(path.join(CFG_DIR, "webui.port"), String(port)); } catch {} },
});

// --- expandable project-info panel: live snapshot + memory + FULL meter data ---
// When two copilot devices run (strip + window), the ClaudeMeter fleet feeds
// whichever process owns port 8723 — if THIS process has no fresh meter data, it
// proxies the dump from the primary so the panel never shows empty bars.
const http = require("http");
function fetchPrimaryMeters() {
  return new Promise((resolve) => {
    const myPort = (web && web.port && web.port()) || 8723;
    if (myPort === 8723) return resolve(null); // we ARE the primary
    const req = http.get({ hostname: "127.0.0.1", port: 8723, path: "/meterdump", timeout: 800 }, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { const j = JSON.parse(b); resolve(j && j.ok ? j.rows : null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve(null); });
  });
}
async function buildPanelState() {
  const meterStore = require("../../core/meterStore");
  let sess = null, tracks = [], returns = [], masterT = null;
  try { const s = await remoteClient.session(); if (s && s.ok) sess = s; } catch {}
  try { const t = await remoteClient.tracks(); if (t && t.ok) { tracks = t.tracks || []; returns = t.returns || []; masterT = t.master || null; } } catch {}
  let mem = { direction: {}, tracks: {} };
  try { mem = projectMemory.load(await projectMemory.projectKey()); } catch {}
  // meter source: local store, else the primary process's dump
  let meterByTrack = new Map(meterStore.all().map((e) => [e.track, { ...e, activity: meterStore.activity(e.track) }]));
  if (!meterByTrack.size) {
    const remote = await fetchPrimaryMeters();
    if (remote) meterByTrack = new Map(remote.map((e) => [e.track, e]));
  }
  let beatNow = null;
  const deco = (t) => {
    const m = meterByTrack.get(t.index) || {};
    if (m.beat != null && m.playing) beatNow = m.beat;
    const note = mem.tracks[String(t.name)] || {};
    const ch = m.character || null;
    return {
      index: t.index, name: t.name, type: t.type,
      devices: (t.devices || []).filter((d) => !/claude\s*meter/i.test(String(d))),
      hasMeter: !!t.hasMeter, clips: t.clips || [],
      volume: t.volume, pan: t.pan, muted: !!t.muted, soloed: !!t.soloed,
      role: note.role, sound: note.sound,
      peakDb: m.peakDb, rmsDb: m.rmsDb,
      // full spectral read: per-band dB + ratios + plain-language character
      bands: ch ? { lowDb: ch.lowDb, lowmidDb: ch.lowmidDb, midDb: ch.midDb, highDb: ch.highDb, lowRatio: ch.lowRatio, highRatio: ch.highRatio } : null,
      character: ch && ch.summary,
      playsAt: m.activity && m.activity.bars,
    };
  };
  const out = {
    ok: true, session: sess, direction: mem.direction, projectKey: mem.projectKey,
    favPlugins: loadCfg().favPlugins || [],
    tracks: tracks.map(deco), returns: returns.map(deco), master: masterT ? deco(masterT) : null,
  };
  out.beat = beatNow;
  return out;
}

// Broadcast every UI event to BOTH the in-Ableton jweb and any open browser windows.
function toUI(obj) { try { Max.outlet("ui", JSON.stringify(obj)); } catch {} try { web.broadcast(obj); } catch {} }
function hasSetup() {
  if (authMode === "apikey") return !!(agent && agent.apiKey);
  if (authMode === "local") return !!loadCfg().localModel; // beta: needs at least a model name
  return true;
}
function autoScanOn() { return loadCfg().autoScan !== false; } // default ON

// --- SETUP CHECKS: live status for the in-chat setup guide (loader, voice, mics) ---
let loaderOk = false;   // updated by the auto-scan loop + a boot-time ping
let micCache = [];      // [{index, name}] from ffmpeg avfoundation
function binExists(name) { for (const d of ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"]) { try { if (fs.existsSync(d + name)) return d + name; } catch {} } return null; }
function listMics(cb) {
  const ff = binExists("ffmpeg");
  if (!ff) { micCache = []; if (cb) cb(); return; }
  execFile(ff, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], (e, so, se) => {
    // device list is printed to stderr; audio section follows "AVFoundation audio devices:"
    const out = String(se || "") + String(so || "");
    const mics = [];
    const audioPart = out.split(/AVFoundation audio devices/i)[1] || "";
    for (const m of audioPart.matchAll(/\[(\d+)\]\s+([^\n\[]+)/g)) mics.push({ index: +m[1], name: m[2].trim() });
    micCache = mics;
    if (cb) cb();
  });
}
function setupObj() {
  const v = loadCfg().voice || {};
  return {
    loader: loaderOk,
    ffmpeg: !!binExists("ffmpeg"),
    whisper: !!binExists("whisper"),
    micIndex: v.micIndex != null ? v.micIndex : null,
    mics: micCache,
  };
}
function statusObj() {
  const c = loadCfg();
  return { type: "status", ready: true, authMode, model, needsSetup: !hasSetup(), autoScan: autoScanOn(), setup: setupObj(),
    localProvider: c.localProvider || "ollama", localBaseUrl: c.localBaseUrl || "", localModel: c.localModel || "",
    favPlugins: c.favPlugins || [], effort, passes: c.passes || "auto", workMode: c.workMode || "auto",
    hasDeviceToken: !!c.oauthToken, port: (web && web.port && web.port()) || 8723 };
}
function status() { toUI(statusObj()); }

// --- AUTO-SCAN: poll the project in the background for the USER's changes, reconcile
// the diary, and tell the UI. Toggleable. Only runs when the loader answers. ---
const projectMemory = require("../../core/projectMemory");
const remoteClient = require("../../core/remoteClient");
let scanTimer = null;
let lastProjectKey = null; // for new-session recognition (set switch → fresh context)

// --- NEW-SESSION RECOGNITION (device load = a session boundary) ---------------
// A heartbeat file tells the NEXT boot when this session ended; at boot we compare
// and stamp a SESSION line into every PROJECT STATE ("started 14:32, previous
// session ended ~3h ago on <project>") + announce it in the chat. This is how the
// copilot KNOWS Live was closed and a new session opened, instead of being told.
const HEARTBEAT = path.join(CFG_DIR, "session.json");
function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 2) return "moments";
  if (m < 60) return m + " min";
  const h = Math.round(m / 60);
  if (h < 48) return h + " h";
  return Math.round(h / 24) + " days";
}
let bootRestarts = 0;
(function bootSession() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(HEARTBEAT, "utf8")); } catch {}
  const startedAt = new Date();
  const hhmm = startedAt.toTimeString().slice(0, 5);
  const gapMs = prev && prev.ts ? Date.now() - prev.ts : null;
  // QUICK RESTART ≠ NEW SESSION. The agent process restarts for boring reasons
  // (device reload, code update, Max hiccup) — if the previous heartbeat is fresh,
  // this is the SAME sitting: keep a quiet note, count it, and DON'T banner the
  // chat (a restart storm once printed nine 🆕 banners in six minutes).
  const QUICK_MS = 10 * 60 * 1000;
  const quick = gapMs != null && gapMs < QUICK_MS;
  const restarts = quick ? ((prev && prev.restarts) || 0) + 1 : 0;
  bootRestarts = restarts;
  let note;
  if (gapMs == null) note = "FIRST session on this machine — started " + hhmm + ".";
  else if (quick) note = "process restarted " + hhmm + " (same sitting — continue as before)" + (restarts >= 3 ? " · " + restarts + " quick restarts in a row" : "");
  else note = "NEW session started " + hhmm + " — the previous session ended ~" + agoText(gapMs) + " ago" + (prev.key ? " (project " + String(prev.key).replace(/^set:/, "") + ")" : "") + ". Re-orient from the CURRENT project state; treat remembered decisions as last time's, not today's.";
  projectMemory.setSessionNote(note);
  Max.post("session: " + note);
  if (!quick && gapMs != null) setTimeout(() => { try { toUI({ type: "projectChanged", diffs: ["🆕 " + note] }); } catch {} }, 1200);
  else if (restarts === 3) setTimeout(() => { try { toUI({ type: "stage", text: "⚠ the agent restarted " + restarts + " times in quick succession — if this keeps happening outside of updates, check Max's console" }); } catch {} }, 1200);
})();
setInterval(() => {
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(HEARTBEAT, JSON.stringify({ ts: Date.now(), key: lastProjectKey, restarts: bootRestarts })); } catch {}
}, 10000).unref();
function startAutoScan() {
  stopAutoScan();
  if (!autoScanOn()) return;
  // PRIMARY: drain real-time listener EVENTS (cheap — the Live loader pushes precise
  // change triggers: key/tempo/notes/devices/clips). FALLBACK: a full structural scan
  // every ~6th tick, and always if the loader predates poll_changes.
  const ms = Math.max(3, loadCfg().scanIntervalSec || 5) * 1000;
  let tick = 0;
  scanTimer = setInterval(async () => {
    if (busy) return; // don't fight an in-flight agent turn
    tick++;
    // NEW-SESSION RECOGNITION: when the user opens a DIFFERENT Live set, switch to
    // that project's own memory and clear the chat context — the old song's
    // conversation must not bleed into the new one. (projectKey re-derives every 30s.)
    try {
      const k = await projectMemory.projectKey();
      if (lastProjectKey && k !== lastProjectKey) {
        try { if (agent && agent.reset) agent.reset(); } catch {}
        projectMemory.setSessionNote("switched to project " + k.replace(/^set:/, "") + " at " + new Date().toTimeString().slice(0, 5) + " — its own memory is loaded; the previous chat context was cleared.");
        toUI({ type: "projectChanged", diffs: ["NEW PROJECT detected (" + k.replace(/^set:/, "") + ") — loaded its own memory, chat context reset"] });
        status();
      }
      lastProjectKey = k;
    } catch {}
    let eventsWorked = false;
    try {
      const p = await remoteClient.pollChanges();
      if (p && p.ok) {
        eventsWorked = true;
        if (!loaderOk) { loaderOk = true; status(); } // loader came online — refresh the setup guide
        if (p.events && p.events.length) {
          const texts = await projectMemory.applyEvents(p.events);
          if (texts.length) toUI({ type: "projectChanged", diffs: texts });
          // ANY device/track change (agent, LOM tool, or the USER dragging an effect in)
          // can bury a ClaudeMeter mid-chain — shove meters back to last automatically
          if (p.events.some((e) => e.kind === "devices" || e.kind === "tracks")) remoteClient.fixMeters().catch(() => {});
        }
      }
    } catch {}
    if (!eventsWorked || tick % 6 === 0) {
      try { const r = await projectMemory.scan(); if (r && r.ok && r.diffs.length) toUI({ type: "projectChanged", diffs: r.diffs }); } catch {}
    }
  }, ms);
  if (scanTimer.unref) scanTimer.unref();
}
function stopAutoScan() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

const pendingMsgs = []; // messages typed while busy — run them next, in order
async function handleChat(text) {
  text = String(text || "").trim();
  if (!text) return;
  if (busy) {
    if (pendingMsgs.length >= 3) { toUI({ type: "error", message: "queue full (3) — Stop the current run or wait." }); return; }
    pendingMsgs.push(text);
    toUI({ type: "stage", text: "⏸ queued (" + pendingMsgs.length + "): \"" + text.slice(0, 48) + (text.length > 48 ? "…" : "") + "\" — runs next" });
    return;
  }
  if (!agent) {
    // try once more (often it's a stale reload), then surface the REAL reason
    agent = makeAgent(authMode);
    if (!agent) { toUI({ type: "error", message: "agent failed to initialize (" + authMode + "): " + (lastInitError ? lastInitError.split("\n")[0] : "unknown") + (authMode === "apikey" ? " — paste your API key in ⚙ settings." : authMode === "local" ? " — check the local server URL + model in ⚙ (local LLMs are beta)." : " — try switching to API key in ⚙.") }); return; }
  }
  busy = true;
  toUI({ type: "busy", on: true }); // authoritative "working" signal for the UI indicator
  try {
    await agent.run(text, {
      onText: (t) => toUI({ type: "delta", text: t }),
      onTool: (tu) => toUI({ type: "tool", name: tu.name }),
      onToolResult: (tu, info) => toUI({ type: "toolResult", name: tu.name, label: info.label, detail: info.detail, error: info.error }),
      onStage: (t) => toUI({ type: "stage", text: String(t) }),
      onError: (e) => toUI({ type: "error", message: String(e.message || e) }),
    });
  } catch (e) {
    // a rejected run must SURFACE, never crash the node process (Node kills the
    // process on unhandled rejections — that was the silent "it crashes")
    toUI({ type: "error", message: "agent crashed: " + String((e && e.message) || e) });
  } finally {
    busy = false; toUI({ type: "busy", on: false }); toUI({ type: "done" });
    const next = pendingMsgs.shift();
    if (next) { toUI({ type: "stage", text: "▶ running queued message…" }); setTimeout(() => handleChat(next), 80); }
  }
}

// STOP the current run (kills the in-flight stream / CLI). Queue survives unless cleared.
function stopRun() {
  if (!busy) { toUI({ type: "stage", text: "nothing running" }); return; }
  try { if (agent && agent.stop) agent.stop(); } catch {}
  toUI({ type: "stage", text: "⏹ stopping…" });
  // failsafe: if the run doesn't settle in 5s, force-release the panel AND retire
  // the stuck agent — a still-alive orphan run must not share history (and an abort
  // flag) with the next run, so the next run gets a FRESH agent object
  setTimeout(() => {
    if (busy) {
      busy = false;
      agent = makeAgent(authMode);
      toUI({ type: "busy", on: false }); toUI({ type: "done" });
      toUI({ type: "stage", text: "force-stopped — chat context was reset to stay consistent" });
    }
  }, 5000);
}

// last-resort safety nets: log + surface instead of letting node.script die silently
process.on("unhandledRejection", (e) => { try { Max.post("unhandledRejection: " + String((e && e.message) || e)); toUI({ type: "error", message: "internal error: " + String((e && e.message) || e) }); } catch {} });
process.on("uncaughtException", (e) => { try { Max.post("uncaughtException: " + String((e && e.stack) || e)); toUI({ type: "error", message: "internal error: " + String((e && e.message) || e) }); } catch {} });

function handleConfig(obj) {
  const before = loadCfg();
  let rebuild = false;
  if (obj.authMode) {
    const m = ["apikey", "local"].includes(obj.authMode) ? obj.authMode : "subscription";
    // every settings Save re-sends the mode — an UNCHANGED mode must not rebuild
    // the agent (that silently wiped the whole conversation)
    if (m !== authMode) { authMode = m; saveCfg({ authMode: m }); rebuild = true; }
  }
  if (obj.apiKey) { saveCfg({ apiKey: obj.apiKey }); if (authMode === "apikey" && agent && agent.setKey) agent.setKey(obj.apiKey); }
  if (obj.model) { model = String(obj.model); if (authMode !== "local" && agent && agent.setModel) agent.setModel(model); saveCfg({ model }); }
  // local LLM (beta) settings — "__default__" clears a saved URL override back to
  // the provider default; rebuild only when a value actually changed
  if (obj.localBaseUrl === "__default__") obj.localBaseUrl = "";
  for (const k of ["localProvider", "localBaseUrl", "localModel", "localApiKey"]) {
    if (obj[k] !== undefined && String(obj[k]) !== String(before[k] != null ? before[k] : "")) {
      saveCfg({ [k]: String(obj[k]) });
      if (authMode === "local") rebuild = true;
    }
  }
  if (rebuild) {
    try { if (busy && agent && agent.stop) agent.stop(); } catch {} // never swap agents under a live run without killing it first
    agent = makeAgent(authMode);
  }
  if (obj.favPlugins !== undefined) {
    const list = Array.isArray(obj.favPlugins) ? obj.favPlugins.map((x) => String(x).trim()).filter(Boolean).slice(0, 24) : [];
    saveCfg({ favPlugins: list }); // injected into PROJECT STATE next turn
  }
  if (obj.effort !== undefined && ["quick", "standard", "meticulous"].includes(String(obj.effort))) {
    effort = String(obj.effort);
    saveCfg({ effort });
    if (agent && agent.setEffort) agent.setEffort(effort); else agent = makeAgent(authMode);
  }
  if (obj.oauthToken !== undefined) { saveCfg({ oauthToken: String(obj.oauthToken || "") }); } // device's own long-lived login (claude setup-token)
  if (obj.connectClaude) connectClaude(); // one-click browser sign-in
  if (obj.workMode !== undefined) { // where new material goes: scenes | timeline | auto
    const w = ["scenes", "timeline"].includes(String(obj.workMode)) ? String(obj.workMode) : "auto";
    saveCfg({ workMode: w });
    if (agent && agent.setWorkMode) agent.setWorkMode(w);
  }
  if (obj.passes !== undefined) { // listen/fix phase count: "auto" or 1..5
    const p = String(obj.passes) === "auto" ? null : Math.max(1, Math.min(5, parseInt(obj.passes, 10) || 0)) || null;
    saveCfg({ passes: p });
    if (agent && agent.setPasses) agent.setPasses(p);
  }
  if (obj.refreshSetup) { listMics(status); remoteClient.available().then((ok) => { loaderOk = ok; status(); }).catch(() => {}); }
  if (obj.autoScan !== undefined) { saveCfg({ autoScan: !!obj.autoScan }); startAutoScan(); }
  if (obj.micIndex !== undefined) { const v = loadCfg().voice || {}; v.micIndex = Number(obj.micIndex); saveCfg({ voice: v }); }
  status();
}

// --- jweb message handlers ---
Max.addHandler("chat", (...args) => handleChat(args.join(" ")));
Max.addHandler("set_auth", (m) => handleConfig({ authMode: String(m) }));
Max.addHandler("set_key", (k) => handleConfig({ apiKey: String(k) }));
Max.addHandler("set_model", (m) => handleConfig({ model: String(m) }));
Max.addHandler("set_local_provider", (p) => handleConfig({ localProvider: String(p) }));
Max.addHandler("set_local_url", (u) => handleConfig({ localBaseUrl: String(u) }));
Max.addHandler("set_local_model", (m) => handleConfig({ localModel: String(m) }));
Max.addHandler("set_local_apikey", (k) => handleConfig({ localApiKey: String(k) }));
Max.addHandler("set_fav_plugins", (...args) => { try { handleConfig({ favPlugins: JSON.parse(args.join(" ")) }); } catch {} });
Max.addHandler("set_effort", (e) => handleConfig({ effort: String(e) }));
Max.addHandler("set_passes", (p) => handleConfig({ passes: String(p) }));
Max.addHandler("set_workmode", (w) => handleConfig({ workMode: String(w) }));
Max.addHandler("set_oauth_token", (t) => handleConfig({ oauthToken: String(t) }));
Max.addHandler("oauth_connect", () => connectClaude());

// --- ONE-CLICK ACCOUNT CONNECT: runs `claude setup-token` under a pseudo-TTY,
// the CLI opens the user's browser, they click Authorize, and the token is
// captured from the PTY log and installed automatically. No Terminal needed.
let oauthProc = null;
function connectClaude() {
  if (oauthProc) { toUI({ type: "stage", text: "already connecting — finish the approval in your browser" }); return; }
  const { findClaudeBin, extractSetupToken } = require("./cliAgent");
  const bin = findClaudeBin();
  if (!bin) { toUI({ type: "error", message: "Claude Code CLI not found on this machine — install it first (https://claude.com/claude-code), then click Connect again. Or use an API key instead." }); return; }
  const log = path.join(os.tmpdir(), "copilot-oauth-" + Date.now() + ".log");
  toUI({ type: "stage", text: "🔑 your browser is opening — sign in / click Authorize; I'll capture the token automatically…" });
  try {
    oauthProc = spawn("/usr/bin/script", ["-q", log, "sh", "-c", "stty cols 500 rows 50 2>/dev/null; " + JSON.stringify(bin) + " setup-token"], { stdio: "ignore" });
  } catch (e) { oauthProc = null; toUI({ type: "error", message: "couldn't start the sign-in flow: " + e.message }); return; }
  const started = Date.now();
  const cleanup = () => { try { oauthProc && oauthProc.kill(); } catch {} oauthProc = null; try { fs.unlinkSync(log); } catch {} };
  const timer = setInterval(() => {
    let raw = "";
    try { raw = fs.readFileSync(log, "latin1"); } catch {}
    const tok = raw && extractSetupToken(raw);
    if (tok) {
      clearInterval(timer); cleanup();
      saveCfg({ oauthToken: tok, authMode: "subscription" });
      authMode = "subscription"; agent = makeAgent(authMode);
      toUI({ type: "stage", text: "✓ Claude account connected — this device now has its own 1-year login (immune to other apps corrupting it)." });
      status();
    } else if (Date.now() - started > 180000) { // 3 min to approve
      clearInterval(timer); cleanup();
      toUI({ type: "error", message: "sign-in timed out — click Connect again and approve the browser prompt within 3 minutes (or paste a token from `claude setup-token` manually)." });
    } else if (oauthProc && oauthProc.exitCode != null && Date.now() - started > 8000 && !raw.includes("at01")) {
      clearInterval(timer); cleanup();
      toUI({ type: "error", message: "the sign-in flow exited without a token — run `claude` once in Terminal to make sure the CLI works, then retry." });
    }
  }, 1000);
  if (timer.unref) timer.unref();
}
Max.addHandler("set_autoscan", (v) => handleConfig({ autoScan: !!Number(v) }));
Max.addHandler("set_mic", (v) => handleConfig({ micIndex: Number(v) }));
Max.addHandler("stop", stopRun);
Max.addHandler("get_status", status);
Max.addHandler("refresh_setup", () => { listMics(status); remoteClient.available().then((ok) => { loaderOk = ok; status(); }).catch(() => {}); });
Max.addHandler("popout", () => {
  // Open a BIG resizable window INSIDE Ableton (a floating Max window holding a jweb),
  // NOT the system browser. We hand Max the URL; the patch loads it into the pop-out
  // jweb (web transport → talks to this same agent over local HTTP/SSE) and opens it.
  const url = "http://127.0.0.1:" + web.port() + "/?transport=web";
  Max.outlet("openbig", url);
});
// fallback for anyone who still wants it in the real browser
Max.addHandler("popout_browser", () => {
  const url = "http://127.0.0.1:" + web.port() + "/";
  execFile("/usr/bin/open", [url], (e) => { Max.post(e ? "popout failed: " + e.message : "opened " + url); });
});

// --- voice input: record the mic with ffmpeg, transcribe LOCALLY with whisper (no key,
// offline). The browser Web Speech API doesn't exist in Ableton's jweb (CEF), so all of
// this happens in node. config under ~/.claude-copilot/config.json -> "voice": {...}. ---
const { spawn } = require("child_process");
const VOICE_WAV = path.join(os.tmpdir(), "copilot-voice.wav");
const VOICE_JSON = path.join(os.tmpdir(), "copilot-voice.json");
let recProc = null;
const vcfg = () => loadCfg().voice || {};
function findBin(key, name) {
  const c = vcfg()[key];
  if (c && fs.existsSync(c)) return c;
  for (const dir of ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"]) if (fs.existsSync(dir + name)) return dir + name;
  return name; // last resort: rely on PATH
}
let recErr = "";      // ffmpeg stderr tail — the REAL reason a capture failed
let recExited = false;
function voiceStart() {
  if (recProc) return;
  const ff = findBin("ffmpeg", "ffmpeg");
  if (!fs.existsSync(ff)) { toUI({ type: "error", message: "voice needs ffmpeg — run: brew install ffmpeg" }); return; }
  // input device: the user's choice from settings, else auto-pick a real microphone by
  // name from the system list (a blind index was wrong on many setups)
  let mic, micName = "";
  if (vcfg().micIndex != null) { mic = String(vcfg().micIndex); micName = (micCache.find((m) => m.index === Number(mic)) || {}).name || ""; }
  else {
    const byName = micCache.find((m) => /microphone|built-in|mic\b/i.test(m.name));
    const pick = byName || micCache[0];
    if (!pick) { toUI({ type: "error", message: "No input devices found — open ⚙ settings, hit ↻ refresh, and pick a microphone." }); return; }
    mic = String(pick.index); micName = pick.name;
  }
  try { fs.unlinkSync(VOICE_WAV); } catch {}
  try { fs.unlinkSync(VOICE_JSON); } catch {}
  recErr = ""; recExited = false;
  try {
    recProc = spawn(ff, ["-y", "-f", "avfoundation", "-i", ":" + mic, "-ar", "16000", "-ac", "1", VOICE_WAV], { stdio: ["pipe", "ignore", "pipe"] });
    recProc.stderr.on("data", (d) => { recErr = (recErr + d).slice(-2000); });
    recProc.on("error", (e) => { recProc = null; recExited = true; toUI({ type: "error", message: "mic capture failed to start: " + e.message }); toUI({ type: "voiceState" }); });
    recProc.on("close", () => { recExited = true; });
    toUI({ type: "voiceState", listening: true });
    toUI({ type: "stage", text: "🎤 recording from [" + mic + "] " + micName + "…" });
    Max.post("voice: recording (ffmpeg :" + mic + " " + micName + ")");
    // if ffmpeg dies within 1.5s the mic is blocked/wrong — tell the user IMMEDIATELY
    setTimeout(() => {
      if (recExited && recProc) { /* unreachable */ }
      if (recExited) {
        recProc = null;
        toUI({ type: "voiceState" });
        const perm = /not permitted|permission|cannot open|input\/output error/i.test(recErr);
        toUI({ type: "error", message: "mic capture died immediately" + (perm ? " — macOS blocked the microphone. System Settings ▸ Privacy & Security ▸ Microphone ▸ enable Ableton Live, then restart Live." : ": " + recErr.split("\n").filter(Boolean).slice(-2).join(" ")) });
      }
    }, 1500);
  } catch (e) { recProc = null; toUI({ type: "error", message: "mic capture failed: " + e.message }); }
}
function voiceStop() {
  const p = recProc; recProc = null;
  toUI({ type: "voiceState", listening: false });
  if (!p) return;
  let done = false;
  const finish = () => { if (done) return; done = true; transcribeVoice(); };
  if (recExited || p.exitCode !== null) { finish(); return; } // ffmpeg already dead — don't wait on a close that already fired
  p.on("close", finish);
  try { p.stdin.write("q"); } catch { try { p.kill("SIGINT"); } catch {} }
  setTimeout(() => { try { p.kill("SIGINT"); } catch {} }, 600);  // ensure ffmpeg flushes + exits
  setTimeout(finish, 2500);                                       // belt & suspenders: NEVER hang silently
}
function transcribeVoice() {
  let size = 0;
  try { size = fs.statSync(VOICE_WAV).size; } catch {}
  if (size < 1000) { // a real capture is ≥ tens of KB; <1KB = no audio reached the file
    const perm = /not permitted|permission|cannot open|input\/output error/i.test(recErr);
    toUI({ type: "voiceState" });
    toUI({ type: "error", message: "no audio was captured" + (perm ? " — macOS blocked the mic. System Settings ▸ Privacy & Security ▸ Microphone ▸ enable Ableton Live, then restart Live." : (recErr ? " — ffmpeg said: " + recErr.split("\n").filter(Boolean).slice(-2).join(" ") : " — check the mic picker in ⚙ settings.")) });
    return;
  }
  // SILENCE check: when macOS blocks an app's mic it delivers ZEROS, not an error —
  // the file grows normally but contains nothing. Detect that before blaming the user.
  let peak = 0;
  try {
    const w = require("../../core/spectral").parseWav(fs.readFileSync(VOICE_WAV));
    for (let i = 0; i < w.samples.length; i++) { const a = Math.abs(w.samples[i]); if (a > peak) peak = a; }
  } catch {}
  if (peak < 0.004) {
    toUI({ type: "voiceState" });
    toUI({ type: "error", message: "captured " + Math.round(size / 1024) + "KB but it is PURE SILENCE — macOS is giving Ableton a muted microphone. Fix: System Settings ▸ Privacy & Security ▸ Microphone ▸ turn ON Ableton Live. If Live isn't in the list, run this in Terminal:  tccutil reset Microphone com.ableton.live   then restart Live, click 🎤, and Allow the prompt." });
    return;
  }
  const wh = findBin("whisper", "whisper");
  if (!fs.existsSync(wh)) { toUI({ type: "voiceState" }); toUI({ type: "error", message: "captured " + Math.round(size / 1024) + "KB but whisper isn't installed — run: brew install openai-whisper" }); return; }
  // KEEP the recording as a file (not just the transcription): the user can say
  // "make this into a beat" and then beatbox/hum — audio_to_midi reads this wav.
  let audioPath = null;
  try {
    const VOICE_DIR = path.join(CFG_DIR, "uploads");
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    audioPath = path.join(VOICE_DIR, "voice-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".wav");
    fs.copyFileSync(VOICE_WAV, audioPath);
  } catch (e) { audioPath = null; }
  const mdl = vcfg().model || "base.en";
  toUI({ type: "voiceState", transcribing: true });
  toUI({ type: "stage", text: "📝 transcribing " + Math.round(size / 1024) + "KB… (first run downloads the model — can take a minute)" });
  execFile(wh, [VOICE_WAV, "--model", mdl, "--language", "en", "--fp16", "False", "--output_format", "json", "--output_dir", os.tmpdir()], { timeout: 240000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) => {
    toUI({ type: "voiceState" });
    if (err) { toUI({ type: "error", message: "transcription failed: " + String((se || err.message)).split("\n").filter(Boolean).slice(-2).join(" ") }); return; }
    let text = "";
    try { text = (JSON.parse(fs.readFileSync(VOICE_JSON, "utf8")).text || "").trim(); } catch (e) {}
    if (text) toUI({ type: "transcript", text, audioPath });
    // no words but real audio = probably beatboxing/humming — hand it to the agent anyway
    else if (audioPath) toUI({ type: "transcript", text: "(no clear words — likely beatboxing or humming)", audioPath });
    else toUI({ type: "error", message: "transcription produced no text — speak closer to the mic and try again" });
  });
}
Max.addHandler("voice_start", voiceStart);
Max.addHandler("voice_stop", voiceStop);

Max.post("Claude Copilot started — auth " + authMode + ", model " + model + ", web http://127.0.0.1:" + web.port() + ", agent " + (agent ? "ok" : "FAILED"));
status();
startAutoScan(); // begin watching for the user's project changes (toggle in settings)
listMics(status); // enumerate input devices for the voice picker
remoteClient.available().then((ok) => { loaderOk = ok; status(); }).catch(() => {}); // setup-guide loader check
