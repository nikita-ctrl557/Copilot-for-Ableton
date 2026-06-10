// pluginSkills.js — knowledge about THIRD-PARTY plug-ins (VST/AU), the layer the
// sound-design engine was missing: deviceSkills covers stock Ableton devices, but a
// Pro-L 2 or Buster SE exposes opaque configured-param names the agent kept
// guessing at. Two sources, merged:
//   1) SEEDED docs for the user's known suites (FabFilter, Ozone, Analog Obsession)
//   2) LEARNED docs the agent saves after researching an unknown plug-in
//      (web_search → plugin_skill save) → ~/.claude-copilot/plugin-skills.json —
//      learn once, know forever.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = path.join(os.homedir(), ".claude-copilot", "plugin-skills.json");

// keep seeds compact: what each key control DOES + one concrete recipe per main use
const SEEDS = {
  "pro-q": {
    name: "FabFilter Pro-Q (3/4)", kind: "EQ",
    params: "Per band: Frequency (Hz), Gain (dB), Q (width — higher = narrower), Shape (Bell/Low Shelf/High Shelf/Low Cut/High Cut/Notch/Tilt/Flat Tilt — Pro-Q 4 adds per-band Dynamic Threshold/Range for dynamic EQ), Slope for cuts (6–96 dB/oct), Stereo placement (L/R/Mid/Side). Global: Output Gain, Output Pan, Auto Gain, Analyzer.",
    recipes: {
      "surgical cut": "Bell, Q 6–10, gain -3…-8dB at the measured resonance",
      "mud cleanup": "Bell, 200–400Hz, Q 1–2, -2…-4dB",
      "high-pass non-bass": "Low Cut 24dB/oct at 80–120Hz",
      "air": "High Shelf 10–12kHz +1.5…+3dB, Q ~0.7",
      "de-harsh (dynamic)": "Pro-Q 4: Bell 3–6kHz, Dynamic Range -3…-6dB so it only ducks when harshness happens",
      "master tilt": "Tilt shape ±1…1.5dB pivoting ~700Hz for darker/brighter overall",
    },
    note: "Configure at least: per-band Freq/Gain/Q + shape selectors. Band params usually appear as 'Band N Frequency/Gain/Q/Shape/Used'.",
  },
  "pro-l": {
    name: "FabFilter Pro-L 2", kind: "limiter (mastering)",
    params: "Gain (input drive INTO limiting — this creates the loudness), Output Level (the ceiling, set -0.3dB; with True Peak on it's dBTP), Attack & Release (transient handling), Lookahead, Style (Modern = clean/all-round, Aggressive = punchy EDM, Bus, Safe, Transparent, Dynamic), Channel Link, Oversampling (4x for masters), True Peak Limiting on, Unity Gain (audition without loudness change), Loudness metering (LUFS).",
    recipes: {
      "streaming master": "Style Modern, Output -0.3dBTP (True Peak on, 4x oversampling), raise Gain until 1–3dB reduction on loud peaks, target ≈ -14 LUFS integrated",
      "club master": "Style Aggressive or Modern, Output -0.3, Gain for 3–6dB GR, watch low-end pumping — slower Release if it pumps",
      "transparent catch": "Style Transparent/Safe, 0.5–1dB GR, just safety limiting",
    },
    note: "The loudness move is the GAIN knob, not Output. Check GR meter via the measured master level before/after.",
  },
  "buster": {
    name: "Analog Obsession BUSTER SE", kind: "SSL-style bus compressor (glue)",
    params: "Ratio (2/4/10 — 2:1 for glue), Attack (ms — slower lets transients punch through; 10–30ms typical), Release (incl. Auto — Auto breathes with the program), Threshold/Compress (drive into compression), Makeup/Output gain, Mix (parallel blend), HPF on the sidechain if present (keeps bass from pumping it).",
    recipes: {
      "mix-bus glue": "Ratio 2:1, Attack 10–30ms, Release Auto, threshold until 1–2dB GR on the loud sections, makeup to match, Mix 100%",
      "drum bus punch": "Ratio 4:1, Attack 30ms (transients pass), Release fast/Auto, 2–4dB GR, blend Mix ~60–80% for parallel punch",
      "pumping (intentional)": "Ratio 4:1, fast Attack, Release timed to the kick gap, deeper GR",
    },
    note: "Glue compressor — it goes BEFORE the limiter on the master, never after.",
  },
  "pro-c": {
    name: "FabFilter Pro-C 2", kind: "compressor",
    params: "Threshold, Ratio, Attack, Release (+Auto Release), Style (Clean/Classic/Opto/Vocal/Mastering/Bus/Punch/Pumping), Knee, Range, Lookahead, Wet/Dry (parallel), Sidechain with EQ + external input, Auto Gain.",
    recipes: {
      "vocal ride": "Style Vocal or Opto, 3–6dB GR, medium attack, Auto Release, Auto Gain off + manual makeup",
      "sidechain duck to kick": "external sidechain from the kick, Style Punch/Pumping, fast attack, release timed to the gap, 2–5dB GR",
      "bus glue": "Style Bus/Mastering, 2:1, slow attack, 1–2dB GR",
    },
  },
  "saturn": {
    name: "FabFilter Saturn 2", kind: "saturation / multiband distortion",
    params: "Drive (per band), Mix (per band), Style (Subtle/Warm Tape/Tube/Amp/Smudge/Rectify…), Tone controls (per band), multiband split, modulation matrix.",
    recipes: {
      "warm bass harmonics": "single band, Warm Tape or Subtle Tube, Drive 3–6dB, Mix 50–100% — makes bass audible on small speakers",
      "master colour": "Subtle saturation, Drive low, Mix 10–25%",
    },
  },
  "ozone maximizer": {
    name: "iZotope Ozone Maximizer", kind: "limiter (mastering)",
    params: "Threshold (drive into limiting), Ceiling (set -0.3dBTP, True Peak on), IRC mode (IRC IV Modern = transparent loud), Character (speed), Stereo Independence, Transient Emphasis.",
    recipes: { "streaming master": "IRC IV, Ceiling -0.3, Threshold down until 1–3dB GR, ≈ -14 LUFS", "club": "Threshold for 3–6dB GR, watch pumping via Character slower" },
  },
  "ozone eq": {
    name: "iZotope Ozone Equalizer", kind: "EQ (mastering)",
    params: "Per band: Frequency/Gain/Q/Shape (analog/digital modes, Baxandall shelves are great for broad master moves), Mid/Side mode.",
    recipes: { "master low-end control": "Baxandall low shelf ±1–2dB; Side high-pass ~120Hz keeps lows mono" },
  },
  diva: {
    name: "u-he Diva", kind: "analog-modelled synth (VA)",
    params: "OSC section (model select: Triple VCO/Dual VCO…; per-osc Tune (semis) + fine, waveform select/blend, osc Volume mix), Filter (ladder/cascade models, Cutoff, Resonance, key follow), Env 1 (amp ADSR) / Env 2 (mod ADSR), 2 LFOs (Rate sync'd or Hz, waveform, Depth, assignable in the mod slots: LFO→osc Tune/Cutoff/etc.), Glide, Voice mode + Voice Detune ('analog' spread), Quality (use 'great' not 'divine' while tracking — CPU).",
    recipes: {
      "drifting analog twin-saw (the dotted-8ths pad/lead)": "Dual/Triple VCO, BOTH oscs = saw, same Tune, mix 50/50; LFO 1 → Osc 2 Tune, TRIANGLE, rate ~0.05–0.1 Hz (unsynced), depth tiny (±3–8 cents) so osc 2 slowly drifts up then down against osc 1 — the beating IS the analog drift; add Voice Detune ~10–20% for more instability; amp env: medium attack (~50ms), long release; THEN in Live: Delay synced to DOTTED 8THS (feedback 35–50%, dry/wet ~25%) + a BIG reverb send (decay 4–8s, dry/wet send generous) — the user's 'lots of reverb' analog drift sound",
      "fat analog bass": "Triple VCO, saw+saw+sub-ish square, slight detune, ladder filter cutoff low-mid with env 2 → cutoff for the bite, mono + glide",
    },
    note: "It's a VST — the user must Configure the knobs (osc tunes, cutoff, LFO rate/depth) before Claude can turn them; relay the Configure steps once.",
  },
  kickstart: {
    name: "Nicky Romero Kickstart (1/2)", kind: "one-knob sidechain pump",
    params: "MIX (the pump depth — the one knob), curve/slope selector (duck shape), Rate (1/4, 1/2, 1 bar; v2 adds custom curves, MIDI trigger and routing).",
    recipes: {
      "bumpy/pumping track": "on the bass + pads (never the kick): Rate 1/4, Mix 50–80% — the instant EDM/house pump",
      "subtle glue duck": "Mix 20–40%, default curve — felt, not heard",
    },
    note: "PREFERRED pump method when installed — perfectly timed curves with zero routing. It's a VST: if no knobs are exposed, the user runs Configure once, then MIX is settable.",
  },
  "pro-mb": {
    name: "FabFilter Pro-MB", kind: "multiband dynamics (compress/expand per band)",
    params: "Per band: range, threshold, attack/release, ratio, mode Compress OR Expand (upward), per-band SIDECHAIN with key filtering (trigger the band from a chosen frequency range, internal or external), Output, lookahead, oversampling.",
    recipes: {
      "low-triggered high lift (master sparkle)": "band ≈7k–20k, mode EXPAND (upward), Range 2–6dB, fast-ish attack / musical release, band sidechain key-filtered to ≈100–500Hz → every kick/bass hit momentarily lifts the air. Keep it subtle (2–3dB) on a master",
      "de-boom": "low band 80–200Hz, Compress 1–3dB only when the section gets thick",
      "stock fallback": "Ableton Multiband Dynamics: high band 'Above' ratio below 1:1 = upward expansion (program-triggered approximation of the keyed version)",
    },
  },
  "ozone imager": {
    name: "iZotope Ozone Imager", kind: "stereo width (per band)",
    params: "Per-band Width sliders (narrow…wide), band crossovers, Stereoize (synthesized width — use sparingly), vectorscope.",
    recipes: {
      "master sparkle width": "widen ONLY the top band (≈7–10kHz+) +20–30%; lows band to 0 width (mono) below ~120Hz — wider air, solid center",
    },
  },
};

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function loadLearned() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}
function saveLearned(all) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch {}
}

// fuzzy lookup across learned docs first (user-specific beats generic), then seeds.
// Matching is WHOLE-WORD per key token — "FF Pro-L 2" must hit Pro-L and never
// Pro-Q (a loose substring match on "pro" once sent limiter recipes to an EQ).
function get(pluginName) {
  const q = norm(pluginName);
  if (!q) return null;
  const qWords = q.split(" ").filter(Boolean);
  const learned = loadLearned();
  for (const [k, v] of Object.entries(learned)) {
    const nk = norm(k);
    if (q.includes(nk) || nk.includes(q)) return { ...v, plugin: k, source: v.source || "learned" };
  }
  // every token of the seed key must appear as a word in the query (prefix-tolerant
  // for long tokens: "busterse" hits key "buster"; short tokens like "l" need exact)
  const wordHit = (t) => qWords.some((w) => w === t || (t.length >= 4 && w.startsWith(t)) || (w.length >= 4 && t.startsWith(w)));
  for (const [k, v] of Object.entries(SEEDS)) {
    const tokens = k.split(/[\s-]+/).filter(Boolean);
    if (tokens.every(wordHit)) return { ...v, plugin: v.name, source: "seeded" };
  }
  // fallback: ≥2 distinctive words shared with the seed's full display name
  for (const v of Object.values(SEEDS)) {
    const nameWords = norm(v.name).split(" ");
    const hits = qWords.filter((w) => w.length > 2 && nameWords.includes(w));
    if (hits.length >= 2) return { ...v, plugin: v.name, source: "seeded" };
  }
  return null;
}

function learn(pluginName, doc) {
  const all = loadLearned();
  const cur = all[pluginName] || {};
  all[pluginName] = {
    ...cur,
    ...(doc.kind ? { kind: String(doc.kind) } : {}),
    ...(doc.params ? { params: String(doc.params).slice(0, 1200) } : {}),
    ...(doc.recipes ? { recipes: { ...(cur.recipes || {}), ...doc.recipes } } : {}),
    ...(doc.note ? { note: String(doc.note).slice(0, 400) } : {}),
    source: "researched",
    updated: Date.now(),
  };
  saveLearned(all);
  return all[pluginName];
}

function listKnown() {
  return { seeded: Object.values(SEEDS).map((s) => s.name), learned: Object.keys(loadLearned()) };
}

module.exports = { get, learn, listKnown };
