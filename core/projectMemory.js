// projectMemory.js — the agent's persistent working memory of a Live project: the
// creative DIRECTION + per-track notes (role, sound character, key params it set) +
// a short decision LOG. Lives in ~/.claude-copilot/memory/<projectKey>.json.
//
// Two jobs:
//   1) persist qualitative notes Live can't tell you ("this is the thick drop bass")
//   2) build a COMPACT, token-budgeted "PROJECT STATE" block = fresh live snapshot
//      (remoteClient.tracks()) MERGED with the saved notes, injected every turn so the
//      agent is ALWAYS aware of the set + direction without re-querying.
//
// Live state is AUTHORITATIVE for what tracks/devices exist; memory is authoritative
// for INTENT. Every build reconciles the two and drops notes for tracks that vanished.
const fs = require("fs");
const os = require("os");
const path = require("path");
const remoteClient = require("./remoteClient");

const DIR = path.join(os.homedir(), ".claude-copilot", "memory");
const CFG_FILE = path.join(os.homedir(), ".claude-copilot", "config.json");
const MAX_LOG = 14;             // keep only the last N decisions
const MAX_STATE_CHARS = 3200;  // hard cap on the injected block (~800 tokens)

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} }
function safeKey(k) { return String(k || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120); }
function fileFor(key) { return path.join(DIR, safeKey(key) + ".json"); }

function blank() {
  return { version: 1, projectKey: null, direction: {}, tracks: {}, log: [], snapshot: null, changes: [], updated: 0 };
}
// PERSISTENCE: memory NEVER auto-resets — not on a new session, not when the user
// opens a different project. Every project (saved sets by path, unsaved sets by
// track-name fingerprint) keeps its own diary on disk and gets it back when that
// project is opened again; reconcile() prunes notes for tracks that no longer
// exist, and forget_project is the only deliberate wipe.
function load(key) {
  ensureDir();
  try {
    return { ...blank(), ...JSON.parse(fs.readFileSync(fileFor(key), "utf8")), projectKey: key };
  } catch { return { ...blank(), projectKey: key }; }
}
// wipe this project's memory entirely (user said "fresh start" / direction changed hard)
async function forget() {
  const key = await projectKey();
  const mem = blank();
  mem.projectKey = key;
  save(mem);
  return { ok: true, projectKey: key };
}
function save(mem) {
  ensureDir();
  mem.updated = Date.now();
  try { fs.writeFileSync(fileFor(mem.projectKey), JSON.stringify(mem, null, 2), { mode: 0o600 }); } catch {}
  return mem;
}

// ---- project key: saved-set path → track-name fingerprint → rolling default ----
let _cachedKey = null, _keyAt = 0;
async function projectKey() {
  // re-derive every 30s: a session-long cache made switching Live sets reconcile (and
  // delete) the PREVIOUS project's notes against the new set's tracks
  if (_cachedKey && Date.now() - _keyAt < 30000) return _cachedKey;
  _keyAt = Date.now();
  _cachedKey = null;
  try {
    const r = await remoteClient.lomGet(["song"], "file_path");
    if (r && r.ok && r.value) { _cachedKey = "set:" + basenameNoExt(r.value); return _cachedKey; }
  } catch {}
  try {
    const t = await remoteClient.tracks();
    if (t && t.ok && t.tracks && t.tracks.length) {
      // fingerprint = track names + clip names: two different unsaved jams that both
      // use Live's default track names must NOT share a memory (that's how a "new
      // session" used to silently inherit the previous jam's key + direction)
      const sig = t.tracks
        .map((x) => String(x.name).toLowerCase().trim() + ":" + ((x.clips || []).map((c) => String(c.name || "").toLowerCase().trim()).join(",")))
        .join("|");
      _cachedKey = "fp:" + hash(sig);
      return _cachedKey;
    }
  } catch {}
  _cachedKey = "default";
  return _cachedKey;
}
function resetKey() { _cachedKey = null; }

// ---- NEW-SESSION awareness: main.js detects a (re)start of Live/the device and
// hands us a one-line note; every PROJECT STATE leads with it so the agent KNOWS
// "this is a fresh sitting" instead of acting like the old conversation continued.
let _sessionNote = "";
function setSessionNote(note) { _sessionNote = String(note || ""); }
function basenameNoExt(p) { return String(p).split(/[\\/]/).pop().replace(/\.als$/i, ""); }
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

// ---- writes (the remember() tool + lifecycle auto-writes) ----
function prune(o) { const out = {}; for (const k of ["genre", "reference", "tempo", "key", "mode", "palette"]) if (o[k] != null) out[k] = o[k]; return out; }
async function remember(patch = {}) {
  const key = await projectKey();
  const mem = load(key);
  if (patch.direction && typeof patch.direction === "object") mem.direction = { ...mem.direction, ...prune(patch.direction) };
  if (patch.track != null) {
    const name = String(patch.track);
    const cur = mem.tracks[name] || {};
    mem.tracks[name] = {
      ...cur,
      ...(patch.role ? { role: String(patch.role) } : {}),
      ...(patch.sound ? { sound: String(patch.sound).slice(0, 160) } : {}),
      ...(patch.params ? { params: { ...(cur.params || {}), ...patch.params } } : {}),
      updated: Date.now(),
    };
  }
  if (patch.note) { mem.log.push({ t: Date.now(), text: String(patch.note).slice(0, 160) }); mem.log = mem.log.slice(-MAX_LOG); }
  save(mem);
  return { ok: true, projectKey: key };
}

// ---- reconcile saved notes against the live track list (keyed by NAME) ----
function reconcile(mem, liveTracks) {
  const liveNames = new Set((liveTracks || []).map((t) => String(t.name)));
  let dropped = 0;
  for (const name of Object.keys(mem.tracks)) if (!liveNames.has(name)) { delete mem.tracks[name]; dropped++; }
  return dropped;
}

// ---- AUTO-SCAN: detect what the USER changed (not the agent) by diffing a stored
// snapshot against the live set, reconcile the diary, and log the changes. ----
function snapshotOf(live) {
  return (live || []).map((t) => ({ index: t.index, name: String(t.name), devices: (t.devices || []).map(String) }));
}
function diffSnapshots(prev, cur) {
  const diffs = [], renames = [];
  const prevByIdx = {}; prev.forEach((t) => (prevByIdx[t.index] = t));
  const curByIdx = {}; cur.forEach((t) => (curByIdx[t.index] = t));
  const prevNames = new Set(prev.map((t) => t.name)), curNames = new Set(cur.map((t) => t.name));
  for (const t of cur) {
    const p = prevByIdx[t.index];
    if (!p) { if (!prevNames.has(t.name)) diffs.push({ text: `added track "${t.name}"` }); continue; }
    if (p.name !== t.name && !curNames.has(p.name)) { diffs.push({ text: `renamed "${p.name}" → "${t.name}"` }); renames.push([p.name, t.name]); }
    const nm = t.name;
    const added = t.devices.filter((d) => !p.devices.includes(d));
    const removed = p.devices.filter((d) => !t.devices.includes(d));
    if (added.length) diffs.push({ text: `added ${added.join(", ")} to "${nm}"` });
    if (removed.length) diffs.push({ text: `removed ${removed.join(", ")} from "${nm}"` });
  }
  for (const p of prev) if (!curByIdx[p.index] && !curNames.has(p.name)) diffs.push({ text: `removed track "${p.name}"` });
  return { diffs, renames };
}
// scan once: snapshot → diff → reconcile the diary → log the user's changes. Cheap (one
// remoteClient.tracks() call). Returns {ok, diffs:[text]}.
async function scan() {
  const key = await projectKey();
  const mem = load(key);
  let live = null;
  try { const r = await remoteClient.tracks(); if (r && r.ok) live = r.tracks; } catch {}
  if (!live) return { ok: false, diffs: [] };
  const cur = snapshotOf(live);
  let result = { diffs: [], renames: [] };
  if (mem.snapshot) result = diffSnapshots(mem.snapshot, cur);
  // migrate diary notes for renamed tracks, then drop notes for vanished tracks
  for (const [from, to] of result.renames) if (mem.tracks[from]) { mem.tracks[to] = { ...mem.tracks[from], ...(mem.tracks[to] || {}) }; delete mem.tracks[from]; }
  reconcile(mem, live);
  if (result.diffs.length) { for (const d of result.diffs) mem.changes.push({ t: Date.now(), text: d.text }); mem.changes = mem.changes.slice(-10); }
  mem.snapshot = cur;
  save(mem);
  return { ok: true, diffs: result.diffs.map((d) => d.text) };
}

// ---- real-time change EVENTS from the Live listeners -> readable awareness lines ----
function eventText(e) {
  switch (e.kind) {
    case "key": return "song KEY changed to " + e.key + " — make sure ALL parts (existing + new) fit this key";
    case "tempo": return "tempo changed to " + e.value + " bpm";
    case "timesig": return "time signature changed";
    case "tracks": return "tracks were added/removed — re-orient before acting";
    case "devices": return 'devices changed on "' + (e.name || ("track " + e.track)) + '"';
    case "rename": return "a track was renamed";
    case "clip": return (e.has ? "a clip was added on" : "a clip was removed from") + " track " + e.track + " slot " + e.slot;
    case "notes": return "the NOTES were edited in track " + e.track + " slot " + e.slot + " — re-read that clip before building on it";
    default: return e.kind;
  }
}
async function applyEvents(events) {
  if (!events || !events.length) return [];
  const key = await projectKey();
  const mem = load(key);
  const texts = events.map(eventText);
  for (const t of texts) mem.changes.push({ t: Date.now(), text: t });
  mem.changes = mem.changes.slice(-10);
  save(mem);
  return texts;
}

// ---- build the COMPACT PROJECT STATE block (the always-aware part) ----
async function buildState() {
  const key = await projectKey();
  // drain real-time listener events FIRST (precise triggers), then reconcile structurally
  try { const p = await remoteClient.pollChanges(); if (p && p.ok && p.events && p.events.length) await applyEvents(p.events); } catch {}
  try { await scan(); } catch {}
  const mem = load(key);
  let live = null, sess = null;
  try { const r = await remoteClient.tracks(); if (r && r.ok) live = r.tracks; } catch {}
  try { const s = await remoteClient.session(); if (s && s.ok) sess = s; } catch {}
  // the key the agent sees must be the DETECTED one (from the clips), not Live's
  // scale-chooser setting — that's what made it write in the wrong key
  try {
    const songKey = require("./songKey");
    const sk = await songKey.detect();
    if (sess && sk) { sess.liveScaleSetting = sess.key; sess.key = sk.key + (sk.source === "clips" ? "" : " (Live setting — unverified)"); }
  } catch {}
  if (!live) return { text: renderMemoryOnly(mem), mem, key };
  const changes = (mem.changes || []).slice(-8).map((c) => c.text);
  const text = cap(render(mem, live, changes, sess));
  if (mem.changes && mem.changes.length) { mem.changes = []; save(mem); } // surfaced once → clear
  return { text, mem, key };
}
function render(mem, live, changes, sess) {
  const d = mem.direction || {};
  const dir = [
    d.genre && `genre ${d.genre}`, d.reference && `ref ${d.reference}`, d.tempo && `${d.tempo}bpm`,
    d.key && `${d.key}${d.mode ? " " + d.mode : ""}`, d.palette && `palette: ${d.palette}`,
  ].filter(Boolean).join(" · ");
  const rows = live.map((t) => {
    const note = mem.tracks[String(t.name)] || {};
    // the FULL device chain in signal order (the agent must know every plugin on the
    // track before touching it) — the meter is shown as the 🎧 flag, not in the chain
    const chain = (t.devices || []).filter((d) => !/claude\s*meter/i.test(String(d)));
    const inst = chain.length ? chain.slice(0, 6).join("→") + (chain.length > 6 ? "→…" : "") : (t.type === "midi" ? "empty" : "audio");
    const role = note.role ? ` [${note.role}]` : "";
    const sound = note.sound ? ` — ${note.sound}` : "";
    const params = note.params && Object.keys(note.params).length
      ? ` {${Object.entries(note.params).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(",")}}` : "";
    // what ALREADY exists on the track — clips (build on them, don't overwrite) + meter.
    // Capped: one clip-hoarding track must not blow the state budget and push every
    // later track out of the injected block.
    const clips = (t.clips && t.clips.length)
      ? ` · CLIPS: ${t.clips.slice(0, 4).map((c) => `slot${c.slot}"${String(c.name).slice(0, 24)}"${c.bars ? `(${c.bars}bar)` : ""}`).join(", ")}${t.clips.length > 4 ? ` +${t.clips.length - 4} more` : ""}` : "";
    const meter = t.hasMeter ? " ·🎧meter" : "";
    return `#${t.index} ${t.name}${role} (${inst})${sound}${params}${clips}${meter}`;
  });
  const logLines = (mem.log || []).slice(-6).map((l) => "- " + l.text);
  const changeLines = (changes || []).map((c) => "- " + c);
  const liveNow = sess
    ? "LIVE NOW: " + (sess.tempo != null ? sess.tempo + " bpm" : "") + (sess.key && sess.key !== "?" ? " · key " + sess.key : "") +
      " · " + (sess.isPlaying ? "PLAYING" : "stopped") + " · " + (sess.trackCount != null ? sess.trackCount + " tracks" : "")
    : "";
  // user-approved VST/AU plugins from settings — the agent may load + use these
  let favLine = "";
  try {
    const fav = (JSON.parse(fs.readFileSync(CFG_FILE, "utf8")).favPlugins || []).filter(Boolean);
    if (fav.length) favLine = ("FAVORITE PLUGINS (user-approved VST/AU — prefer these for mixing/mastering; knobs appear only after the user CONFIGURES them in Live): " + fav.join(", ")).slice(0, 400);
  } catch {}
  // the user's OWN skill files (⚙ → Skills) — names only; custom_skill reads them
  let skillLine = "";
  try {
    const names = require("./customSkills").list().map((s) => s.name);
    if (names.length) skillLine = ("USER SKILLS (their own rules — read with custom_skill when referenced by name or topically relevant; they OUTRANK built-ins): " + names.join(", ")).slice(0, 400);
  } catch {}
  return [
    "## PROJECT STATE (live snapshot + your saved memory — you are ALREADY aware of this; don't re-query unless you're about to act on specifics)",
    _sessionNote ? "SESSION: " + _sessionNote : "",
    liveNow,
    dir ? "DIRECTION: " + dir : "DIRECTION: (not set — commit to one and call remember{direction})",
    favLine,
    skillLine,
    changeLines.length ? "⚠ THE USER CHANGED THE PROJECT since you last looked (account for these — they may not match your notes):" : "",
    ...changeLines,
    "TRACKS:", ...rows,
    logLines.length ? "RECENT DECISIONS:" : "", ...logLines,
  ].filter(Boolean).join("\n");
}
function renderMemoryOnly(mem) {
  const d = mem.direction || {};
  const dir = Object.entries(d).map(([k, v]) => `${k} ${v}`).join(" · ");
  return [
    "## PROJECT STATE (memory only — live read unavailable)",
    dir ? "DIRECTION: " + dir : "DIRECTION: (not set)",
    ...Object.entries(mem.tracks).map(([n, v]) => `~ ${n}${v.role ? " [" + v.role + "]" : ""}${v.sound ? " — " + v.sound : ""}`),
  ].join("\n");
}
function cap(text) {
  if (text.length <= MAX_STATE_CHARS) return text;
  const lines = text.split("\n");
  const kept = []; let len = 0;
  for (const ln of lines) {
    if (len + ln.length > MAX_STATE_CHARS && kept.length > 3) { kept.push("… (truncated)"); break; }
    kept.push(ln); len += ln.length + 1;
  }
  return kept.join("\n");
}

module.exports = { projectKey, resetKey, setSessionNote, load, save, remember, forget, buildState, scan, applyEvents, MAX_STATE_CHARS };
