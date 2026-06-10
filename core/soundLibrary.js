// soundLibrary.js — the agent's SELF-GROWING sound-design library: recipes it
// researched online (or worked out by ear) get SAVED here and are known forever
// on this machine. Instructions found for OTHER synths (Serum, Vital, Massive…)
// are stored already TRANSLATED into stock-Ableton terms (Wavetable/Operator/
// Drift params + the mod matrix), so next time the sound is one lookup away.
// deviceSkills = static seeded knowledge; THIS is the learned layer on top.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = path.join(os.homedir(), ".claude-copilot", "sound-recipes.json");

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function loadAll() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}
function saveAll(all) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch {}
}

// fuzzy get: exact key, then containment both ways, then word overlap
function get(name) {
  const q = norm(name);
  if (!q) return null;
  const all = loadAll();
  for (const [k, v] of Object.entries(all)) {
    const nk = norm(k);
    if (nk === q || nk.includes(q) || q.includes(nk)) return { name: k, ...v };
  }
  const qWords = q.split(" ").filter((w) => w.length > 2);
  let best = null, bestHits = 0;
  for (const [k, v] of Object.entries(all)) {
    const kw = norm(k).split(" ");
    const hits = qWords.filter((w) => kw.includes(w)).length;
    if (hits >= 2 && hits > bestHits) { best = { name: k, ...v }; bestHits = hits; }
  }
  return best;
}

// doc: { character?, genre?, sourceSynth?, steps (string|string[]), modulation?, source? }
function learn(name, doc) {
  if (!name || !doc) return null;
  const all = loadAll();
  const cur = all[name] || {};
  all[name] = {
    ...cur,
    ...(doc.character ? { character: String(doc.character).slice(0, 200) } : {}),
    ...(doc.genre ? { genre: String(doc.genre).slice(0, 80) } : {}),
    ...(doc.sourceSynth ? { sourceSynth: String(doc.sourceSynth).slice(0, 80) } : {}),
    ...(doc.steps ? { steps: Array.isArray(doc.steps) ? doc.steps.map(String).slice(0, 24) : [String(doc.steps)] } : {}),
    ...(doc.modulation ? { modulation: String(doc.modulation).slice(0, 400) } : {}),
    ...(doc.source ? { source: String(doc.source).slice(0, 200) } : {}),
    updated: Date.now(),
  };
  saveAll(all);
  return { name, ...all[name] };
}

function list() { return Object.keys(loadAll()); }

module.exports = { get, learn, list };
