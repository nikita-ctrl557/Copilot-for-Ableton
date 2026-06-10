// drums.js — genre-aware drum-pattern generator with REAL variation, so the agent
// stops making the same boring loop. 16 steps per bar (16th notes); step 0=beat1,
// 4=beat2, 8=beat3, 12=beat4; offbeat "&"=2,6,10,14; weak "e/a"=odd steps.
// Everything stays ON THE GRID (no off-grid nudging); swing only if explicitly asked.
// Patterns researched against real genre conventions (house 4-on-floor, trap snare on 3
// + hat rolls, dnb amen 2-step, garage shuffled 2-step, boom-bap swung & ghosted, etc.).

const STEP = 0.25; // a 16th note in beats
const PITCH = { kick: 36, rim: 37, snare: 38, clap: 39, lowTom: 43, pedalHat: 44, chh: 42, midTom: 47, ohh: 46, hiTom: 50, ride: 51, perc: 64, shaker: 70, cowbell: 56 };

// each genre = array of VARIANTS; a variant maps instrument -> step indices (0..15).
const GENRES = {
  house: [
    { kick: [0, 4, 8, 12], clap: [4, 12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14] },
    { kick: [0, 4, 8, 12], clap: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [14], rim: [7] },
    { kick: [0, 4, 8, 12, 15], clap: [4, 12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14], perc: [7] },
  ],
  deephouse: [
    { kick: [0, 4, 8, 12], snare: [4, 12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14], shaker: [1, 3, 5, 7, 9, 11, 13, 15], rim: [7, 15] },
    { kick: [0, 4, 8, 10, 12], clap: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [6, 14], shaker: [1, 3, 5, 7, 9, 11, 13, 15], perc: [3, 11] },
    { kick: [0, 4, 8, 12], snare: [4], clap: [12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14], rim: [3, 7, 11, 15] },
  ],
  techhouse: [
    { kick: [0, 4, 8, 12], clap: [4, 12], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [2, 6, 10, 14], perc: [7, 15] },
    { kick: [0, 4, 8, 12, 15], clap: [4, 12], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [14], rim: [7], perc: [3, 11] },
    { kick: [0, 4, 6, 8, 12], clap: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [2, 6, 10, 14], perc: [1, 7, 9, 15] },
  ],
  techno: [
    { kick: [0, 4, 8, 12], clap: [12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14], ride: [1, 3, 5, 7, 9, 11, 13, 15] },
    { kick: [0, 4, 8, 12], clap: [4, 12], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [6, 14], rim: [3, 11] },
    { kick: [0, 4, 8, 12], ohh: [2, 6, 10, 14], perc: [7, 15], ride: [2, 6, 10, 14] },
  ],
  trap: [
    { kick: [0, 3, 6, 8, 10], snare: [8], chh: [0, 2, 4, 6, 8, 10, 12, 14, 14, 15], ohh: [] },
    { kick: [0, 7, 10], snare: [8], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [15] },
    { kick: [0, 4, 11], snare: [8], chh: [0, 2, 3, 4, 6, 8, 10, 12, 14], rim: [5, 13] },
  ],
  boombap: [
    { kick: [0, 6, 8, 14], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [14], rim: [7, 15] },
    { kick: [0, 3, 8, 10], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [6] },
    { kick: [0, 8], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], rim: [7, 11] },
  ],
  dnb: [
    { kick: [0, 10], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [6, 14] },
    { kick: [0, 6, 10], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ride: [1, 3, 5, 7, 9, 11, 13, 15] },
    { kick: [0, 8, 11], snare: [4, 12], chh: [2, 6, 10, 14], ohh: [2, 10] },
  ],
  breakbeat: [
    { kick: [0, 10], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [14] },
    { kick: [0, 6, 8], snare: [4, 12], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14] },
    { kick: [0, 3, 10], snare: [4, 12, 15], chh: [0, 2, 4, 6, 8, 10, 12, 14] },
  ],
  garage: [ // uk garage / 2-step: shuffled, gaps
    { kick: [0, 10], snare: [4, 12], chh: [2, 6, 10, 14], ohh: [6, 14], rim: [7] },
    { kick: [0, 6, 10], snare: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [14] },
    { kick: [0, 11], snare: [4, 12], clap: [4, 12], chh: [2, 6, 10, 14], perc: [3, 9] },
  ],
  dubstep: [ // half-time: snare on beat 3 only
    { kick: [0, 6], snare: [8], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [14] },
    { kick: [0, 10], snare: [8], chh: [2, 6, 10, 14], ohh: [2, 6, 10, 14], rim: [4, 12] },
    { kick: [0, 3, 11], snare: [8], chh: [0, 2, 4, 6, 8, 10, 12, 14] },
  ],
  afrobeats: [
    { kick: [0, 6, 10], snare: [], clap: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], perc: [3, 7, 11, 15], cowbell: [2, 10] },
    { kick: [0, 3, 6, 11], clap: [4, 12], chh: [2, 6, 10, 14], perc: [0, 4, 8, 12], shaker: [1, 3, 5, 7, 9, 11, 13, 15] },
    { kick: [0, 6, 10], rim: [4, 12], chh: [0, 2, 4, 6, 8, 10, 12, 14], perc: [3, 11], cowbell: [2, 6, 10, 14] },
  ],
  funkdisco: [
    { kick: [0, 4, 8, 12], snare: [4, 12], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [2, 6, 10, 14] },
    { kick: [0, 3, 8, 10], snare: [4, 12], chh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohh: [14] },
    { kick: [0, 4, 8, 12, 15], snare: [4, 12], clap: [12], chh: [0, 2, 4, 6, 8, 10, 12, 14], ohh: [2, 6, 10, 14], perc: [1, 5, 9, 13] },
  ],
};

const ALIAS = {
  "deep house": "deephouse", "tech house": "techhouse", "tech-house": "techhouse",
  "hip hop": "boombap", "hip-hop": "boombap", "hiphop": "boombap", "boom bap": "boombap", "boom-bap": "boombap",
  "drum and bass": "dnb", "drum & bass": "dnb", "d&b": "dnb", "jungle": "dnb",
  "uk garage": "garage", "2-step": "garage", "2step": "garage", "ukg": "garage",
  "funk": "funkdisco", "disco": "funkdisco", "nu-disco": "funkdisco",
};

function resolveGenre(g) {
  const k = String(g || "house").toLowerCase().trim();
  if (GENRES[k]) return k;
  if (ALIAS[k]) return ALIAS[k];
  for (const name of Object.keys(GENRES)) if (k.includes(name)) return name;
  for (const a of Object.keys(ALIAS)) if (k.includes(a)) return ALIAS[a];
  return "house";
}

function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// velocity: downbeats loud, backbeat strong, offbeats medium, weak 16ths = ghost-ish
function velFor(inst, step, intensity, jitter) {
  let v;
  if (inst === "kick") v = step % 8 === 0 ? 122 : step % 4 === 0 ? 110 : 98;
  else if (inst === "snare" || inst === "clap") v = 116;
  else if (inst === "ohh") v = 98;
  else if (inst === "chh") v = step % 4 === 0 ? 98 : step % 2 === 0 ? 86 : 56;
  else if (inst === "rim") v = 64;
  else if (inst === "shaker") v = 50;
  else v = 92;
  // gentle intensity scaling: 1.0 keeps the designed accents intact (the old 0.8+0.4x
  // curve pushed kick/snare to a flat 127 at default intensity — all dynamics lost)
  v = Math.round(v * (0.7 + 0.3 * Math.min(1.5, intensity)) + jitter);
  return Math.max(1, Math.min(127, v));
}

// fills for the LAST bar of a multi-bar loop
const FILLS = [
  { name: "snare roll", snare: [12, 13, 14, 15] },
  { name: "tom fall", hiTom: [12], midTom: [13], lowTom: [14, 15] },
  { name: "hat stutter", chh: [12, 13, 14, 15], snare: [14] },
  { name: "kick drop", kick: [12, 14, 15], snare: [12] },
];

// generate a varied, genre-correct, on-grid drum clip.
//   genre, { bars=2, fill=true, intensity=1, seed=0, swing=0 }
function generateDrums(genre, opts = {}) {
  const { bars = 2, fill = true, intensity = 1, seed = 0, swing = 0 } = opts;
  const gname = resolveGenre(genre);
  const variants = GENRES[gname];
  const r = rng(seed + 1);
  const vi = ((seed % variants.length) + variants.length) % variants.length; // negative-seed safe
  const variant = variants[vi];
  const notes = [];
  const dur = STEP * 0.9;
  const hatGhostExtra = r() < 0.5; // sometimes add ghost hats on the 'a'
  const dropOhh = r() < 0.25;      // occasionally thin the open hats

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4;
    const isLast = bar === bars - 1 && bars > 1;
    // the FULL groove plays in EVERY bar (the old code dropped everything but the kick
    // in the fill bar, so half of every 2-bar loop had no hats/claps — the big bug)
    for (const inst of Object.keys(variant)) {
      let steps = variant[inst];
      if (inst === "ohh" && dropOhh) steps = steps.filter((s) => s % 4 === 2); // thin to offbeats
      // an open hat chokes the closed hat in a Drum Rack — don't hit both on one step
      if (inst === "chh" && variant.ohh) steps = steps.filter((s) => !variant.ohh.includes(s));
      // in the fill zone (last beat of the last bar) clear top elements to make room
      if (isLast && fill && (inst === "chh" || inst === "ohh")) steps = steps.filter((s) => s < 12);
      addHits(notes, steps, inst, barStart, dur, intensity, r, swing);
    }
    if (hatGhostExtra && variant.chh) {
      const ghosts = [3, 7, 11, 15].filter((s) => !variant.chh.includes(s) && !(variant.ohh || []).includes(s) && !(isLast && fill && s >= 12));
      addHits(notes, ghosts, "chh", barStart, dur, intensity * 0.5, r, swing);
    }
    if (isLast && fill) {
      // overlay the fill on the last beat, ON TOP of the still-running groove
      const f = FILLS[((seed % FILLS.length) + FILLS.length) % FILLS.length];
      for (const inst of Object.keys(f)) if (inst !== "name") addHits(notes, f[inst], inst, barStart, dur, intensity, r, swing);
    }
  }
  return { genre: gname, variant: vi, bars, notes };
}

function addHits(notes, steps, inst, barStart, dur, intensity, r, swing) {
  const pitch = PITCH[inst];
  if (pitch == null) return;
  for (const s of steps) {
    let start = barStart + s * STEP;
    if (swing > 0 && s % 2 === 1) start += STEP * (1 / 3) * swing; // exact off-16th swing, only if asked
    const jit = Math.round((r() - 0.5) * 8); // ±4 velocity, deterministic
    notes.push({ pitch, start: Math.round(start / (STEP / 6)) * (STEP / 6), duration: dur, velocity: velFor(inst, s, intensity, jit), mute: 0 });
  }
}

module.exports = { generateDrums, resolveGenre, GENRES, PITCH };
