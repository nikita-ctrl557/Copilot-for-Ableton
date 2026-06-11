// tools.js — the catalog of tools Claude can call + dispatch to Ableton.
// Musical intelligence (chords/melodies) and mixing helpers (EQ/comp param
// matching) run here in Node; the in-Live v8 executor stays tiny. `live.call(kind,
// args)` performs one round-trip into the device's LiveAPI executor.

const chords = require("./chords");
const keymod = require("./key");
const groove = require("./groove");
const drums = require("./drums");
const melody = require("./melody");
const meterStore = require("./meterStore");
const deviceSkills = require("./deviceSkills");
const elementSkills = require("./elementSkills");
const pluginSkills = require("./pluginSkills");
const genreSkills = require("./genreSkills");
const soundLibrary = require("./soundLibrary");
const customSkills = require("./customSkills");
const songKey = require("./songKey");
const audioToMidi = require("./audioToMidi");
const remoteClient = require("./remoteClient");
const projectMemory = require("./projectMemory");
const spectral = require("./spectral");
const activityLog = require("./activityLog");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execFileP = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 120000 }, (e, so, se) => (e ? reject(new Error(String(se || e.message))) : resolve(String(so)))));
const RECORD_BASE = path.join(os.homedir(), ".claude-copilot", "recordings");
let lastRecording = null; // { dir, files:[{track,name,file}], bars, tempo, sigNum } from record_tracks

// decode an audio file to raw samples: WAV directly, anything else through macOS
// afconvert (handles aiff — sfrecord~'s habit — plus mp3/m4a/flac)
async function decodeAudioPath(file) {
  const buf = fs.readFileSync(file);
  try { return spectral.parseWav(buf); }
  catch (e) {
    const tmp = path.join(os.tmpdir(), "copilot-conv-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".wav");
    try {
      await execFileP("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16", file, tmp]);
      return spectral.parseWav(fs.readFileSync(tmp));
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
}
async function analyzeAudioPath(file, opts) {
  const { samples, sampleRate } = await decodeAudioPath(file);
  return spectral.analyze(samples, sampleRate, { fftSize: 4096, ...(opts || {}) });
}
// one bar in seconds: tempo is quarter-note BPM; a bar is sigNum beats of 4/sigDenom
// quarters each (6/8 at 120 = 3s, not 6s)
function barSeconds(tempo, sigNum, sigDenom) {
  return (60 / (tempo || 120)) * (sigNum || 4) * (4 / (sigDenom || 4));
}
// seconds → "bars 9–16, 33–48" given tempo/signature
function rangesToBars(ranges, tempo, sigNum, sigDenom) {
  if (!ranges || !ranges.length) return "(silent throughout)";
  const barSec = barSeconds(tempo, sigNum, sigDenom);
  const bar = (s) => Math.floor(s / barSec) + 1;
  const endBar = (s) => Math.max(1, Math.ceil(s / barSec)); // toSec is end-EXCLUSIVE — don't spill into the next bar
  return ranges.map((r) => (bar(r.fromSec) === endBar(r.toSec) ? "bar " + bar(r.fromSec) : "bars " + bar(r.fromSec) + "–" + endBar(r.toSec))).join(", ");
}
// recording filenames encode the track: "NN-Name" / "return-A" / "master" — parse it
// back so disk-fallback analysis keeps track identity
function trackFromRecordingName(name) {
  const s = String(name);
  if (/^master$/i.test(s)) return -1;
  const r = s.match(/^return-([A-Z])/i);
  if (r) return -2 - (r[1].toUpperCase().charCodeAt(0) - 65);
  const n = s.match(/^(\d{2})-/);
  return n ? parseInt(n[1], 10) : null;
}

let drumSeq = 0; // rotates the drum-pattern variation so repeated write_drums calls differ
let melodySeq = 0; // rotates the melody-hook variation across repeated write_melody calls
let bassSeq = 0;  // rotates the bassline groove variation — "another bassline" must differ

// LISTEN GATE — the iterative-loop enforcer: every sound-AFFECTING change (param
// edits AND newly written parts) is counted per track; racking up changes without
// HEARING the track puts a mandatory "audition now" nudge on further edits, and the
// agent loop refuses to finish a turn while any track has unheard changes
// (pendingListenChecks → agent.js injects an automatic listen pass). audition /
// get_track_audio / review_mix reset the counter. This is what makes the engine
// listen to itself instead of submitting a sound it never heard.
const editsSinceListen = new Map(); // trackIndex -> count
function noteEdit(track) {
  if (track == null) return null;
  const n = (editsSinceListen.get(track) || 0) + 1;
  editsSinceListen.set(track, n);
  if (n >= 4) return `LISTEN CHECK: ${n} sound edits on track ${track} without hearing it — audition(${track}) NOW, judge the result, then continue. Designing blind is how bad sounds ship.`;
  return null;
}
function heard(track) { if (track == null) editsSinceListen.clear(); else editsSinceListen.delete(track); }
function pendingListenChecks() { return [...editsSinceListen.entries()].filter(([, n]) => n > 0).map(([t, n]) => ({ track: t, changes: n })); }
// tracks where an instrument was loaded but NO parameter was ever designed — review_mix
// flags these as "still on the DEFAULT patch" (the bare-minimum failure detector)
const patchTouched = new Map(); // trackIndex -> true once any param/property was set
// effects loaded but never CONFIGURED (a flat EQ / default Utility does NOTHING) —
// review_mix flags them by name so "Adding effect ✓" can't masquerade as work
const fxUntouched = new Map(); // trackIndex -> [effect names still on defaults]
function fxLoadedAt(track, name) {
  if (!name) return;
  if (!fxUntouched.has(track)) fxUntouched.set(track, []);
  fxUntouched.get(track).push(String(name));
}
function fxConfigured(track, name) {
  const a = fxUntouched.get(track);
  if (!a || !a.length || !name) return;
  const i = a.findIndex((n) => n.toLowerCase() === String(name).toLowerCase());
  if (i >= 0) a.splice(i, 1);
}
function fxConfiguredMatch(track, re) {
  const a = fxUntouched.get(track);
  if (!a) return;
  const i = a.findIndex((n) => re.test(n));
  if (i >= 0) a.splice(i, 1);
}

// Curated progressions (roman numerals; enrich adds 7th/9th colour automatically).
const PROG_PRESETS = {
  "deep-house": ["i", "VI", "III", "VII"], pop: ["I", "V", "vi", "IV"],
  emotional: ["vi", "IV", "I", "V"], "jazz-251": ["ii", "V", "I", "I"],
  andalusian: ["i", "VII", "VI", "V"], "50s": ["I", "vi", "IV", "V"],
  epic: ["i", "VI", "III", "VII"], lofi: ["ii", "V", "iii", "vi"], rnb: ["i", "iv", "VII", "III"],
};

// ---- tool definitions (Anthropic tool-use schema) ------------------------

const TOOLS = [
  { name: "get_session", description: "Global session state: tempo, time signature, track/scene counts, the selected track & scene, and whether transport is playing. Call first to orient.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "list_tracks", description: "List every track: index, name, type (midi/audio/return/master), mute/solo/arm, normalized volume (0..1; ~0.85≈0 dB), pan (-1..1), and device count. Use the index everywhere else.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "get_track", description: "Detail for one track: devices (with indices + class names) and clip slots (which hold clips).",
    input_schema: { type: "object", properties: { track: { type: "integer" } }, required: ["track"], additionalProperties: false } },

  { name: "list_devices", description: "List the devices on a track (index, name, class).",
    input_schema: { type: "object", properties: { track: { type: "integer" } }, required: ["track"], additionalProperties: false } },

  { name: "get_device_params", description: "List a device's parameters: index, name, current value, min, max. Read this before set_device_param, set_eq_band, or set_compressor — stock-device parameter names/indices are only known at runtime.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" } }, required: ["track", "device"], additionalProperties: false } },

  { name: "set_device_param", description: "Set one device parameter. Identify the device by index and the parameter by index or exact name. Value is in the parameter's own units (read min/max from get_device_params). Values are clamped in Live. Returns before/after + whether it actually changed — check 'changed'.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, param: { type: ["integer", "string"] }, value: { type: "number" } }, required: ["track", "device", "param", "value"], additionalProperties: false } },

  { name: "dump_device", description: "FULL picture of a device: its class, automatable PARAMETERS (name/value/min/max) AND its PROPERTIES + functions. Critical for synths like Wavetable where the sound-shaping controls (oscillator wavetable, effect mode, filter routing, mono/poly) are PROPERTIES, not parameters — get_device_params alone misses them. Call this first to see everything you can actually change.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" } }, required: ["track", "device"], additionalProperties: false } },
  { name: "write_automation", description: "Draw PARAMETER AUTOMATION into a clip so a sound MOVES instead of staying static — a filter sweep into a drop, a volume ride, an FX build. param = a device parameter NAME (e.g. 'Filter Freq') with device = its index, OR 'volume'/'pan' for the track mixer. Give ramp:{from,to} for a smooth sweep across the whole clip (values in the parameter's own units — read them from get_device_params), OR points:[{time(beats),value}]. Requires a clip in the slot. This is how a real producer adds movement.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer", default: 0 }, param: { type: ["string", "integer"], description: "param name like 'Filter Freq', or 'volume'/'pan'" }, slot: { type: "integer", default: 0 }, ramp: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, additionalProperties: false, description: "smooth sweep across the clip" }, points: { type: "array", items: { type: "object", properties: { time: { type: "number" }, value: { type: "number" } }, required: ["time", "value"], additionalProperties: false } } }, required: ["track", "param"], additionalProperties: false } },

  { name: "read_automation", description: "READ a clip's existing automation envelope for a parameter (sampled curve, ~9 points) so you can SEE what's there before editing. Returns exists:false if the param has no automation in that clip. Use before write_automation when modifying existing movement, and after writing to double-check the shape.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer", default: 0 }, param: { type: ["string", "integer"], description: "param name, or 'volume'/'pan'" }, slot: { type: "integer", default: 0 }, points: { type: "integer", default: 9 } }, required: ["track", "param"], additionalProperties: false } },

  { name: "clear_automation", description: "DELETE automation from a clip: a single parameter's envelope (pass param) or ALL envelopes in the clip (omit param). Use to redo movement cleanly.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer", default: 0 }, param: { type: ["string", "integer"], description: "omit to clear ALL envelopes in the clip" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },

  { name: "set_device_property", description: "Set a device PROPERTY (not an automatable parameter) — e.g. Wavetable's oscillator_1_effect_mode, oscillator_1_wavetable_category/index, filter_routing, mono_poly. Discover exact property names with dump_device. Returns before/after + changed.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, property: { type: "string" }, value: { type: "number" } }, required: ["track", "device", "property", "value"], additionalProperties: false } },

  { name: "set_mixer", description: "Adjust a track's mixer. volume is NORMALIZED 0..1 (≈0.85 = 0 dB, 1.0 ≈ +6 dB, 0.6 ≈ -12 dB, 0 = -inf); read current volume from list_tracks and nudge from there. pan is -1..1. Only pass fields you want to change.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, volume: { type: "number", minimum: 0, maximum: 1 }, pan: { type: "number", minimum: -1, maximum: 1 }, mute: { type: "boolean" }, solo: { type: "boolean" }, arm: { type: "boolean" }, sends: { type: "array", items: { type: "object", properties: { returnIndex: { type: "integer" }, amount: { type: "number" } }, required: ["returnIndex", "amount"], additionalProperties: false } } }, required: ["track"], additionalProperties: false } },

  { name: "set_eq_band", description: "Convenience: shape one band of an EQ Eight on a track. Discovers the band's parameters by name and sets them. freq in Hz, gain in dB (ignored for cut filters), q is resonance.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, band: { type: "integer", minimum: 1, maximum: 8 }, freq: { type: "number" }, gain: { type: "number" }, q: { type: "number" }, on: { type: "boolean" } }, required: ["track", "device", "band"], additionalProperties: false } },

  { name: "set_compressor", description: "Convenience: set common Compressor/Glue parameters by name (threshold dB, ratio, attack ms, release ms, makeup dB, dry/wet %). Pass only what you want.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, threshold: { type: "number" }, ratio: { type: "number" }, attack: { type: "number" }, release: { type: "number" }, makeup: { type: "number" }, dry_wet: { type: "number" } }, required: ["track", "device"], additionalProperties: false } },

  { name: "list_browser", description: "EXPLORE Live's library — list what's installed in a category, optionally FILTERED by a substring. This is how you discover the huge kit/preset variety instead of defaulting to the same one: e.g. category:'drums' filter:'808' → every 808 kit; filter:'Kit' → all kits; category:'instruments' filter:'bass' → bass presets across synths. Call it BEFORE picking a kit/preset and choose one that fits the genre (vary your picks!). category: instruments | audio_effects | midi_effects | plugins | drums | sounds | max_for_live | packs | user_library | samples.",
    input_schema: { type: "object", properties: { category: { type: "string", default: "instruments" }, filter: { type: "string", description: "case-insensitive name substring, e.g. '808', 'kit', 'saw', 'piano'" }, limit: { type: "integer", default: 300 }, depth: { type: "integer", default: 3 } }, additionalProperties: false } },

  { name: "load_instrument", description: "Load an instrument onto a track by name. For a SYNTH, pass the exact device name — 'Wavetable', 'Operator', 'Analog', 'Simpler', or an installed plugin like 'Serum' — then sculpt it with get_device_params/set_device_param; do NOT pass a vibe description as the name. For a DRUM KIT ('909 kit', '808', 'drum kit', 'percussion'), expect a DRUM RACK PRESET from Live's drums library (e.g. 'Kit-Core 909'), NOT a synth — call list_browser category:'drums' first to see the real kit names and pass one of those. If nothing matches, the loader returns not-found WITH alternatives instead of loading a random device — pick from the alternatives or list_browser, never assume it loaded. Replaces an existing instrument.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, description: { type: "string", description: "the device/plugin NAME (e.g. 'Wavetable', 'Operator', 'Serum'), not a sound description" } }, required: ["track", "description"], additionalProperties: false } },

  { name: "load_audio_effect", description: "Append an audio effect DEVICE to a track by its exact name, e.g. 'EQ Eight', 'Glue Compressor', 'Reverb', 'Saturator', 'Delay', 'Limiter', or a plugin like 'Pro-L 2'. track -1 = the MASTER BUS — use that for master processing (glue compressor, then Limiter LAST, ceiling ≈ -0.3dB) at the end of every full production. DUPLICATE-SAFE: if a same-named device is already on the chain it returns alreadyLoaded:true and does NOT load a second copy — never retry a load that already succeeded; pass allow_duplicate:true ONLY when the user explicitly wants two instances. Use list_browser category:'audio_effects' to see exact names.",
    input_schema: { type: "object", properties: { track: { type: "integer", description: "track index, or -1 for the MASTER bus" }, description: { type: "string", description: "the effect device/plugin NAME" }, allow_duplicate: { type: "boolean", default: false, description: "load even if a same-named device is already on the chain" } }, required: ["track", "description"], additionalProperties: false } },

  { name: "load_sound", description: "Drag in a LOOP / SAMPLE / one-shot / clip from Live's browser onto a track (searches Sounds, Samples, Clips, Drums, packs, user library). Use for 'add a drum loop', 'drop in a vinyl crackle', 'find a vocal chop'. Loads onto the first empty clip slot of the track — fire it to hear it. Pass a descriptive name like 'house drum loop' or an exact sample name.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, name: { type: "string", description: "what to find, e.g. 'house drum loop', 'vinyl crackle', a sample name" } }, required: ["track", "name"], additionalProperties: false } },

  { name: "record_master", description: "RECORD what's playing on the master (the full mix you hear) into an audio clip on a 'Claude Capture' track, by resampling. Use to capture the mix so it can be heard back / referenced. Starts arrangement recording and auto-stops after `bars`. Combine with place_meters + get_mix_snapshot to actually analyse the captured sound.",
    input_schema: { type: "object", properties: { bars: { type: "integer", default: 4, description: "how many bars to capture before auto-stopping" } }, additionalProperties: false } },

  { name: "stop_record", description: "Stop a master recording started by record_master right now (instead of waiting for it to auto-stop). Returns the captured clip(s) and their audio file path if available.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "write_chords", description: "Generate a rich chord progression into a MIDI clip. chords = roman numerals (['I','V','vi','IV']) in key+mode, or absolute ([{root:'C3',quality:'maj7'}]). OR pass a preset: 'deep-house','pop','emotional','jazz-251','andalusian','50s','epic','lofi','rnb'. enrich=true (default) adds 7th/9th colour + smooth voice-leading. rhythm MATTERS for genre: 'held' = sustained pads (ambient/trance washes); 'offbeat' = short stabs on the &s (THE house/tech-house/garage feel — never write held whole-note chords for those genres); 'stabs8'/'stabs16' = driving chops; 'push' = syncopated. VARY the progression between requests — don't reuse the same romans every time.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, key: { type: "string", default: "C" }, mode: { type: "string", enum: ["major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "harmonic_minor", "melodic_minor"], default: "major" }, chords: { type: "array", items: {} }, preset: { type: "string" }, beats_per_chord: { type: "number", default: 4 }, octave: { type: "integer", default: 3 }, voicing: { type: "string", enum: ["spread", "duo", "open", "close", "drop2", "drop3", "rootless"], default: "spread", description: "'spread' (default) = the modern electronic voicing: LOW ROOT + ITS OCTAVE as the foundation, then a ROOTLESS colour stack above (no root duplication upstairs), up to ~3 octaves wide. 'duo' = just TWO notes: low root + one defining colour tone an octave-plus up — perfect for detuned analog two-osc patches. 'close' ONLY for tight blocky triads." }, rhythm: { type: "string", enum: ["held", "offbeat", "stabs8", "stabs16", "push"], default: "held", description: "'offbeat' = short stabs on the &s — REQUIRED feel for house/tech-house/garage. 'held' = sustained pads (ambient only)." }, enrich: { type: "boolean", default: true }, enrich_level: { type: "integer", default: 1 }, sevenths: { type: "boolean", default: false }, voice_leading: { type: "boolean", default: true }, velocity: { type: "integer", default: 90 }, humanize: { type: "boolean", default: true, description: "velocity humanize only — note timing stays clean on the grid" }, humanize_timing: { type: "number", default: 0, description: "OPT-IN timing feel in beats (±). 0 = notes exactly on grid (default)." }, swing: { type: "number", default: 0, description: "0..1 exact 8th-note swing: delays off-8ths by up to 1/3 of an 8th, lands on predictable positions" }, overwrite: { type: "boolean", default: true } }, required: ["track"], additionalProperties: false } },

  { name: "write_melody", description: "Write a melody/HOOK with real musical logic. EASIEST + BEST: pass `chords` (the SAME progression you wrote, as roman numerals or absolute) and the engine auto-builds a motif-based hook that lands chord tones on the strong beats, moves by step with rests, repeats the motif, and stays in key + on grid — pass a different `seed` (or just call again) for a new variation. (Advanced: instead pass explicit `degrees` 1..7 to place exact scale degrees.) Keep the lead in octave 4–5. A melody is a TONAL line, not noise.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, key: { type: "string", default: "C" }, mode: { type: "string", default: "major" }, chords: { type: "array", items: {}, description: "the chord progression to build the hook over (roman numerals like ['I','vi','IV','V'] or absolute) — RECOMMENDED" }, beats_per_chord: { type: "number", default: 4 }, seed: { type: "integer", description: "pick a melody variation; omit/change for a new one" }, degrees: { type: "array", items: { type: "integer" }, description: "advanced: explicit scale degrees instead of chords" }, rhythm: { description: "named groove, number, or array of beat-lengths (only with degrees)", default: 1 }, octave: { type: "integer", default: 4 }, velocity: { type: "integer", default: 100 }, humanize_timing: { type: "number", default: 0 }, swing: { type: "number", default: 0 }, overwrite: { type: "boolean", default: true } }, required: ["track"], additionalProperties: false } },

  { name: "write_bassline", description: "Generate a genre-locked bassline that FOLLOWS the chord progression — a seeded GROOVE engine, never a fixed loop: every call without a seed gives a NEW variation (syncopation, octave pops, ghost notes, approach tones, rests, velocity groove). style: 'tech-house' (bouncy syncopated 16ths around the offbeats — THE pick for tech house/house grooves), 'offbeat' (classic house 'and' bass), 'rolling' (deep-house 16ths), 'octave' (octave bounce), 'garage' (2-step), 'acid' (303 16ths w/ slides+accents), 'reese', 'sub', 'pluck'. Locks each chord window to the chord root in the bass register. A bassline that comes out as straight same-pitch 8ths is WRONG — regenerate with another seed. Give chords as roman numerals in key/mode (e.g. ['i','VI','III','VII']) or absolute.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, key: { type: "string", default: "C" }, mode: { type: "string", default: "minor" }, chords: { type: "array", items: {} }, style: { type: "string", enum: ["tech-house", "offbeat", "rolling", "octave", "garage", "acid", "reese", "sub", "pluck"], default: "offbeat" }, beats_per_chord: { type: "number", default: 4 }, octave: { type: "integer", default: 1 }, swing: { type: "number", default: 0.12 }, velocity: { type: "integer", default: 105 }, seed: { type: "integer", description: "pick a specific groove variation; omit (or call again) for a fresh one" }, overwrite: { type: "boolean", default: true } }, required: ["track", "chords"], additionalProperties: false } },

  { name: "write_drums", description: "Generate a VARIED, genre-correct drum pattern — NOT the same loop every time. Every call produces a different variation (different kick/snare/hat pattern, ghost notes, hat density + a fill in the last bar), so 'make another beat' actually gives a new one. genre: house, deep house, tech house, techno, trap, hip hop / boom bap, dnb, breakbeat, uk garage / 2-step, dubstep, afrobeats, funk / disco — each with its real signature placement (house 4-on-floor, trap snare-on-3 + hat rolls, dnb 2&4 backbeat, garage shuffled 2-step, etc.). Needs a DRUM RACK / kit on the track (kick=C1/36, snare=38, clap=39, closed hat=42, open hat=46). Pass seed for a specific variation; omit it (or just call again) for a fresh one. Stays on-grid; swing only if asked.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, genre: { type: "string", default: "house" }, bars: { type: "integer", default: 2 }, fill: { type: "boolean", default: true }, intensity: { type: "number", default: 1 }, swing: { type: "number", default: 0, description: "0 = straight (default). Only > 0 if the user explicitly asks for swing/shuffle." }, seed: { type: "integer", description: "optional: pick a specific variation; omit for a new one each call" }, overwrite: { type: "boolean", default: true } }, required: ["track"], additionalProperties: false } },

  { name: "write_notes", description: "Write raw MIDI notes into a clip. Each note: {pitch 0-127, start beats, duration beats, velocity 1-127}. Use for drums, basslines, anything bespoke. C3=60.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, length_bars: { type: "number" }, notes: { type: "array", items: { type: "object", properties: { pitch: { type: "integer" }, start: { type: "number" }, duration: { type: "number" }, velocity: { type: "integer" } }, required: ["pitch", "start", "duration"], additionalProperties: false } }, overwrite: { type: "boolean", default: true } }, required: ["track", "notes"], additionalProperties: false } },

  { name: "clear_clip", description: "Delete the notes in a track's clip slot.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },

  { name: "fire_clip", description: "Launch (play) the clip in a track's slot.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },

  { name: "transport", description: "Control playback: start / stop / continue. Optionally set tempo (bpm).",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "continue"] }, bpm: { type: "number" } }, additionalProperties: false } },

  { name: "create_track", description: "Create a new track. type: 'midi' or 'audio'.",
    input_schema: { type: "object", properties: { type: { type: "string", enum: ["midi", "audio"] }, name: { type: "string" } }, required: ["type"], additionalProperties: false } },

  { name: "device_onoff", description: "Turn a device on or off (bypass) on a track.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, on: { type: "boolean" } }, required: ["track", "device", "on"], additionalProperties: false } },
  { name: "delete_device", description: "Delete a device from a track's chain by index.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" } }, required: ["track", "device"], additionalProperties: false } },
  { name: "duplicate_track", description: "Duplicate a track (copy inserted after it).",
    input_schema: { type: "object", properties: { track: { type: "integer" } }, required: ["track"], additionalProperties: false } },
  { name: "delete_track", description: "Delete a track by index.",
    input_schema: { type: "object", properties: { track: { type: "integer" } }, required: ["track"], additionalProperties: false } },
  { name: "rename_track", description: "Rename a track.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, name: { type: "string" } }, required: ["track", "name"], additionalProperties: false } },
  { name: "set_track_color", description: "Set a track's color (RGB integer, e.g. 0xFF6600 = 16737792).",
    input_schema: { type: "object", properties: { track: { type: "integer" }, color: { type: "integer" } }, required: ["track", "color"], additionalProperties: false } },
  { name: "duplicate_clip", description: "Duplicate the clip in a track's slot to the next slot.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },
  { name: "set_clip", description: "Set clip properties: looping (bool), loop_start/loop_end (beats), name.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, looping: { type: "boolean" }, loop_start: { type: "number" }, loop_end: { type: "number" }, name: { type: "string" } }, required: ["track"], additionalProperties: false } },
  { name: "quantize_clip", description: "Quantize a clip's notes. grid: 1=1/4,2=1/8,3=1/8T,4=1/16,5=1/16(default),6=1/32. amount 0..1.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, grid: { type: "integer", default: 5 }, amount: { type: "number", default: 1 } }, required: ["track"], additionalProperties: false } },
  { name: "create_scene", description: "Create a new scene (appended unless index given).",
    input_schema: { type: "object", properties: { index: { type: "integer" } }, additionalProperties: false } },
  { name: "fire_scene", description: "Launch a scene (fires all its clips).",
    input_schema: { type: "object", properties: { scene: { type: "integer" } }, required: ["scene"], additionalProperties: false } },
  { name: "set_master", description: "Set the Master (or a return track) volume/pan. target: 'master' or a return-track index. volume normalized 0..1 (~0.85=0 dB).",
    input_schema: { type: "object", properties: { target: { type: ["string", "integer"], default: "master" }, volume: { type: "number" }, pan: { type: "number" } }, additionalProperties: false } },
  { name: "capture_midi", description: "Capture recently played MIDI into a clip (like Live's Capture). destination 1=session, 2=arrangement.",
    input_schema: { type: "object", properties: { destination: { type: "integer", default: 1 } }, additionalProperties: false } },
  { name: "undo", description: "Undo the last action in Live.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "redo", description: "Redo the last undone action.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "arrange_clip", description: "Lay a Session clip onto the ARRANGEMENT timeline to build the actual song. First write the clip into a session slot (write_chords/write_notes), then call this with beat times to drop copies down the timeline. 4 beats = 1 bar (4/4). e.g. times:[0,16,32,48] places it at bars 1,5,9,13. Use this to arrange intro/verse/chorus, not just session clips.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 }, times: { type: "array", items: { type: "number" }, description: "beat positions to place copies, e.g. [0,16,32]" }, time: { type: "number", description: "single beat position (if not using times[])" } }, required: ["track"], additionalProperties: false } },

  { name: "detect_key", description: "Detect the musical key and suggest chords that fit. from:'audio' (default) listens to the pitch tracker — the Claude Copilot device must be ON the vocal/audio track and the audio must have PLAYED for a few seconds (call reset_key_detection first, ask the user to play, then call this). from:'midi' reads a MIDI clip's notes instead. Returns the key, confidence, diatonic chords, and progression ideas.",
    input_schema: { type: "object", properties: { from: { type: "string", enum: ["audio", "midi"], default: "audio" }, track: { type: "integer" }, slot: { type: "integer", default: 0 } }, additionalProperties: false } },
  { name: "reset_key_detection", description: "Clear the accumulated pitch history before analyzing a vocal/audio for its key. Call this, then have the user play the vocal, then call detect_key.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "debug_browser", description: "Diagnostic: dump the real structure (children/properties/functions via LiveAPI .info) of Live's browser object. Use when load_instrument can't find anything, then show the user the raw result verbatim so the browser access can be fixed.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "get_mix_snapshot", description: "HEAR the mix: reads Live's own output meters for EVERY track, every RETURN bus (track index -2-r), AND the master — peak dB + RMS/loudness dB (plus spectral bands/LUFS for any track that also has a ClaudeMeter; place_meters covers the whole set incl. returns + master). Works with no setup. IMPORTANT: meters are only meaningful while audio is PLAYING — start playback (transport) first, or tell the user to hit play. Use to balance levels, find what's loudest/clipping, and master the bus.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_track_audio", description: "HEAR one track: peak dB + RMS/loudness dB from Live's meter (plus spectral bands if a ClaudeMeter is on it). Start playback first — meters read live signal. Use before EQ/level moves on that track.",
    input_schema: { type: "object", properties: { track: { type: "integer" } }, required: ["track"], additionalProperties: false } },
  { name: "place_meters", description: "Auto-place a ClaudeMeter analyzer at the END of EVERY track in the set — all regular tracks, all RETURN tracks (FX busses), and the MASTER — for a full loudness + spectral overview of the whole mix. Call this FIRST on any 'mix this' / 'master this' / full-mix task so review_mix hears everything. Skips tracks that already have a meter. Needs the loader; reports any track that needs a manual ClaudeMeter drop.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "review_mix", description: "PRODUCER REVIEW + the recursive-listening loop. Listens to the master + EVERY track + every RETURN bus and returns a PROBLEMS list you MUST fix and re-review until empty: SILENT tracks, DEFAULT-PATCH tracks (instrument loaded but never sound-designed — finish them!), master clipping, missing master LIMITER — plus per-track {role, TARGET, audible, level, measured CHARACTER (thick/thin/bright/muddy from its ClaudeMeter)}, the return busses ('returns'), and the master chain (incl. master spectral character if it has a meter). Run place_meters first for full spectral coverage. Loop: review_mix → fix every problem → review_mix again → repeat until problems is empty AND each track's character matches its target. Audio must be PLAYING.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_device_chains", description: "MAP THE WHOLE SIGNAL PATH — call this BEFORE any mixing/mastering pass or before editing a track's effects: every track + every return + the master with its full device chain IN SIGNAL ORDER, and for each device its name, class, parameter count and whether you can actually CONTROL it. VST/AU plug-ins (FabFilter, Ozone…) expose ONLY the knobs the user has CONFIGURED in Live: a device with controllable:false has no exposed parameters — you CANNOT edit it until the user runs the Configure flow; the result's configureHelp has the exact user steps to relay (wrench icon → Configure (green) → touch the wanted knobs in the plugin window → Configure again). Also judge the chain ORDER here (track: EQ-cuts → compressor → saturation/colour → EQ-boosts → spatial FX; master: EQ → glue compressor → saturation → stereo imaging → LIMITER LAST) and fix it with move_device.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "move_device", description: "REORDER a device chain: move one device to a new position on a track (position 0 = first in chain; chain order = signal order). Use to improve processing order — EQ before compressor, Limiter LAST on the master, ClaudeMeter always at the very end (fix_meters keeps that automatically after your move). track -1 = master, -2-r = return r. Returns chainBefore/chainAfter — verify 'changed'.",
    input_schema: { type: "object", properties: { track: { type: "integer", description: "track index; -1 = master, -2-r = return r" }, device: { type: "integer", description: "current device index" }, to: { type: "integer", description: "target position (0 = first)" } }, required: ["track", "device", "to"], additionalProperties: false } },

  { name: "record_tracks", description: "MULTITRACK CAPTURE — hear the WHOLE song, every track at once: each ClaudeMeter records its own track to a wav file simultaneously while the song plays from the start (the live meters only show the last few seconds; this gets the full arrangement). Auto-places meters first, records `bars` bars, auto-stops, returns one named wav per track/return/master grouped in a per-project folder. Then ALWAYS: analyze_recordings to dissect them together, and cleanup_recordings at the end of the session (never leave files behind). NOTE: this call takes as long as the recording — keep bars realistic (whole song = song length in bars, max ~128).",
    input_schema: { type: "object", properties: { bars: { type: "integer", default: 16, description: "how many bars to capture" }, from_start: { type: "boolean", default: true, description: "jump the song to 1.1.1 before recording (full-song coverage)" } }, additionalProperties: false } },

  { name: "analyze_recordings", description: "GROUP-ANALYSE the last record_tracks batch: full FFT per track wav — spectral balance, brightness/centroid, fundamental, loudness, attack/sustain character, and ACTIVE SECTIONS (which bars the track actually plays) — plus cross-track observations: low-end clash candidates (multiple tracks heavy below ~250Hz), near-silent tracks, loudest vs quietest, brightest. The master wav is the full mix. This is the deep-listening pass for mixing/mastering decisions on the WHOLE song.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "cleanup_recordings", description: "CLEAN UP after a recording/analysis session — MANDATORY at the end: deletes all recorded wav files from ~/.claude-copilot/recordings AND removes the 'Claude Capture' resampling track(s) from the Live set. Pass keep_files:true only if the user explicitly wants to keep the stems on disk.",
    input_schema: { type: "object", properties: { keep_files: { type: "boolean", default: false } }, additionalProperties: false } },

  { name: "analyze_audio_file", description: "Analyse ANY audio file on disk by absolute path — e.g. a file the user ATTACHED in the chat (uploads land in ~/.claude-copilot/uploads, the chat message includes the path). WAV reads directly; mp3/m4a/aiff/flac auto-convert via macOS afconvert. Returns the full spectral profile: balance per band, brightness, fundamental, loudness, temporal behaviour, active sections, plain-language character.",
    input_schema: { type: "object", properties: { path: { type: "string", description: "absolute path to the audio file" } }, required: ["path"], additionalProperties: false } },

  { name: "device_skill", description: "Read concrete sound-design knowledge before programming a sound. Three lookups, any combination: (1) device — the SKILL doc for a device (Wavetable, Operator, EQ Eight, Compressor, Glue, Reverb, Delay, Saturator, Utility): what each parameter does + recipes. (2) character — an ORDERED list of real param moves for a vibe word the user said: thick/fat, warm, bright, dark, punchy, plucky, reese, hollow, aggressive. THIS is how you turn 'thick bass' into actual moves (low octave, unison voices + detune, sub layer, saturation, open-ish lowpass, mono lows) instead of guessing and shipping a thin pluck. (3) genre — a style palette (which synth/wavetable/filter/FX chain) for deep house, uk garage, 2010 festival, trap, lo-fi. ALWAYS call this (with device AND the character/genre the user implied) before set_device_param, alongside get_device_params. These are researched starting points — also web_search to confirm exact values for a specific reference.",
    input_schema: { type: "object", properties: {
      device: { type: "string", description: "device name, e.g. 'Wavetable'" },
      character: { type: "string", description: "a vibe/adjective the user used, e.g. 'thick', 'fat', 'warm', 'punchy', 'reese', 'aggressive' — returns ordered concrete param moves" },
      genre: { type: "string", description: "a genre/style, e.g. 'deep house', 'uk garage', '2010 festival', 'trap', 'lo-fi' — returns a per-role synth + FX palette" }
    }, additionalProperties: false } },

  { name: "custom_skill", description: "THE USER'S OWN SKILLS — named text files they imported or wrote in settings (⚙ → Skills): house rules, personal recipes, reference specs ('my kick chain', 'label mix spec'). PROJECT STATE lists the available names. Read one when the user references it by name OR its topic matches the task. USER SKILLS OUTRANK every built-in skill when they conflict — they are the user's law. No args = list all; name = read one; name+content = save/update (when the user asks you to remember a way of working as a skill); name+delete_skill = remove.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "the skill's name (fuzzy match ok)" },
      content: { type: "string", description: "save/overwrite this skill with this text" },
      delete_skill: { type: "boolean", default: false },
    }, additionalProperties: false } },

  { name: "set_modulation", description: "WIRE THE MOD MATRIX on a Wavetable (class 'InstrumentVector') — the routing layer that makes patches MOVE, which set_device_param alone never touches. Route a SOURCE (Env 2, Env 3, LFO 1, LFO 2, MIDI Velocity/Note/Pitch Bend…) to a TARGET (any visible matrix target: 'Filter 1 Frequency', 'Osc 1 Position', 'Osc 1 Transpose', 'Volume'…) with amount -1..1. THE classic wirings: Env 2→Filter 1 Frequency 0.3–0.7 = pluck/acid squelch (then shape 'Env 2 Attack/Decay' via set_device_param); LFO 1→Osc 1 Position 0.2–0.5 = evolving wavetable; LFO 1→Filter 1 Frequency = wobble/reese; MIDI Velocity→Volume = playable dynamics. Call with ONLY track+device to LIST the device's actual targets + sources first. Returns before/after — verify changed:true. A tonal patch with an EMPTY matrix is unfinished.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, device: { type: "integer" }, target: { type: ["string", "integer"], description: "matrix target name (substring ok) or index — omit to list all targets/sources" }, source: { type: ["string", "integer"], description: "Env 2 | Env 3 | LFO 1 | LFO 2 | Amp Env | MIDI Velocity | MIDI Note | …" }, amount: { type: "number", minimum: -1, maximum: 1, description: "modulation depth -1..1; omit (with target+source) to READ the current value" } }, required: ["track", "device"], additionalProperties: false } },

  { name: "sound_recipe", description: "The SELF-GROWING sound library — recipes researched online, saved forever, already translated to stock Ableton terms. ALWAYS check here before designing a named/signature sound (e.g. 'hoover', 'donk', 'Tale Of Us pad'); on a miss: web_search how it's made (instructions for Serum/Vital/Massive are fine), TRANSLATE to Wavetable/Operator/Drift terms (osc→wavetable+position, macros→matrix routings via set_modulation), BUILD it, verify by audition, then SAVE it with `learn` so it's known next time. Pass only `name` to look up; add `learn` to save.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "the sound's name, e.g. 'hoover', 'reese (neuro)', 'pryda chord stab'" },
      learn: { type: "object", description: "save a researched/proven recipe", properties: {
        character: { type: "string" }, genre: { type: "string" },
        sourceSynth: { type: "string", description: "what synth the original instructions were for" },
        steps: { type: "array", items: { type: "string" }, description: "ordered concrete steps in STOCK ABLETON terms (device, params, matrix routings)" },
        modulation: { type: "string", description: "the matrix wirings, e.g. 'Env2→Filter1 Freq 0.45; LFO1→Osc1 Pos 0.3 (rate 0.8Hz)'" },
        source: { type: "string", description: "where it was learned (URL/author)" },
      }, additionalProperties: false },
    }, required: ["name"], additionalProperties: false } },

  { name: "genre_skill", description: "THE GENRE VOCABULARY — call this BEFORE writing anything in a named genre/style: how MELODIES, BASSLINES and CHORDS actually behave in that genre, each with FAMOUS reference tracks (e.g. tech house bass → FISHER 'Losing It' octave bounce; trance chords → 'Children' i–VI–III–VII; deep house → Kerri Chandler m9 stabs) and a concrete RECIPE mapped onto the writing tools (exact write_chords romans/preset/rhythm, write_bassline style, write_melody settings), plus the genre's sound palette, BPM range and mix/master loudness targets. part:'melodies'|'bassline'|'chords'|'sound'|'mixmaster' narrows it; omit part for everything. Knows: house, deep house, tech house, techno, trance, uk garage, dnb, dubstep, trap, hip hop, lo-fi, edm festival, afro house, ambient, pop (+aliases like ukg, d&b, boom bap, big room, amapiano).",
    input_schema: { type: "object", properties: { genre: { type: "string", description: "the genre/style the user named, e.g. 'tech house', 'liquid dnb', 'boom bap'" }, part: { type: "string", enum: ["melodies", "bassline", "chords", "sound", "mixmaster"], description: "narrow to one aspect (omit = full)" } }, required: ["genre"], additionalProperties: false } },

  { name: "plugin_skill", description: "Knowledge about a THIRD-PARTY plug-in (VST/AU) — call this BEFORE touching any plug-in's knobs (FabFilter Pro-Q/Pro-L/Pro-C/Saturn, Ozone, Buster SE…): what each control does + concrete recipes per use-case. If the plug-in is UNKNOWN, the result says so → web_search its manual/parameter guide, then call plugin_skill again with `learn` to SAVE what you found (params summary + recipes) — learned once, it's known on this machine forever. Then map the recipe onto the CONFIGURED param names from get_device_params (match names fuzzily — 'Output Level' ↔ 'Output'). NEVER guess what a plug-in knob does.",
    input_schema: { type: "object", properties: {
      plugin: { type: "string", description: "the plug-in name as it appears on the device, e.g. 'Pro-L 2', 'BUSTER SE'" },
      learn: { type: "object", description: "save researched knowledge for this plugin", properties: {
        kind: { type: "string", description: "e.g. 'limiter (mastering)'" },
        params: { type: "string", description: "what the key controls do, compact" },
        recipes: { type: "object", description: "use-case → concrete settings", additionalProperties: { type: "string" } },
        note: { type: "string" },
      }, additionalProperties: false },
    }, required: ["plugin"], additionalProperties: false } },

  { name: "element_skill", description: "THE PER-ELEMENT PRODUCTION SKILL — select the right skill for the task at hand. Pass the element you're working on or judging (kick, bass, snare/clap, hats/percussion, chords/pads, melody/lead, vocal, master) or a TECHNIQUE (sidechain — the when-to-duck decision map + 3 executable methods; arrangement — genre timeline blueprints + beat math; fx/transitions) and get its CHECKLIST (what a finished one must satisfy + which tool MEASURES each point) and a DIAGNOSE→FIX map (every common failure with the concrete moves, e.g. 'kick out of tune → Simpler Transpose by tuning.semitonesToRoot, or pick a kick sampled in key'). WORKFLOW: listen to the element (audition/analyze_recordings — rows carry `tuning` vs the DETECTED song key) → critique it against this skill's checklist → apply the matching fixes → re-listen. Call with no args for the list of elements.",
    input_schema: { type: "object", properties: { element: { type: "string", description: "kick | bass | snare_clap | hats_percussion | chords_pads | melody_lead | vocal | sidechain | fx_transitions | arrangement | master (aliases like 'snare', 'hats', 'pads', 'lead', '808', 'pump', 'timeline' work)" } }, additionalProperties: false } },

  { name: "production_checklist", description: "The FULL production run-through, in order (kick → bass → snare → hats → chords → melody → vocal → FX/transitions → master): for each element, what to VERIFY and how to measure it. Run this when finishing a track, when asked to 'improve/check the track', or after building several elements: go element by element — listen (audition / review_mix / analyze_recordings), compare against the element's checklist (element_skill has the detailed fixes), fix, re-listen, then move on. The classic catch this exists for: the song is in G minor but the KICK is slightly off-key — analyze_recordings' tuning field exposes it, the kick skill says how to retune.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "audio_to_midi", description: "TURN A VOICE RECORDING INTO MIDI — the user beatboxes or hums and it becomes a clip. kind:'drums' = beatbox → kick/snare/hat hits (onset + spectral classification), quantized to the session tempo, written as MIDI 36/38/42 — load a fitting DRUM KIT on the track FIRST (list_browser category:'drums'). kind:'melody' = humming/singing → pitch-tracked notes in the grid — load a synth on the track first, and check the notes against the song key after. kind:'auto' (default) picks by how pitched the audio is. Source: the file path from a chat attachment or the [voice recording: …] marker on transcribed voice messages. Writes into the track/slot and returns what it heard (hit counts / note range / bars).",
    input_schema: { type: "object", properties: { path: { type: "string", description: "absolute path to the voice/audio file" }, track: { type: "integer" }, slot: { type: "integer", default: 0 }, kind: { type: "string", enum: ["auto", "drums", "melody"], default: "auto" }, bpm: { type: "number", description: "override tempo (defaults to the session tempo)" }, grid: { type: "integer", default: 4, description: "quantize grid in divisions per beat (4 = 16ths)" } }, required: ["path", "track"], additionalProperties: false } },

  { name: "remember", description: "Save to PROJECT MEMORY (your persistent diary of THIS Live set, auto-injected as PROJECT STATE every turn so you stay aware of the direction without re-querying). Call this when: the user states a direction (genre/reference/tempo/key/palette); you finish DESIGNING a sound on a track (record its role + a short sound description + the few key params you set); or you make a notable decision. Live already tracks the raw track/device list — store the INTENT and sound CHARACTER Live can't recover (e.g. 'thick reese, unison 7 + sub, this is the drop bass'). Pass only what changed.",
    input_schema: { type: "object", properties: {
      direction: { type: "object", description: "creative direction; any of: genre, reference, tempo, key, mode, palette", properties: { genre: { type: "string" }, reference: { type: "string" }, tempo: { type: "number" }, key: { type: "string" }, mode: { type: "string" }, palette: { type: "string" } }, additionalProperties: false },
      track: { type: "string", description: "the TRACK NAME this note is about (names are stable across reorders; not the index)" },
      role: { type: "string", description: "e.g. 'lead','bass','drums','chords','pad'" },
      sound: { type: "string", description: "short sound character, e.g. 'thick reese, unison 7 + sub, low-pass w/ slow LFO'" },
      params: { type: "object", description: "the few key parameter values you set, e.g. {\"Unison Voices\":7,\"Filter Freq\":1200}", additionalProperties: { type: ["number", "string"] } },
      note: { type: "string", description: "one-line decision for the running log, e.g. 'built the drop reese on Bass'" },
    }, additionalProperties: false } },

  { name: "recall", description: "Read back PROJECT MEMORY for this set (direction + per-track notes + decision log). You rarely need this — PROJECT STATE is already injected every turn. Use only if you need the full param values you stored or suspect the injected block was trimmed.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "forget_project", description: "WIPE this project's memory (direction, track notes, decision log) and start fresh. Use when the user says 'fresh start' / 'forget all that' / 'new idea', or when the stored direction clearly no longer matches what they're asking for. The user's CURRENT request always outranks old memory.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "lom_get", description: "POWER TOOL — read ANY value in Ableton's Live Object Model when no dedicated tool covers it (edge-case feature access). `path` navigates from the song as an array of names + indices: e.g. ['tracks',0,'devices',1,'parameters',3], ['tracks',0,'clip_slots',0,'clip'], ['tracks',0,'mixer_device','sends',0], or start with 'master'/'view'/'app'. `prop` is the property to read (e.g. 'name','value','warp_mode','warping','gain','launch_quantization','solo','crossfade_assign','current_monitoring_state'). Returns {value}. Use to inspect features Live exposes that aren't in the other tools.",
    input_schema: { type: "object", properties: { path: { type: "array", items: { type: ["string", "integer"] } }, prop: { type: "string" } }, required: ["path", "prop"], additionalProperties: false } },

  { name: "lom_set", description: "POWER TOOL — set ANY property on a Live object that has no dedicated tool (edge-case feature access). `path` = array from the song (see lom_get). `prop` = the property (e.g. 'warping','warp_mode','gain','pitch_coarse','looping','launch_quantization','legato','velocity_amount','crossfade_assign','current_monitoring_state','input_routing_channel'). `value` = the new value (int/float/string per the property). Returns before/after/changed. This is how you reach ANY Live setting the curated tools don't have.",
    input_schema: { type: "object", properties: { path: { type: "array", items: { type: ["string", "integer"] } }, prop: { type: "string" }, value: {} }, required: ["path", "prop", "value"], additionalProperties: false } },

  { name: "lom_call", description: "POWER TOOL — invoke ANY function on a Live object (edge-case operations no dedicated tool covers). `path` = array from the song (see lom_get). `method` = the function name (e.g. 'duplicate_clip_slot','crop','quantize','fire','create_audio_track','delete_device','duplicate_region','set_fire_button_state','select_all_notes','add_new_notes'). `args` = array of arguments. Returns the result. Use to trigger Live operations not exposed elsewhere (warp, crop, consolidate, freeze-via-API, rack chain ops, etc.).",
    input_schema: { type: "object", properties: { path: { type: "array", items: { type: ["string", "integer"] } }, method: { type: "string" }, args: { type: "array", items: {} } }, required: ["path", "method"], additionalProperties: false } },

  { name: "analyze_clip", description: "ANALYSE AN AUDIO CLIP LIKE AN AUDIO FILE — full FFT of the actual recorded waveform. Reads the clip's sample off disk and returns the WHOLE sound: fundamental pitch, spectral balance across 10 bands, brightness (centroid), low-end ratio (thickness), AND temporal behaviour (attack vs sustain vs decay — punchy/plucky/sustained), plus a plain character summary. Use on any AUDIO clip (a loop, sample, vocal, or a bounced/recorded sound). NOTE: only works on AUDIO clips that have a file — a MIDI clip (notes) has no audio file; to analyse a synth you're designing, it must be recorded to audio first.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },

  { name: "audition", description: "HEAR a track via its ClaudeMeter (NON-destructive: never solos/mutes/records — it just plays the clip and reads the meter). Returns whether the track is actually AUDIBLE + loudness (peak/RMS dB) + spectrum if the meter reports it. CRITICAL USE: after designing a sound, audition to CONFIRM IT ACTUALLY MAKES SOUND — if audible:false the track is SILENT (no instrument, no notes, or muted) and you must NOT claim a sound exists; fix it. Then if it's audible but wrong (too quiet/thin), adjust params and audition again. Requires a clip + instrument on the track.",
    input_schema: { type: "object", properties: { track: { type: "integer" }, slot: { type: "integer", default: 0 } }, required: ["track"], additionalProperties: false } },
];

// ---- helpers -------------------------------------------------------------

function clipLengthBeats(notes, sigNum = 4) {
  const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  return Math.max(sigNum, Math.ceil(end / sigNum) * sigNum);
}

// Find a parameter index by trying name substrings (case-insensitive).
function findParam(params, needles) {
  const low = params.map((p) => ({ i: p.index, n: String(p.name).toLowerCase() }));
  for (const needle of needles) {
    const hit = low.find((p) => p.n.includes(needle));
    if (hit) return hit.i;
  }
  return -1;
}

// ---- dispatch ------------------------------------------------------------

async function dispatchInner(name, input, { live }) {
  switch (name) {
    case "get_session": {
      // the REAL key comes from the clips (Krumhansl over the set's MIDI) — Live's
      // scale chooser is only a setting and was being misreported as "the key"
      let sk = null;
      try { sk = await songKey.detect(); } catch (e) {}
      try {
        const r = await remoteClient.session();
        if (r && r.ok) {
          if (sk) { r.liveScaleSetting = r.key; r.key = sk.key; r.keyInfo = sk.label; r.keyConfidence = sk.confidence; r.keySource = sk.source; }
          return { result: r, label: "Reading session", detail: sk ? sk.key : undefined };
        }
      } catch (e) { /* fall back to v8 */ }
      const v = await live.call("session_info");
      if (sk && v) { v.liveScaleSetting = v.key; v.key = sk.key; v.keyInfo = sk.label; }
      return { result: v, label: "Reading session" };
    }

    case "list_tracks":
      try { const r = await remoteClient.tracks(); if (r && r.ok) return { result: { tracks: r.tracks }, label: "Listing tracks" }; } catch (e) { /* fall back to v8 */ }
      return { result: await live.call("list_tracks"), label: "Listing tracks" };

    case "get_track":
      try { const r = await remoteClient.track(input.track); if (r && r.ok) return { result: r, label: "Inspecting track", detail: `#${input.track}` }; } catch (e) { /* fall back to v8 */ }
      return { result: await live.call("get_track", { track: input.track }), label: "Inspecting track", detail: `#${input.track}` };

    case "list_devices":
      return { result: await live.call("list_devices", { track: input.track }), label: "Reading devices", detail: `track ${input.track}` };

    case "get_device_params":
      try {
        const r = await remoteClient.getParams(input.track, input.device);
        if (r && r.ok) return { result: { device: r.device, className: r.class, params: r.params }, label: "Reading parameters", detail: `${r.device} (${r.params.length})` };
      } catch (e) { /* remote script not running — fall back to v8 */ }
      return { result: await live.call("list_params", { track: input.track, device: input.device }), label: "Reading parameters", detail: `t${input.track} d${input.device}` };

    case "write_automation": {
      try {
        const r = await remoteClient.automate(input.track, input.device ?? 0, input.param, input.slot ?? 0, input.ramp, input.points);
        return { result: r, label: "Automating", detail: r && r.ok ? `${r.param} (${r.points} pts)` : (r && r.error) || "failed" };
      } catch (e) { return { result: { ok: false, error: "loader not running — enable Claude_Copilot to automate." }, label: "Automating", detail: "loader off" }; }
    }

    case "read_automation": {
      try { const r = await remoteClient.automationGet(input.track, input.device ?? 0, input.param, input.slot ?? 0, input.points ?? 9); return { result: r, label: "Reading automation", detail: r && r.exists === false ? `${r.param}: none` : `${(r && r.param) || input.param}` }; }
      catch (e) { return { result: { ok: false, error: "loader not running." }, label: "Reading automation", detail: "loader off" }; }
    }
    case "clear_automation": {
      try { const r = await remoteClient.automationClear(input.track, input.device ?? 0, input.param, input.slot ?? 0); return { result: r, label: "Clearing automation", detail: (r && r.cleared) || (r && r.error) || "" }; }
      catch (e) { return { result: { ok: false, error: "loader not running." }, label: "Clearing automation", detail: "loader off" }; }
    }
    case "lom_get": {
      try { const r = await remoteClient.lomGet(input.path, input.prop); return { result: r, label: "Reading (LOM)", detail: `${(input.path || []).join(".")}.${input.prop}` }; }
      catch (e) { return { result: { ok: false, error: "loader not running — enable Claude_Copilot." }, label: "Reading (LOM)", detail: "loader off" }; }
    }
    case "lom_set": {
      try { const r = await remoteClient.lomSet(input.path, input.prop, input.value); return { result: r, label: "Setting (LOM)", detail: `${input.prop}=${input.value}${r && r.changed === false ? " (NO CHANGE)" : ""}` }; }
      catch (e) { return { result: { ok: false, error: "loader not running — enable Claude_Copilot." }, label: "Setting (LOM)", detail: "loader off" }; }
    }
    case "lom_call": {
      try { const r = await remoteClient.lomCall(input.path, input.method, input.args || []); return { result: r, label: "Calling (LOM)", detail: `${input.method}(${(input.args || []).join(",")})` }; }
      catch (e) { return { result: { ok: false, error: "loader not running — enable Claude_Copilot." }, label: "Calling (LOM)", detail: "loader off" }; }
    }

    case "set_device_param": {
      try {
        const r = await remoteClient.setParam(input.track, input.device, input.param, input.value);
        if (r && r.ok && r.changed !== false) {
          patchTouched.set(input.track, true); fxConfigured(input.track, r.device);
          const nudge = noteEdit(input.track); if (nudge) r.listenCheck = nudge;
        }
        if (r && r.ok) return { result: r, label: "Tweaking parameter", detail: `${r.param}: ${r.before}→${r.after}${r.changed === false ? " (NO CHANGE — already at that value or not settable)" : ""}` };
        // remote reachable but param not found — surface its error, don't silently "succeed"
        if (r && r.error) return { result: r, label: "Tweaking parameter", detail: r.error };
      } catch (e) { /* remote script not running — fall back to v8 */ }
      const r = await live.call("set_param", input);
      if (r && r.changed !== false) { const nudge = noteEdit(input.track); if (nudge) r.listenCheck = nudge; }
      return { result: r, label: "Tweaking parameter", detail: `${r.name || input.param}: ${r.before}→${r.after}${r.changed === false ? " (NO CHANGE)" : ""}` };
    }
    case "dump_device":
      try {
        const r = await remoteClient.getDevice(input.track, input.device);
        if (r && r.ok) return { result: r, label: "Inspecting device", detail: `${r.device} (${r.class})` };
      } catch (e) { /* fall back to v8 */ }
      return { result: await live.call("dump_device", input), label: "Inspecting device", detail: `t${input.track} d${input.device}` };
    case "set_device_property": {
      // Wavetable osc/wavetable/unison props are observe-only in v8 LiveAPI (silent no-op)
      // but settable from Python — so go through the remote script when it's running.
      try {
        const r = await remoteClient.setProperty(input.track, input.device, input.property, input.value);
        if (r && r.ok && r.changed !== false) {
          patchTouched.set(input.track, true); fxConfigured(input.track, r.device);
          const nudge = noteEdit(input.track); if (nudge) r.listenCheck = nudge;
        }
        if (r && r.ok) return { result: r, label: "Device property", detail: `${input.property}: ${r.before}→${r.after}${r.changed === false ? " (NO CHANGE — check value is a valid int / set category before index)" : ""}` };
        if (r && r.error) return { result: r, label: "Device property", detail: r.error };
      } catch (e) { /* remote script not running — fall back to v8 (likely silent no-op) */ }
      const r = await live.call("set_device_property", input);
      return { result: r, label: "Device property", detail: `${input.property}: ${r.before}→${r.after}${r.changed === false ? " (NO CHANGE)" : ""}` };
    }

    case "set_mixer": {
      const r = await live.call("set_mixer", input);
      if (input.volume != null) noteEdit(input.track); // level changes must be heard too
      const bits = [];
      if (input.volume != null) bits.push(`vol ${input.volume.toFixed(2)}`);
      if (input.pan != null) bits.push(`pan ${input.pan}`);
      if (input.mute != null) bits.push(input.mute ? "mute" : "unmute");
      if (input.solo != null) bits.push(input.solo ? "solo" : "unsolo");
      return { result: r, label: "Adjusting mixer", detail: `track ${input.track}: ${bits.join(", ")}` };
    }

    case "set_eq_band": {
      const { params } = await live.call("list_params", { track: input.track, device: input.device });
      const b = input.band;
      const applied = {}, warnings = [];
      const setIf = async (val, needles, key) => {
        if (val == null) return;
        const pi = findParam(params, needles.map((n) => `${b} ${n}`).concat(needles));
        if (pi < 0) { warnings.push(`no '${needles[0]}' for band ${b}`); return; }
        await live.call("set_param", { track: input.track, device: input.device, param: pi, value: val });
        applied[key] = val;
      };
      await setIf(input.freq, ["frequency", "freq"], "freq");
      await setIf(input.gain, ["gain"], "gain");
      await setIf(input.q, ["resonance", "q"], "q");
      if (input.on != null) await setIf(input.on ? 1 : 0, ["filter on", "on"], "on");
      if (Object.keys(applied).length) fxConfiguredMatch(input.track, /eq/i);
      const eqNudge = Object.keys(applied).length ? noteEdit(input.track) : null;
      return { result: { band: b, applied, warnings, ...(eqNudge ? { listenCheck: eqNudge } : {}) }, label: "EQ band", detail: `band ${b}` };
    }

    case "set_compressor": {
      const { params } = await live.call("list_params", { track: input.track, device: input.device });
      const map = [
        ["threshold", input.threshold, ["threshold"]],
        ["ratio", input.ratio, ["ratio"]],
        ["attack", input.attack, ["attack"]],
        ["release", input.release, ["release"]],
        ["makeup", input.makeup, ["makeup", "output gain", "gain"]],
        ["dry_wet", input.dry_wet, ["dry/wet", "dry", "amount"]],
      ];
      const applied = {}, warnings = [];
      for (const [key, val, needles] of map) {
        if (val == null) continue;
        const pi = findParam(params, needles);
        if (pi < 0) { warnings.push(`no '${needles[0]}' param`); continue; }
        await live.call("set_param", { track: input.track, device: input.device, param: pi, value: val });
        applied[key] = val;
      }
      if (Object.keys(applied).length) fxConfiguredMatch(input.track, /comp|glue|limit/i);
      const compNudge = Object.keys(applied).length ? noteEdit(input.track) : null;
      return { result: { applied, warnings, ...(compNudge ? { listenCheck: compNudge } : {}) }, label: "Compressor", detail: Object.keys(applied).join(", ") };
    }

    case "list_browser": {
      try {
        const r = await remoteClient.list(input.category ?? "instruments", input.limit ?? 300, input.filter);
        return { result: r, label: "Browsing library", detail: (input.category ?? "instruments") + (input.filter ? ` ~"${input.filter}"` : "") };
      } catch (e) {
        return { result: await live.call("list_browser", { category: input.category ?? "instruments", limit: input.limit ?? 300, depth: input.depth ?? 3 }), label: "Listing library", detail: input.category ?? "instruments" };
      }
    }

    case "load_instrument": {
      try {
        const r = await remoteClient.load("instrument", input.track, input.description);
        if (r.ok && r.added) patchTouched.set(input.track, false); // fresh instrument = default patch until designed
        const detail = r.ok ? (r.loaded || input.description) : (r.hint ? `${r.error || "not found"} — ${r.hint}` : (r.error || "not found"));
        // fire-and-forget the memory note so it never adds latency to the load
        if (r.ok) { remoteClient.tracks().then((tr) => { const nm = tr && tr.ok && tr.tracks[input.track] ? tr.tracks[input.track].name : null; if (nm) projectMemory.remember({ track: nm, note: `loaded ${r.loaded || input.description} on ${nm}` }).catch(() => {}); }).catch(() => {}); }
        return { result: r, label: "Loading instrument", detail };
      } catch (e) {
        const r = await live.call("find_and_load", { track: input.track, description: input.description, kind: "instrument" });
        if (r && r.loaded && typeof r.loaded === "object") r.loaded = r.loaded.name || JSON.stringify(r.loaded); // never "[object Object]"
        return { result: r, label: "Loading instrument", detail: (r && r.loaded) || input.description };
      }
    }

    case "load_audio_effect": {
      // DOUBLE-LOAD GUARD: "add Buster SE and Pro-L 2" must never end up as four
      // devices. If a same-named device is already on the chain, report it instead
      // of loading a second copy (allow_duplicate:true opts out for staged chains).
      const wantNorm = String(input.description || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (wantNorm && !input.allow_duplicate && !/claudemeter/.test(wantNorm)) {
        try {
          const tr = await remoteClient.track(input.track);
          const hit = (tr && tr.devices || []).find((d) => {
            const have = String(d).toLowerCase().replace(/[^a-z0-9]+/g, "");
            return have && (have === wantNorm || have.includes(wantNorm) || wantNorm.includes(have));
          });
          if (hit) {
            return { result: { ok: true, alreadyLoaded: true, device: String(hit), note: `'${hit}' is ALREADY on this track — not loading a second copy. It's loaded; configure/tune it instead. Pass allow_duplicate:true only if the user explicitly wants two stages.` },
              label: "Adding effect", detail: `${hit} already on track — skipped duplicate` };
          }
        } catch (e) { /* loader off / track unreadable — fall through to the normal load */ }
      }
      try {
        const r = await remoteClient.load("audioEffect", input.track, input.description);
        if (r.ok && r.added && !/claude\s*meter/i.test(String(r.loaded))) fxLoadedAt(input.track, r.loaded);
        // the loader now shoves the meter last SYNCHRONOUSLY inside the load op;
        // this async pass stays as a safety net for older remote scripts
        remoteClient.fixMeters().catch(() => {});
        return { result: r, label: "Adding effect", detail: r.ok ? (r.loaded || input.description) : (r.error || "not found") };
      } catch (e) {
        return { result: await live.call("find_and_load", { track: input.track, description: input.description, kind: "audioEffect" }), label: "Adding effect", detail: input.description };
      }
    }

    case "load_sound": {
      try {
        const r = await remoteClient.loadSound(input.track, input.name);
        return { result: r, label: "Dragging in sound", detail: r.ok ? (r.loaded || input.name) : (r.error || "not found") };
      } catch (e) {
        return { result: { ok: false, error: "Loader not running — enable the Claude_Copilot control surface, then I can drag in loops/samples." }, label: "Dragging in sound", detail: "loader offline" };
      }
    }

    case "record_master": {
      try {
        const r = await remoteClient.recordMaster(input.bars ?? 4);
        return { result: r, label: "Recording master", detail: r.ok ? `${input.bars ?? 4} bars` : (r.error || "failed") };
      } catch (e) {
        return { result: { ok: false, error: "Loader not running — enable the Claude_Copilot control surface to record the master." }, label: "Recording master", detail: "loader offline" };
      }
    }

    case "stop_record": {
      try {
        const r = await remoteClient.stopRecord();
        return { result: r, label: "Stopping recording", detail: r.ok ? "stopped" : (r.error || "failed") };
      } catch (e) {
        return { result: { ok: false, error: "Loader not running." }, label: "Stopping recording", detail: "loader offline" };
      }
    }

    case "write_chords": {
      let chordsIn = input.preset && PROG_PRESETS[input.preset] ? PROG_PRESETS[input.preset] : input.chords;
      if (!chordsIn || !chordsIn.length) chordsIn = ["I", "V", "vi", "IV"];
      const human = input.humanize !== false;
      let notes = chords.writeProgression(input.key ?? "C", input.mode ?? "major", chordsIn, {
        beatsPerChord: input.beats_per_chord ?? 4, octave: input.octave ?? 3, voicing: input.voicing ?? "spread",
        sevenths: !!input.sevenths, enrich: input.enrich !== false, enrichLevel: input.enrich_level ?? 1,
        voiceLeading: input.voice_leading !== false, velocity: input.velocity ?? 90,
        // timing humanize stays OFF (notes clean on the grid); humanize only nudges velocity.
        // Opt in to timing feel explicitly via humanize_timing (beats).
        humanizeTiming: input.humanize_timing ?? 0, humanizeVelocity: human ? 8 : 0,
      });
      // GENRE RHYTHM: held = sustained pads; offbeat/stabs = short rhythmic hits (the
      // right feel for house/tech-house/garage — whole-note pads are wrong there)
      const rhythmName = input.rhythm || "held";
      if (rhythmName !== "held") {
        const bpc = input.beats_per_chord ?? 4;
        const PAT = {
          offbeat: { on: [0.5, 1.5, 2.5, 3.5], dur: 0.22 },                          // classic house stabs on the &s
          stabs8: { on: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], dur: 0.18 },               // driving 8ths
          stabs16: { on: Array.from({ length: 16 }, (_, i) => i * 0.25), dur: 0.12 }, // 16th chops
          push: { on: [0, 1.75, 2.5, 3.5], dur: 0.3 },                               // syncopated push
        }[rhythmName];
        if (PAT) {
          const byChord = new Map();
          for (const n of notes) { const ci = Math.floor(n.start / bpc + 1e-6); if (!byChord.has(ci)) byChord.set(ci, []); byChord.get(ci).push(n); }
          const out = [];
          for (const [ci, ch] of byChord) for (const on of PAT.on) {
            if (on >= bpc) continue;
            for (const n of ch) out.push({ ...n, start: ci * bpc + on, duration: PAT.dur, velocity: Math.max(1, Math.min(127, n.velocity - (on % 1 !== 0 ? 0 : 10))) });
          }
          notes = out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
        }
      }
      if (input.swing) notes = groove.applySwing(notes, input.swing); // exact off-8th swing on a 1-beat step
      const lengthBeats = chordsIn.length * (input.beats_per_chord ?? 4); // structural, not jitter-affected
      const r = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats, notes, overwrite: input.overwrite !== false, name: `${input.key ?? "C"} ${input.mode ?? "major"}` });
      noteEdit(input.track); // new material = a sound change the agent must HEAR before finishing
      return { result: { ...r, length_beats: lengthBeats, rhythm: rhythmName, enriched: input.enrich !== false }, label: "Writing chords",
        detail: (chordsIn || []).map((c) => (typeof c === "string" ? c : c.root)).join(" – ") + (rhythmName !== "held" ? ` (${rhythmName})` : "") };
    }

    case "write_melody": {
      let notes, lenInfo;
      if (input.chords && input.chords.length) {
        // PREFERRED: motif-based hook over the chord progression (real musical logic)
        const seed = input.seed != null ? input.seed : (melodySeq++);
        notes = melody.generateMelody(input.key ?? "C", input.mode ?? "major", input.chords, { octave: input.octave ?? 4, beatsPerChord: input.beats_per_chord ?? 4, seed, velocity: input.velocity ?? 100 });
        if (input.swing) notes = groove.applySwing(notes, input.swing);
        lenInfo = `${notes.length}-note hook over ${input.chords.length} chords`;
      } else if (input.degrees && input.degrees.length) {
        let rhythm = input.rhythm ?? 1;
        if (typeof rhythm === "string") rhythm = groove.MELODY_RHYTHMS[rhythm] || 1;
        notes = chords.writeMelody(input.key ?? "C", input.mode ?? "major", input.degrees, { rhythm, octave: input.octave ?? 4, velocity: input.velocity ?? 100, humanizeTiming: input.humanize_timing ?? 0, humanizeVelocity: 8 });
        if (input.swing) notes = groove.applySwing(notes, input.swing);
        lenInfo = `${input.degrees.length} notes`;
      } else {
        return { result: { ok: false, error: "give me either `chords` (recommended — I'll build a hook) or `degrees`." }, label: "Writing melody", detail: "need chords or degrees" };
      }
      const lengthBeats = input.chords ? input.chords.length * (input.beats_per_chord ?? 4) : clipLengthBeats(notes);
      const r = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats, notes, overwrite: input.overwrite !== false, name: "melody" });
      noteEdit(input.track);
      return { result: { ...r }, label: "Writing melody", detail: lenInfo };
    }

    case "write_bassline": {
      // rotating seed (like write_drums): "another bassline" actually gives a new groove
      const seed = input.seed != null ? input.seed : (bassSeq++);
      const notes = groove.writeBassline(input.key ?? "C", input.mode ?? "minor", input.chords, {
        style: input.style ?? "offbeat", beatsPerChord: input.beats_per_chord ?? 4, octave: input.octave ?? 1,
        swing: input.swing ?? 0, velocity: input.velocity ?? 105, seed, // 0 swing = dead on the grid; only swing if explicitly asked
      });
      const lengthBeats = input.chords.length * (input.beats_per_chord ?? 4); // structural
      const r = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats, notes, overwrite: input.overwrite !== false, name: `bass ${input.style ?? "offbeat"}` });
      noteEdit(input.track);
      const pitchCount = new Set(notes.map((n) => n.pitch)).size;
      // bar-1 preview so the agent can sanity-check the groove SHAPE without guessing:
      // sixteenth grid, "." = rest, R = chord root, O = octave, x = other tone
      const root = notes.length ? notes[0].pitch : 0;
      const grid = Array(16).fill(".");
      for (const n of notes) { if (n.start < 4) { const ix = Math.round(n.start * 4); if (ix >= 0 && ix < 16 && grid[ix] === ".") grid[ix] = n.pitch === root ? "R" : n.pitch === root + 12 ? "O" : "x"; } }
      const preview = grid.join("").replace(/(.{4})/g, "$1 ").trim();
      return { result: { ...r, style: input.style ?? "offbeat", seed, distinctPitches: pitchCount, notes: notes.length, bar1: preview,
        note: "bar1 shows the groove on a 16th grid (R root, O octave, x other, . rest) — a solid wall of same-letter 8ths means regenerate. AUDITION the track next." },
        label: "Writing bassline", detail: `${input.style ?? "offbeat"} — variation ${seed}, ${notes.length} notes, ${pitchCount} pitches · ${preview}` };
    }

    case "write_drums": {
      // rotating seed so repeated calls give DIFFERENT beats (unless a seed is pinned)
      const seed = input.seed != null ? input.seed : (drumSeq++);
      const d = drums.generateDrums(input.genre ?? "house", { bars: input.bars ?? 2, fill: input.fill !== false, intensity: input.intensity ?? 1, seed, swing: input.swing ?? 0 });
      const r = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats: (input.bars ?? 2) * 4, notes: d.notes, overwrite: input.overwrite !== false, name: `${d.genre} beat` });
      noteEdit(input.track);
      return { result: { ...r, genre: d.genre, variation: d.variant + 1, bars: d.bars, hits: d.notes.length }, label: "Writing drums", detail: `${d.genre} — variation ${d.variant + 1}, ${d.notes.length} hits` };
    }

    case "write_notes": {
      // SNAP every hand-placed note to a clean 1/24 grid so nothing lands slightly off the
      // beat (removes sub-1/24 jitter; preserves real 16ths and triplets). No swing here.
      const SNAP = 1 / 24, snap = (x) => Math.round((x ?? 0) / SNAP) * SNAP;
      const notes = input.notes.map((n) => ({ pitch: n.pitch, start: snap(n.start), duration: Math.max(SNAP, snap(n.duration)), velocity: n.velocity ?? 100, mute: 0 }));
      const lengthBeats = input.length_bars ? input.length_bars * 4 : clipLengthBeats(notes);
      const r = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats, notes, overwrite: input.overwrite !== false, name: "clip" });
      noteEdit(input.track);
      return { result: { ...r }, label: "Writing notes", detail: `${notes.length} notes` };
    }

    case "clear_clip":
      return { result: await live.call("clear_notes", { track: input.track, slot: input.slot ?? 0 }), label: "Clearing clip", detail: `track ${input.track}` };

    case "fire_clip":
      return { result: await live.call("fire_clip", { track: input.track, slot: input.slot ?? 0 }), label: "Launching clip", detail: `track ${input.track}` };

    case "transport": {
      const args = {};
      if (input.action === "start") args.play = true;
      if (input.action === "continue") args.resume = true; // resume from position, don't restart
      if (input.action === "stop") args.stop = true;
      if (input.bpm) args.tempo = input.bpm;
      return { result: await live.call("set_transport", args), label: "Transport", detail: input.action || (input.bpm ? `${input.bpm} bpm` : "") };
    }

    case "create_track":
      return { result: await live.call("create_track", { type: input.type, name: input.name }), label: "Creating track", detail: `${input.type}${input.name ? " · " + input.name : ""}` };

    case "device_onoff":
      return { result: await live.call("device_onoff", input), label: input.on ? "Device on" : "Device off", detail: `t${input.track} d${input.device}` };
    case "delete_device":
      return { result: await live.call("delete_device", input), label: "Deleting device", detail: `t${input.track} d${input.device}` };
    case "duplicate_track":
      return { result: await live.call("duplicate_track", input), label: "Duplicating track", detail: `track ${input.track}` };
    case "delete_track":
      return { result: await live.call("delete_track", input), label: "Deleting track", detail: `track ${input.track}` };
    case "rename_track":
      return { result: await live.call("rename_track", input), label: "Renaming track", detail: input.name };
    case "set_track_color":
      return { result: await live.call("set_track_color", input), label: "Track color", detail: `track ${input.track}` };
    case "duplicate_clip":
      return { result: await live.call("duplicate_clip", { track: input.track, slot: input.slot ?? 0 }), label: "Duplicating clip", detail: `track ${input.track}` };
    case "set_clip":
      return { result: await live.call("set_clip", { ...input, slot: input.slot ?? 0 }), label: "Clip settings", detail: `track ${input.track}` };
    case "quantize_clip":
      return { result: await live.call("quantize_clip", { track: input.track, slot: input.slot ?? 0, grid: input.grid ?? 5, amount: input.amount ?? 1 }), label: "Quantizing", detail: `track ${input.track}` };
    case "create_scene":
      return { result: await live.call("create_scene", { index: input.index }), label: "Creating scene" };
    case "fire_scene":
      return { result: await live.call("fire_scene", { scene: input.scene }), label: "Launching scene", detail: `scene ${input.scene}` };
    case "set_master":
      return { result: await live.call("set_master", { target: input.target ?? "master", volume: input.volume, pan: input.pan }), label: "Master/return", detail: input.volume != null ? `vol ${input.volume}` : "" };
    case "capture_midi":
      return { result: await live.call("capture_midi", { destination: input.destination ?? 1 }), label: "Capturing MIDI" };
    case "undo":
      return { result: await live.call("undo"), label: "Undo" };
    case "redo":
      return { result: await live.call("redo"), label: "Redo" };
    case "arrange_clip":
      return { result: await live.call("arrange_clip", { track: input.track, slot: input.slot ?? 0, times: input.times, time: input.time }), label: "Arranging timeline", detail: `track ${input.track}` };

    case "reset_key_detection":
      return { result: await live.call("reset_pitch_histogram"), label: "Listening reset", detail: "play the vocal now" };

    case "debug_browser":
      return { result: await live.call("debug_browser"), label: "Probing browser" };

    case "review_mix": {
      // Like a producer: listen to the master + every track, and hand back each track's
      // actual audio next to what it was SUPPOSED to be (from memory), so the agent can
      // verify "does this sound the way I was instructed?".
      // SELF-SETTING-UP: reviewing auto-places ClaudeMeters on any unmetered track
      // (incl. returns + master) and shoves every meter to the END of its chain — the
      // listening pass never depends on someone remembering setup.
      try { await dispatchInner("place_meters", {}, { live }); } catch (e) { try { await remoteClient.fixMeters(); } catch (e2) {} }
      heard(); // a full review counts as hearing everything — reset the listen gate
      const peaks = new Map(); let master = null, isPlaying = false, samples = 0;
      for (let k = 0; k < 6; k++) {
        try {
          const m = await remoteClient.meters();
          if (m && m.ok) { samples++; isPlaying = m.isPlaying; for (const t of (m.tracks || [])) { const p = peaks.get(t.track); if (!p || t.peakDb > p.peakDb) peaks.set(t.track, t); } if (m.master && (!master || (m.master.peakDb ?? -99) > (master.peakDb ?? -99))) master = m.master; }
        } catch (e) {}
        if (k < 5) await new Promise((r) => setTimeout(r, 180));
      }
      let liveTracks = [], liveReturns = [];
      try { const t = await remoteClient.tracks(); if (t && t.ok) { liveTracks = t.tracks; liveReturns = t.returns || []; } } catch (e) {}
      let chains = null; // full device chains incl. plugin controllability + order
      try { const c = await remoteClient.chains(); if (c && c.ok) chains = c; } catch (e) {}
      let mem = { direction: {}, tracks: {} };
      try { mem = projectMemory.load(await projectMemory.projectKey()); } catch (e) {}
      const toRow = (t) => {
        const lvl = peaks.get(t.index) || {};
        const note = mem.tracks[String(t.name)] || {};
        const sp = meterStore.get(t.index);
        const act = meterStore.activity(t.index);
        const peakDb = lvl.peakDb ?? -90;
        const chain = chains && (chains.tracks || []).find((c) => c.track === t.index);
        return {
          track: t.index, name: t.name, role: note.role, target: note.sound,
          audible: peakDb > -48, peakDb, rmsDb: lvl.rmsDb ?? -90,
          character: sp && sp.character ? sp.character.summary : undefined, // what it SOUNDS like (ClaudeMeter)
          playsAt: act ? act.bars + " (observed to bar " + act.observedUpToBar + ")" : undefined, // WHEN in the song it plays
          defaultPatch: patchTouched.get(t.index) === false || undefined,   // loaded but never designed!
          devices: chain ? chain.devices.map((d) => d.name + (d.plugin && !d.controllable ? " ⚠needs-Configure" : "")) : undefined,
          spectral: sp || undefined,
        };
      };
      const rows = liveTracks.map(toRow);
      // RETURN busses listen too (a return with no signal isn't "silent" — sends may
      // simply be down), so they're reported separately and excluded from problem rows
      const returnRows = liveReturns.map((t) => ({ ...toRow(t), isReturn: true }));
      // master spectral character from a ClaudeMeter on the master (index -1)
      const masterSp = meterStore.get(-1);
      if (master && masterSp) { master.spectral = masterSp; master.character = masterSp.character ? masterSp.character.summary : undefined; }
      const silent = rows.filter((r) => !r.audible).map((r) => r.name);
      const untouched = rows.filter((r) => r.defaultPatch).map((r) => r.name);
      const masterClip = master && master.peakDb != null && master.peakDb > -0.5;
      const masterDevices = (master && master.devices) || [];
      const hasLimiter = masterDevices.some((d) => /limit/i.test(String(d)));
      // effects loaded but never dialed in — a flat EQ / default Utility does NOTHING
      const fxFlat = [];
      for (const [tk, names] of fxUntouched) if (names.length) fxFlat.push((tk === -1 ? "master" : ((liveTracks.find((t) => t.index === tk) || {}).name || ("track " + tk))) + ": " + names.join(", "));
      const problems = [];
      if (silent.length) problems.push("SILENT (no sound — fix first): " + silent.join(", "));
      if (untouched.length) problems.push("DEFAULT PATCH (instrument loaded but never designed — finish them): " + untouched.join(", "));
      if (fxFlat.length) problems.push("UNCONFIGURED EFFECTS (loaded but left on defaults — dial them in or delete them): " + fxFlat.join(" | "));
      if (masterClip) problems.push("MASTER CLIPPING (>0 dBFS) — pull it down");
      if (isPlaying && !hasLimiter) problems.push("master has NO LIMITER — add master processing (load_audio_effect track:-1: light Glue Compressor, then Limiter last)");
      // plugin controllability + chain order (from the chains snapshot)
      if (chains && (chains.configureNeeded || []).length) {
        problems.push("UNCONTROLLABLE PLUG-INS (no knobs exposed to Live — give the user the Configure steps, don't pretend to edit them): " +
          chains.configureNeeded.map((n) => `'${n.trackName}': ${n.device}`).join(", "));
      }
      if (chains && chains.master && chains.master.devices) {
        const real = chains.master.devices.filter((d) => !/claude\s*meter/i.test(d.name)); // the meter is analysis, not processing
        const li = real.map((d) => /limit/i.test(d.name)).lastIndexOf(true);
        // each chain row carries its OWN device index — never re-derive it by name
        // (duplicate device names would point move_device at the wrong slot)
        if (li >= 0 && li !== real.length - 1) problems.push(`MASTER CHAIN ORDER: '${real[li].name}' is not last — processing after the limiter defeats it (move_device track:-1 device:${real[li].index} to:${chains.master.devices.length - 1})`);
        const eqAfterLimit = li >= 0 && real.slice(li + 1).some((d) => /eq/i.test(d.name));
        if (eqAfterLimit) problems.push("MASTER CHAIN ORDER: an EQ sits AFTER the limiter — move it before");
      }
      // accidental double-loads (the same plugin twice on one chain) — a real failure
      // mode: "add Buster SE + Pro-L 2" once ended up as FOUR devices on the master
      if (chains) {
        const dupes = [];
        for (const row of [...(chains.tracks || []), ...(chains.master ? [chains.master] : [])]) {
          const counts = {};
          for (const d of row.devices || []) { if (/claude\s*meter/i.test(d.name)) continue; counts[d.name] = (counts[d.name] || 0) + 1; }
          for (const [nm, c] of Object.entries(counts)) if (c > 1) dupes.push(`'${row.name}': ${nm} ×${c}`);
        }
        if (dupes.length) problems.push("DUPLICATE DEVICES (almost always an accidental double-load — delete_device the extra copies unless the user explicitly wants staged processing): " + dupes.join(", "));
      }
      const note = !samples ? "Loader off — can't read meters."
        : !isPlaying ? "Nothing is playing — press play (or fire a scene) so I can hear the full mix, then review again."
        : (problems.length ? "PROBLEMS → fix these, then review_mix AGAIN (recursive listening — don't stop after one pass): " + problems.join(" | ")
           : "No structural problems. Now judge each track's 'character' against its target and refine.");
      return { result: { direction: mem.direction, master: { ...master, hasLimiter }, isPlaying, masterClipping: masterClip, silent, defaultPatches: untouched, unconfiguredFx: fxFlat, problems, tracks: rows, returns: returnRows, configureHelp: chains && (chains.configureNeeded || []).length ? chains.configureHelp : undefined, note }, label: "Reviewing the mix", detail: `${rows.length} tracks${returnRows.length ? `+${returnRows.length} returns` : ""}${master ? `, master ${master.peakDb}dB` : ""}${silent.length ? `, ${silent.length} silent!` : ""}${untouched.length ? `, ${untouched.length} default-patch!` : ""}${fxFlat.length ? `, flat FX!` : ""}` };
    }

    case "get_mix_snapshot": {
      try { await remoteClient.fixMeters(); } catch (e) {} // meters must sit LAST to hear post-FX
      const spectral = meterStore.all();             // M4L FFT/loudness data, if any meters placed
      let levels = null, master = null, isPlaying = false, samples = 0;
      try {
        const peaks = new Map(); let mPeak = null;
        for (let k = 0; k < 5; k++) {                // sample for a stable PEAK while audio plays
          const m = await remoteClient.meters();
          if (m && m.ok) {
            samples++; isPlaying = m.isPlaying;
            for (const t of (m.tracks || [])) { const prev = peaks.get(t.track); if (!prev || t.peakDb > prev.peakDb) peaks.set(t.track, t); }
            if (m.master && (!mPeak || (m.master.peakDb ?? -99) > (mPeak.peakDb ?? -99))) mPeak = m.master;
          }
          if (k < 4) await new Promise((r) => setTimeout(r, 150));
        }
        if (samples) { levels = [...peaks.values()].sort((a, b) => a.track - b.track); master = mPeak; }
      } catch (e) { /* loader offline — fall back to spectral only */ }
      // spread order matters: FRESH live levels (l) must win over the meter snapshot's
      // own peak/rms; only the bands/character come from the spectral entry. levels
      // now include RETURN busses too (track -2-r); master spectral merges below (-1).
      const merged = (levels || []).map((l) => { const sp = spectral.find((s) => s.track === l.track); return sp ? { ...sp, ...l, bands: sp.bands, character: sp.character, track: l.track } : l; });
      // loader-off fallback = ClaudeMeter data only — keep the same shape as the
      // loader-on path: master (-1) goes in `master`, never in the track rows
      let rows = merged.length ? merged : spectral.filter((s) => s.track !== -1).map((s) => (s.track <= -2 ? { ...s, isReturn: true } : s));
      const masterSp = meterStore.get(-1);
      if (master && masterSp) master = { ...master, bands: masterSp.bands, character: masterSp.character };
      else if (!master && masterSp) master = masterSp;
      const note = !levels && !spectral.length ? "Can't read meters — is the Claude_Copilot loader enabled?" : (levels && !isPlaying ? "Nothing is playing — press play so I can hear the levels." : undefined);
      return { result: { tracks: rows, master, isPlaying, count: rows.length, note }, label: "Reading the mix", detail: `${rows.length} tracks${master ? `, master ${master.peakDb}dB` : ""}` };
    }
    case "get_track_audio": {
      try { await remoteClient.fixMeters(); } catch (e) {} // meter must sit LAST to hear post-FX
      const spectral = meterStore.get(input.track);
      let level = null, isPlaying = false;
      try {
        let best = null;
        for (let k = 0; k < 5; k++) {
          const m = await remoteClient.meters();
          if (m && m.ok) {
            isPlaying = m.isPlaying;
            // the master lives in the separate `master` key (track -1), not in tracks[]
            const t = input.track === -1 ? m.master : (m.tracks || []).find((x) => x.track === input.track);
            if (t && (!best || t.peakDb > best.peakDb)) best = t;
          }
          if (k < 4) await new Promise((r) => setTimeout(r, 150));
        }
        level = best;
      } catch (e) { /* loader offline */ }
      heard(input.track); // listening resets the edit-without-hearing counter
      const res = { track: input.track, ...(spectral || {}), ...(level || {}) };
      const act = meterStore.activity(input.track);
      if (act) res.playsAt = act.bars + " (observed to bar " + act.observedUpToBar + ")";
      if (!level && !spectral) { res.none = true; res.note = "Couldn't read this track's meter (is the loader enabled?)."; }
      else if (level && !isPlaying) res.note = "Nothing is playing — start playback so I can hear it.";
      return { result: res, label: "Hearing track", detail: `#${input.track}${level ? ` ${level.peakDb}dB` : ""}` };
    }
    case "device_skill": {
      const out = {};
      let detail = input.device || input.character || input.genre || "";
      // device skill doc
      if (input.device) {
        const s = deviceSkills.getSkill(input.device);
        out.device = s ? { name: s.device, skill: s.skill } : { found: false, available: deviceSkills.list(), note: "No skill doc for that device — call get_device_params to read its actual parameters and tweak from those names." };
      }
      // character word -> ordered param moves
      if (input.character) {
        const c = deviceSkills.getCharacter(input.character);
        out.character = c ? { word: c.word, ...c.recipe } : { found: false, available: deviceSkills.listCharacters(), note: "No recipe for that character word — pick the closest one or web_search the technique." };
      }
      // genre -> palette
      if (input.genre) {
        const g = deviceSkills.getGenre(input.genre);
        out.genre = g ? { name: g.genre, ...g.palette } : { found: false, available: deviceSkills.listGenres(), note: "No palette for that genre — web_search the genre's signature sounds." };
      }
      // nothing asked: hand back the menus so Claude knows what's available
      if (!input.device && !input.character && !input.genre) {
        out.available = { devices: deviceSkills.list(), characters: deviceSkills.listCharacters(), genres: deviceSkills.listGenres() };
        detail = "menu";
      }
      out.note = "These are RESEARCHED starting points. Read the device's real params (get_device_params/dump_device), clamp to min/max, then set. web_search to confirm exact values for a specific reference if unsure.";
      return { result: out, label: "Reading skill", detail };
    }
    case "analyze_clip": {
      // Full audio-file FFT analysis of an existing AUDIO clip — non-destructive, no
      // recording: read the clip's sample off disk and run the real spectral analyzer.
      const slot = input.slot ?? 0;
      let file = null;
      try { const r = await remoteClient.lomGet(["tracks", input.track, "clip_slots", slot, "clip"], "file_path"); if (r && r.ok) file = r.value; } catch (e) {}
      if (!file) return { result: { ok: false, error: "No audio file on track " + input.track + " slot " + slot + " — it's empty or a MIDI clip (MIDI has no waveform). To analyse a synth, record it to audio first." }, label: "Analysing audio", detail: "no audio file" };
      if (!fs.existsSync(file)) return { result: { ok: false, error: "clip references a file that isn't on disk: " + file }, label: "Analysing audio", detail: "file missing" };
      let prof;
      try { prof = spectral.analyzeWavBuffer(fs.readFileSync(file)); } catch (e) { return { result: { ok: false, error: "couldn't analyse the audio: " + (e.message || e) }, label: "Analysing audio", detail: "decode failed" }; }
      let tuning = null;
      try { tuning = songKey.tuningInfo(prof.fundamentalHz, await songKey.detect()); } catch (e) {}
      return { result: { ok: true, file: path.basename(file), ...prof, tuning }, label: "Analysing audio (full spectrum)", detail: prof.summary + (tuning && tuning.inTune === false ? " · OUT OF TUNE: " + tuning.fix : "") };
    }

    case "audition": {
      const track = input.track, slot = input.slot ?? 0;
      // NON-DESTRUCTIVE: ensure a ClaudeMeter at the END of the chain, play the existing
      // clip, read the meter (loudness + spectrum if it reports). NO solo, NO record, NO
      // arm — it can NEVER leave the track muted/soloed/recording. Was the no-sound bug.
      let metered = false;
      try {
        const tr = await remoteClient.track(track);
        const has = (tr.devices || []).some((d) => /claude\s*meter/i.test(String(d)));
        metered = has ? true : !!((await remoteClient.load("audioEffect", track, "Claude Meter")) || {}).ok;
        await remoteClient.fixMeters(); // hear POST-fx: the meter must sit LAST in the chain
      } catch (e) {}
      const wasPlaying = await (async () => { try { const s = await remoteClient.session(); return !!(s && s.isPlaying); } catch { return false; } })();
      try { await live.call("fire_clip", { track, slot }); } catch (e) {}
      let peakDb = -90, rmsDb = -90, isPlaying = false, spec = null;
      for (let k = 0; k < 6; k++) {
        try { const m = await remoteClient.meters(); if (m && m.ok) { isPlaying = m.isPlaying; const t = (m.tracks || []).find((x) => x.track === track); if (t) { if (t.peakDb > peakDb) peakDb = t.peakDb; if (t.rmsDb > rmsDb) rmsDb = t.rmsDb; } } } catch (e) {}
        const sp = meterStore.get(track); if (sp) spec = sp;
        if (k < 5) await new Promise((r) => setTimeout(r, 200));
      }
      if (!wasPlaying) { try { await live.call("set_transport", { stop: true }); } catch (e) {} } // restore: don't leave it playing if it wasn't
      heard(track); // listening resets the edit-without-hearing counter
      const audible = peakDb > -48;
      const tooQuiet = audible && peakDb < -26; // hearable in solo but buried in any mix
      const note = !metered ? "Couldn't place a ClaudeMeter (loader off?) — no analysis."
        : !audible ? "NO/low signal on this track — check there's an instrument loaded AND notes in the clip AND the track isn't muted. Don't claim a sound exists if it's silent."
        : tooQuiet ? `AUDIBLE BUT WAY TOO LOW (peak ${Math.round(peakDb)} dB) — a real element sits around -8…-16 dB. Raise the track volume (set_mixer) or the instrument/patch output, then audition AGAIN. Do NOT deliver it at this level.`
        : (spec ? "" : "Loudness only (ClaudeMeter not reporting spectrum yet).");
      return { result: { track, metered, audible, tooQuiet: tooQuiet || undefined, peakDb: Math.round(peakDb * 10) / 10, rmsDb: Math.round(rmsDb * 10) / 10, spectral: spec, note }, label: "Auditioning", detail: `#${track} ${Math.round(peakDb)}dB ${!audible ? "(silent!)" : tooQuiet ? "(too low!)" : ""}` };
    }
    case "custom_skill": {
      if (input.name && input.delete_skill) {
        const r = customSkills.remove(input.name);
        return { result: r, label: "User skill", detail: r.ok ? `deleted '${r.name}'` : (r.error || "failed") };
      }
      if (input.name && input.content != null) {
        const r = customSkills.save(input.name, input.content);
        return { result: r, label: "User skill", detail: r.ok ? `saved '${r.name}'` : (r.error || "failed") };
      }
      if (input.name) {
        const s = customSkills.get(input.name);
        if (s) return { result: { ok: true, ...s, note: "This is the USER'S OWN skill — it outranks built-in skills where they conflict." }, label: "User skill", detail: s.name };
        return { result: { ok: false, known: customSkills.list().map((x) => x.name), error: "no skill matching '" + input.name + "'" }, label: "User skill", detail: "not found" };
      }
      const all = customSkills.list();
      return { result: { ok: true, skills: all, note: all.length ? "read one with custom_skill{name}" : "none yet — the user can add them in ⚙ → Skills, or you can save one when asked to remember a way of working" }, label: "User skills", detail: `${all.length} skill(s)` };
    }

    case "set_modulation": {
      try {
        const r = await remoteClient.wtMod(input.track, input.device, input.target ?? null, input.source ?? null, input.amount ?? null);
        if (r && r.ok && r.changed) { patchTouched.set(input.track, true); const nudge = noteEdit(input.track); if (nudge) r.listenCheck = nudge; }
        const detail = r && r.ok
          ? (r.targets && !input.target ? `${r.targets.length} targets, ${(r.sources || []).length} sources`
            : r.after !== undefined ? `${r.source}→${r.target}: ${r.before}→${r.after}${r.changed === false ? " (NO CHANGE)" : ""}`
            : `${r.source}→${r.target} = ${r.value}`)
          : (r && r.error) || "failed";
        return { result: r, label: "Wiring mod matrix", detail };
      } catch (e) {
        return { result: { ok: false, error: "loader not running — enable the Claude_Copilot control surface." }, label: "Wiring mod matrix", detail: "loader off" };
      }
    }

    case "sound_recipe": {
      if (input.learn && typeof input.learn === "object") {
        const saved = soundLibrary.learn(input.name, input.learn);
        return { result: { ok: true, saved: true, recipe: saved, library: soundLibrary.list().length + " recipes", note: "Saved — this sound is now in the library for good." }, label: "Learning sound recipe", detail: input.name };
      }
      const r = soundLibrary.get(input.name);
      if (r) return { result: { ok: true, ...r, note: "Apply the steps in order (set_device_param / set_device_property / set_modulation), confirm changed:true each, then AUDITION." }, label: "Sound recipe", detail: r.name };
      return { result: { ok: false, known: soundLibrary.list(), note: "Not in the library yet — web_search how '" + input.name + "' is made (any synth's instructions work), TRANSLATE to Wavetable/Operator/Drift + set_modulation routings, build + audition it, then SAVE with learn." }, label: "Sound recipe", detail: "unknown — research & save" };
    }

    case "genre_skill": {
      const g = genreSkills.get(input.genre);
      if (!g) return { result: { ok: false, known: genreSkills.list(), note: "no vocabulary for that style — pick the closest from the list, or web_search '" + input.genre + " production style chords bassline' and adapt the nearest genre's recipes." }, label: "Genre vocabulary", detail: "unknown genre" };
      // the stock-device palette for this genre (which synth/kit/FX) rides along
      let palette;
      try { const p = deviceSkills.getGenre(g.genre); if (p) palette = p.palette; } catch (e) {}
      const out = input.part
        ? { ok: true, genre: g.genre, bpm: g.bpm, [input.part]: g[input.part], palette: input.part === "sound" ? palette : undefined }
        : { ok: true, genre: g.genre, bpm: g.bpm, melodies: g.melodies, bassline: g.bassline, chords: g.chords, sound: g.sound, mixmaster: g.mixmaster, palette };
      out.note = "These recipes map straight onto the tools — use the exact romans/presets/styles given, then AUDITION. The famous examples are the quality bar: if what you made wouldn't sit on a playlist next to them, iterate.";
      return { result: out, label: "Genre vocabulary", detail: g.genre + (input.part ? " · " + input.part : "") + (g.matchedFrom ? ` (from "${g.matchedFrom}")` : "") };
    }

    case "plugin_skill": {
      if (input.learn && typeof input.learn === "object") {
        const saved = pluginSkills.learn(input.plugin, input.learn);
        return { result: { ok: true, saved: true, plugin: input.plugin, doc: saved, note: "Saved — this plug-in is now known on this machine. Apply the recipe via the CONFIGURED params (get_device_params)." }, label: "Learning plugin", detail: input.plugin };
      }
      const doc = pluginSkills.get(input.plugin);
      if (doc) return { result: { ok: true, ...doc, apply: "Map these onto the CONFIGURED param names from get_device_params (fuzzy name match). If a needed control isn't configured, relay the Configure steps to the user." }, label: "Plugin skill", detail: `${input.plugin} (${doc.source})` };
      return { result: { ok: false, known: pluginSkills.listKnown(), note: "Unknown plug-in — web_search '" + input.plugin + " parameters explained' (or its manual), extract what the key controls do + 1-3 concrete recipes, then call plugin_skill again with `learn` to save it." }, label: "Plugin skill", detail: "unknown — research it" };
    }

    case "element_skill": {
      if (!input.element) {
        return { result: { elements: elementSkills.list(), note: "pass element:'kick' (etc.) for the full skill — checklist + diagnose→fix map" }, label: "Element skills", detail: "menu" };
      }
      const s = elementSkills.getElement(input.element);
      if (!s) return { result: { found: false, elements: elementSkills.list(), note: "no skill for that element — pick the closest from the list" }, label: "Element skill", detail: "not found" };
      return { result: { ok: true, ...s, note: "Listen first (audition / analyze_recordings — tuning vs the detected key comes back automatically), judge against the checklist, apply the matching fixes, re-listen." }, label: "Element skill", detail: s.element };
    }

    case "production_checklist": {
      let keyLabel = null;
      try { const sk = await songKey.detect(); keyLabel = sk && sk.label; } catch (e) {}
      return { result: { ok: true, key: keyLabel || "(unknown — write some MIDI first or set Live's scale)", order: elementSkills.CHECKLIST_ORDER, checklist: elementSkills.fullChecklist(),
        how: "Run top-to-bottom. Per element: LISTEN (audition the track / analyze_recordings rows — they carry tuning + playsAt), CRITIQUE against the element's checklist (element_skill has the diagnose→fix map), FIX with the documented moves, RE-LISTEN. Don't skip the kick tuning check." },
        label: "Production checklist", detail: `${elementSkills.CHECKLIST_ORDER.length} elements` };
    }

    case "audio_to_midi": {
      const file = String(input.path || "");
      if (!file || !fs.existsSync(file)) return { result: { ok: false, error: "file not found: " + file }, label: "Voice → MIDI", detail: "missing" };
      let decoded;
      try { decoded = await decodeAudioPath(file); } catch (e) { return { result: { ok: false, error: "couldn't decode the audio: " + String(e.message || e) }, label: "Voice → MIDI", detail: "decode failed" }; }
      let bpm = input.bpm;
      if (!bpm) { try { const s = await remoteClient.session(); if (s && s.ok) bpm = s.tempo; } catch (e) {} }
      bpm = bpm || 120;
      // WHAT WAS HEARD — always reported, success or not: "was there anything on the
      // recording at all?" must never be a mystery.
      const samples = decoded.samples, sr = decoded.sampleRate;
      let peak = 0, sumSq = 0;
      for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; sumSq += samples[i] * samples[i]; }
      const lin2db = (x) => (x > 1e-7 ? Math.round(200 * Math.log10(x)) / 10 : -120);
      const vr = audioToMidi.voicedRatio(samples, sr);
      const rawHits = audioToMidi.detectHits(samples, sr).length;
      const heardStats = {
        durationSec: Math.round((samples.length / sr) * 10) / 10,
        peakDb: lin2db(peak), rmsDb: lin2db(Math.sqrt(sumSq / Math.max(1, samples.length))),
        voicedRatio: Math.round(vr * 100) / 100, percussiveOnsets: rawHits,
        verdict: peak < 0.005 ? "essentially SILENT — nothing usable was captured"
          : vr > 0.45 ? "sustained pitched material (humming/singing)"
          : rawHits >= 4 ? "percussive material (beatbox-like hits)"
          : vr > 0.1 ? "voiced but unstable pitch — this sounds like SPEECH, not a musical performance"
          : "quiet/unclear material",
      };
      let kind = input.kind || "auto";
      if (kind === "auto") kind = vr > 0.45 ? "melody" : "drums";
      if (peak < 0.005) return { result: { ok: false, kind, heard: heardStats, error: "the recording is essentially silent (peak " + heardStats.peakDb + " dB over " + heardStats.durationSec + "s) — nothing to convert. Check the mic and record again." }, label: "Voice → MIDI", detail: "silent recording" };
      const r = kind === "drums"
        ? audioToMidi.beatboxToDrums(samples, sr, { bpm, grid: input.grid ?? 4 })
        : audioToMidi.melodyFromVoice(samples, sr, { bpm, grid: input.grid ?? 4 });
      if (!r.notes.length) return { result: { ok: false, kind, heard: heardStats, error: (r.note || "nothing detected in the recording") + " — heard: " + heardStats.verdict }, label: "Voice → MIDI", detail: "nothing detected — " + heardStats.verdict };
      if (heardStats.verdict.includes("SPEECH")) r.speechWarning = "this recording sounds like SPOKEN WORDS, not beatboxing/humming — if the user was just talking, do NOT keep this MIDI (clear the clip) and ask them to record the performance separately.";
      const w = await live.call("add_notes", { track: input.track, slot: input.slot ?? 0, lengthBeats: r.bars * 4, notes: r.notes, overwrite: true, name: kind === "drums" ? "beatboxed beat" : "hummed melody" });
      const detail = kind === "drums"
        ? `${r.notes.length} hits (${Object.entries(r.hits).map(([k, v]) => v + " " + k).join(", ")}) · ${r.bars} bar(s)${r.speechWarning ? " · ⚠ sounds like speech!" : ""}`
        : `${r.notes.length} notes · ${r.bars} bar(s)`;
      return { result: { ok: true, kind, bpm, bars: r.bars, wrote: r.notes.length, hits: r.hits, heard: heardStats, speechWarning: r.speechWarning, ...w,
        note: kind === "drums" ? "Hits map to kick=36 snare=38 hat=42 — make sure a DRUM KIT is on the track (load one that fits the genre), then fire the clip." : "Check the notes against the song key (LIVE NOW) — quantize stray pitches to the scale if the hum drifted, and put a fitting synth on the track." },
        label: "Voice → MIDI", detail };
    }

    case "remember": {
      const r = await projectMemory.remember(input);
      const bits = [];
      if (input.direction) bits.push("direction");
      if (input.track) bits.push(input.track + (input.role ? `:${input.role}` : ""));
      if (input.note) bits.push("log");
      return { result: r, label: "Remembering", detail: bits.join(", ") || "memory" };
    }
    case "recall": {
      const key = await projectMemory.projectKey();
      const mem = projectMemory.load(key);
      return { result: { ok: true, projectKey: key, direction: mem.direction, tracks: mem.tracks, log: mem.log }, label: "Recalling memory", detail: Object.keys(mem.tracks).length + " tracks" };
    }
    case "forget_project": {
      const r = await projectMemory.forget();
      return { result: r, label: "Forgetting project memory", detail: "fresh start" };
    }
    case "place_meters": {
      // use the remote snapshot (has device names) so re-runs SKIP tracks that already
      // have a meter instead of stacking duplicates. Covers the WHOLE set: every
      // regular track + every RETURN (FX bus) + the MASTER (index encoding: -1 =
      // master, -2-r = return r — same scheme as the remote script + metertrack.js).
      let targets = [];
      try {
        const tr = await remoteClient.tracks();
        if (tr && tr.ok) targets = [...(tr.tracks || []), ...(tr.returns || []), ...(tr.master ? [tr.master] : [])];
      } catch (e) {}
      // no remote snapshot = the loader is off (or hiccuped). The v8 track list has
      // no device names, so the already-metered check can't work — auto-loading from
      // it would STACK duplicate meters (two meters fight over one command queue).
      if (!targets.length) {
        return { result: { ok: false, placed: 0, error: "Can't read the device lists (Claude_Copilot loader not answering) — enable it in Live ▸ Settings ▸ Link/Tempo/MIDI ▸ Control Surface, or drop ClaudeMeter on tracks manually, then retry." }, label: "Placing meters", detail: "loader off" };
      }
      let placed = 0, skipped = 0; const failed = [];
      for (const t of targets) {
        const has = t.hasMeter || (t.devices || []).some((d) => /claude\s*meter/i.test(String(d)));
        if (has) { skipped++; continue; }
        try {
          const r = await remoteClient.load("audioEffect", t.index, "Claude Meter");
          if (r && r.ok && r.added) placed++; else failed.push(t.index);
        } catch (e) { failed.push(t.index); }
      }
      try { await remoteClient.fixMeters(); } catch (e) {} // ensure every meter sits LAST
      return { result: { placed, skipped, failed, note: failed.length ? "Couldn't auto-load on " + failed.length + " track(s). Is the Claude_Copilot remote script enabled? Otherwise drop ClaudeMeter manually." : "meters on every track, every return, and the master" }, label: "Placing meters", detail: `${placed} placed${skipped ? `, ${skipped} already metered` : ""}` };
    }

    case "get_device_chains": {
      try {
        const r = await remoteClient.chains();
        if (r && r.ok) {
          const need = r.configureNeeded || [];
          return { result: r, label: "Mapping device chains", detail: `${(r.tracks || []).length} tracks${need.length ? `, ${need.length} plugin(s) need Configure` : ""}` };
        }
        return { result: r, label: "Mapping device chains", detail: (r && r.error) || "failed" };
      } catch (e) {
        return { result: { ok: false, error: "loader not running — enable the Claude_Copilot control surface." }, label: "Mapping device chains", detail: "loader off" };
      }
    }

    case "move_device": {
      try {
        const r = await remoteClient.moveDevice(input.track, input.device, input.to);
        // any reorder can bury a ClaudeMeter mid-chain — push meters back to last
        remoteClient.fixMeters().catch(() => {});
        return { result: r, label: "Reordering chain", detail: r && r.ok ? `${r.moved} → pos ${r.to}${r.changed === false ? " (NO CHANGE)" : ""}` : (r && r.error) || "failed" };
      } catch (e) {
        return { result: { ok: false, error: "loader not running — enable the Claude_Copilot control surface." }, label: "Reordering chain", detail: "loader off" };
      }
    }

    case "record_tracks": {
      const bars = Math.max(1, Math.min(input.bars ?? 16, 128));
      // recorders live inside the ClaudeMeters — make sure every track has one
      await dispatchInner("place_meters", {}, { live });
      let tempo = 120, sigNum = 4, sigDenom = 4;
      try { const s = await remoteClient.session(); if (s && s.ok) { tempo = s.tempo || 120; sigNum = (s.timeSignature && s.timeSignature[0]) || 4; sigDenom = (s.timeSignature && s.timeSignature[1]) || 4; } } catch (e) {}
      const seconds = bars * barSeconds(tempo, sigNum, sigDenom);
      if (seconds > 420) return { result: { ok: false, error: `that's ${Math.round(seconds)}s of recording — keep it under 7 minutes (fewer bars or raise the tempo)` }, label: "Recording all tracks", detail: "too long" };
      let targets = [];
      try { const tr = await remoteClient.tracks(); if (tr && tr.ok) targets = [...(tr.tracks || []), ...(tr.returns || []), ...(tr.master ? [tr.master] : [])]; } catch (e) {}
      const metered = targets.filter((t) => t.hasMeter || (t.devices || []).some((d) => /claude\s*meter/i.test(String(d))));
      if (!metered.length) return { result: { ok: false, error: "no ClaudeMeters found — is the loader enabled? (place_meters reported what failed)" }, label: "Recording all tracks", detail: "no meters" };
      const key = await projectMemory.projectKey();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = path.join(RECORD_BASE, String(key).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80), stamp);
      fs.mkdirSync(dir, { recursive: true });
      const nameFor = (t) => t.index === -1 ? "master"
        : t.index <= -2 ? "return-" + String.fromCharCode(65 + (-2 - t.index))
        : String(t.index).padStart(2, "0") + "-" + String(t.name).replace(/[^a-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40);
      const files = metered.map((t) => ({ track: t.index, name: t.name, file: path.join(dir, nameFor(t) + ".wav") }));
      meterStore.clearTimelines(); // fresh activity map for this pass
      meterStore.clearCmds();      // stale undrained commands must not replay into this pass
      for (const f of files) meterStore.queueCmd(f.track, { rec: 0 }); // defensive: stop any recorder left rolling
      for (const f of files) meterStore.queueCmd(f.track, { rec: "open", path: f.file });
      if (input.from_start !== false) { try { await remoteClient.lomSet(["song"], "current_song_time", 0); } catch (e) {} }
      await sleep(700); // let the open commands drain (meters poll ~12 Hz)
      for (const f of files) meterStore.queueCmd(f.track, { rec: 1 });
      await sleep(300);
      try { await live.call("set_transport", { play: true }); } catch (e) {}
      await sleep(seconds * 1000);
      for (const f of files) meterStore.queueCmd(f.track, { rec: 0 });
      await sleep(600); // let the stop commands drain before reading sizes
      try { await live.call("set_transport", { stop: true }); } catch (e) {}
      const report = files.map((f) => { let bytes = 0; try { bytes = fs.statSync(f.file).size; } catch (e) {} return { ...f, bytes, ok: bytes > 1000 }; });
      const okFiles = report.filter((r) => r.ok);
      lastRecording = { dir, files: okFiles, bars, tempo, sigNum, sigDenom, projectKey: key };
      const missing = report.filter((r) => !r.ok).map((r) => r.name);
      return { result: { ok: okFiles.length > 0, dir, bars, seconds: Math.round(seconds), tempo, files: report,
        missing, note: (okFiles.length ? `captured ${okFiles.length}/${report.length} tracks — call analyze_recordings next, and cleanup_recordings when the session is done.` : "nothing was written — are the meters freshly placed? (re-open the device or re-run place_meters, then try again)") + " Files start within ~0.3s of each other; exact song positions come from each file's active sections." },
        label: "Recording all tracks", detail: `${okFiles.length}/${report.length} wavs · ${bars} bars` };
    }

    case "analyze_recordings": {
      const curKey = await projectMemory.projectKey();
      // a batch recorded for a DIFFERENT Live set must never be analysed as this one
      let rec = lastRecording && lastRecording.projectKey === curKey ? lastRecording : null;
      if (!rec) {
        // newest batch on disk for this project (survives a panel reload) — track
        // identity comes back out of the filename encoding (NN- / return-X / master)
        try {
          const base = path.join(RECORD_BASE, String(curKey).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80));
          const dirs = fs.readdirSync(base).sort().reverse();
          if (dirs.length) {
            const dir = path.join(base, dirs[0]);
            rec = { dir, projectKey: curKey, files: fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).map((f) => ({ file: path.join(dir, f), name: f.replace(/\.wav$/, ""), track: trackFromRecordingName(f) })) };
          }
        } catch (e) {}
      }
      if (!rec || !rec.files.length) return { result: { ok: false, error: "no recordings found for THIS project — run record_tracks first" }, label: "Analysing recordings", detail: "nothing to analyse" };
      let tempo = rec.tempo, sigNum = rec.sigNum, sigDenom = rec.sigDenom;
      if (!tempo) { try { const s = await remoteClient.session(); if (s && s.ok) { tempo = s.tempo; sigNum = (s.timeSignature && s.timeSignature[0]) || 4; sigDenom = (s.timeSignature && s.timeSignature[1]) || 4; } } catch (e) {} }
      let keyObj = null;
      try { keyObj = await songKey.detect(); } catch (e) {}
      const barSec = (60 / (tempo || 120)) * (sigNum || 4);
      const rows = [];
      for (const f of rec.files) {
        try {
          const prof = await analyzeAudioPath(f.file, { sectionSec: barSec * 8 }); // 8-bar evolution windows
          // tuning vs the song key — this is how "the kick is slightly off in G minor"
          // becomes a measured fact (only meaningful for low/tonal elements)
          const tuning = songKey.tuningInfo(prof.fundamentalHz, keyObj);
          rows.push({
            track: f.track, name: f.name, durationSec: prof.durationSec,
            loudness: prof.loudness, fundamentalHz: prof.fundamentalHz, centroidHz: prof.centroidHz,
            lowRatio: prof.lowRatio, highRatio: prof.highRatio, balance: prof.balance,
            temporal: { plucky: prof.temporal.plucky, sustained: prof.temporal.sustained },
            playsAt: rangesToBars(prof.activeRanges, tempo, sigNum, sigDenom),
            tuning: tuning || undefined,
            // through-song evolution: per-8-bar loudness + spectral balance — how the
            // element CHANGES across the arrangement, not just its average
            evolution: (prof.sections || []).map((s) => `bars ${Math.floor(s.fromSec / barSec) + 1}–${Math.max(1, Math.round(s.toSec / barSec))}: ${s.rmsDb}dB, low ${Math.round(s.lowRatio * 100)}%, high ${Math.round(s.highRatio * 100)}%`),
            character: prof.summary,
          });
        } catch (e) { rows.push({ track: f.track, name: f.name, error: String(e.message || e) }); }
      }
      // cross-track observations — SOURCE tracks only: the master is the sum and
      // return busses duplicate source energy, so both would fake clashes
      const isMaster = (r) => r.track === -1 || /^master$/i.test(String(r.name));
      const isReturn = (r) => (r.track != null && r.track <= -2) || /^return-/i.test(String(r.name));
      const audible = rows.filter((r) => !r.error && r.loudness && r.loudness.peakDb > -60 && !isMaster(r) && !isReturn(r));
      const obs = [];
      const lowHeavy = audible.filter((r) => r.lowRatio >= 0.45);
      if (lowHeavy.length >= 2) obs.push("LOW-END CLASH candidates (several tracks heavy below ~250Hz — carve with EQ or sidechain): " + lowHeavy.map((r) => r.name).join(", "));
      const silent = rows.filter((r) => !r.error && r.loudness && r.loudness.peakDb <= -60 && !isReturn(r));
      if (silent.length) obs.push("NEAR-SILENT in this capture: " + silent.map((r) => r.name).join(", "));
      if (audible.length >= 2) {
        const byRms = [...audible].sort((a, b) => b.loudness.rmsDb - a.loudness.rmsDb);
        obs.push(`loudest: ${byRms[0].name} (${byRms[0].loudness.rmsDb}dB RMS) · quietest: ${byRms[byRms.length - 1].name} (${byRms[byRms.length - 1].loudness.rmsDb}dB RMS)`);
        const bright = [...audible].sort((a, b) => b.centroidHz - a.centroidHz)[0];
        obs.push(`brightest: ${bright.name} (centroid ${bright.centroidHz}Hz)`);
      }
      const masterRow = rows.find(isMaster);
      return { result: { ok: true, dir: rec.dir, tempo, tracks: rows.filter((r) => !isMaster(r) && !isReturn(r)), returns: rows.filter(isReturn), master: masterRow || null, observations: obs,
        note: "Decide mix moves from these numbers, then cleanup_recordings when the session is done." },
        label: "Analysing recordings (group)", detail: `${rows.length} files${obs.length ? ", " + obs.length + " observations" : ""}` };
    }

    case "cleanup_recordings": {
      // scope: ONLY this project's recordings folder — other projects' stems (and
      // anything the user kept with keep_files in another session) stay untouched
      let deletedFiles = 0, otherProjects = 0;
      const curKey = await projectMemory.projectKey();
      const projDir = path.join(RECORD_BASE, String(curKey).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80));
      if (!input.keep_files) {
        try {
          const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else deletedFiles++; } };
          if (fs.existsSync(projDir)) { walk(projDir); fs.rmSync(projDir, { recursive: true, force: true }); }
          try { otherProjects = fs.readdirSync(RECORD_BASE).filter((d) => { try { return fs.statSync(path.join(RECORD_BASE, d)).isDirectory(); } catch { return false; } }).length; } catch (e) {}
        } catch (e) {}
        lastRecording = null;
      }
      let capturesRemoved = 0;
      try { const c = await remoteClient.cleanupCaptures(); if (c && c.ok) capturesRemoved = c.removed || 0; } catch (e) {}
      return { result: { ok: true, deletedFiles: input.keep_files ? 0 : deletedFiles, keptFiles: !!input.keep_files, captureTracksRemoved: capturesRemoved,
        note: otherProjects ? otherProjects + " other project folder(s) left untouched in ~/.claude-copilot/recordings" : undefined },
        label: "Cleaning up", detail: `${input.keep_files ? "kept files" : deletedFiles + " files deleted"}, ${capturesRemoved} capture track(s) removed` };
    }

    case "analyze_audio_file": {
      const file = String(input.path || "");
      if (!file || !fs.existsSync(file)) return { result: { ok: false, error: "file not found: " + file }, label: "Analysing audio file", detail: "missing" };
      try {
        const prof = await analyzeAudioPath(file);
        let tuning = null;
        try { tuning = songKey.tuningInfo(prof.fundamentalHz, await songKey.detect()); } catch (e) {}
        return { result: { ok: true, file: path.basename(file), ...prof, tuning }, label: "Analysing audio file", detail: `${path.basename(file)} — ${prof.summary}` };
      } catch (e) {
        return { result: { ok: false, error: "couldn't decode the audio: " + String(e.message || e) + " (wav/aiff/mp3/m4a/flac supported via afconvert)" }, label: "Analysing audio file", detail: "decode failed" };
      }
    }

    case "detect_key": {
      let hist, samples, source;
      if (input.from === "midi") {
        const { pitches } = await live.call("get_clip_pitches", { track: input.track, slot: input.slot ?? 0 });
        hist = keymod.histFromPitches(pitches || []); samples = (pitches || []).length; source = "midi";
      } else {
        const r = await live.call("get_pitch_histogram"); hist = r.hist; samples = r.total; source = "audio";
      }
      const need = source === "midi" ? 3 : 30;
      if (!samples || samples < need) {
        return { result: { needMoreData: true, samples: samples || 0, source,
          message: source === "audio"
            ? "I can't hear enough pitch yet — make sure this device is on the vocal track, then play the vocal for a few seconds and ask again."
            : "That clip has too few notes to detect a key." }, label: "Detect key", detail: "need more audio" };
      }
      const det = keymod.detectKey(hist);
      const sug = keymod.suggestChords(det.tonicPc, det.mode);
      return { result: { ...det, source, suggestions: sug }, label: "Key detected", detail: `${det.key} (${det.confidence})` };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// Logged wrapper: records EVERY tool call + its real result to the activity log, so
// there's a transparent record of what actually happened (not just the agent's prose).
async function dispatch(name, input, ctx) {
  try { const out = await dispatchInner(name, input, ctx); try { activityLog.log(name, input, out); } catch {} return out; }
  catch (e) { try { activityLog.log(name, input, null, e); } catch {} throw e; }
}

module.exports = { TOOLS, dispatch, pendingListenChecks };
