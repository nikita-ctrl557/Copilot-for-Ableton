// groove.js — genre-aware basslines, melody rhythms, swing and velocity dynamics.
// writeBassline is a seeded GROOVE GRAMMAR (not fixed loops): every style owns a bank
// of one-beat 16th-note rhythm CELLS (with rests + syncopation), pitch ROLES (root,
// octave pop, fifth, b7, approach tone), tiered velocities (accent / normal / ghost)
// and pickup/fill cells for bar ends. An LCG seeded like drums.js picks cells, so the
// same seed is byte-identical and different seeds give genuinely different patterns.
// Omit the seed and an internal counter rotates it, so "another bassline" IS another one.
const T = require("./theory");
const C = require("./chords");

// deterministic jitter (no global RNG) — kept for compat with older callers
function seeded(i, salt = 1) { const x = Math.sin((i + 1) * 12.9898 * salt + 78.233) * 43758.5453; return x - Math.floor(x); }

// Snap a beat to a clean grid (default 1/24 beat) so notes sit exactly on the line.
function snapToGrid(beat, res = 1 / 24) { return res ? Math.round(beat / res) * res : beat; }

// Exact 8th-note swing: delay an OFF-8th (a beat-position whose 8th index is odd,
// i.e. the ".5" of a beat) by a precise fraction of an 8th. amount 0..1 maps from
// straight (no delay) to a full triplet feel (off-8th sits 1/3 of the way to the
// next beat). 0.5 ≈ classic ~58% swing. Returns a clean, predictable position.
function swungStart(start, amount, stepBeats = 1) {
  if (!amount) return start;
  const eighth = stepBeats * 0.5;                 // length of one 8th in this grid
  const idx = Math.round(start / eighth);         // which 8th this note is on
  if (idx % 2 === 0) return start;                // on-beat 8ths are untouched
  // off-8th: shift later by up to 1/3 of an 8th (straight→triplet) × amount
  return snapToGrid(start + eighth * (1 / 3) * amount);
}

// LCG — same construction as drums.js so seeded variation behaves identically.
function rng(seed) { let s = (Math.floor(seed) * 2654435761) >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// Legacy fixed loops — no longer used by writeBassline, kept for compatibility.
const BASS_STYLES = {
  offbeat:  { hits: [{ b: 0.5 }, { b: 1.5 }, { b: 2.5 }, { b: 3.5 }], dur: 0.4, accent: 0 },
  rolling:  { hits: [{ b: 0 }, { b: 0.5 }, { b: 0.75 }, { b: 1.5 }, { b: 2 }, { b: 2.5 }, { b: 2.75 }, { b: 3.5 }], dur: 0.22 },
  octave:   { hits: [{ b: 0, o: 0 }, { b: 0.5, o: 1 }, { b: 1, o: 0 }, { b: 1.5, o: 1 }, { b: 2, o: 0 }, { b: 2.5, o: 1 }, { b: 3, o: 0 }, { b: 3.5, o: 1 }], dur: 0.22 },
  garage:   { hits: [{ b: 0 }, { b: 0.75 }, { b: 1.5 }, { b: 2.5 }, { b: 3.25 }], dur: 0.3 },
  pluck:    { hits: [{ b: 0 }, { b: 1 }, { b: 2 }, { b: 3 }], dur: 0.85 },
  sub:      { hits: [{ b: 0 }], dur: 4 },
  reese:    { hits: [{ b: 0 }, { b: 2 }], dur: 1.9 },
};

// --- groove grammar --------------------------------------------------------
// A CELL is one cellBeats-long slice of rhythm: hits at 16th offsets (t), with a
// pitch ROLE, a length in beats, and a velocity TIER.
//   roles: R root | O octave pop | F fifth | S b7-ish colour tone | A approach
//          into the NEXT chord's root | V seeded variety (one of O/F/S)
//   tiers: 'a' accent | 'n' normal | 'g' ghost (~62-75% of base velocity)
const h = (t, role, len, vel) => ({ t, role, len, vel });

const BASS_GRAMMAR = {
  // THE tech-house ask: bouncy syncopated 16ths around the offbeats, root+octave
  // interplay, b7/5th pickups into the next chord, ghosts, space on downbeats
  // (the kick owns them). Enforced: off-grid 16ths + a >=0.5-beat rest every bar
  // + pitch variety — it can NEVER degenerate into straight 8ths on one pitch.
  "tech-house": {
    cellBeats: 1, swingStep: 0.5, pickupEvery: 2, slide: 0,
    enforce: { off16: true, restGap: true, variety: true },
    cells: [
      [h(0.5, "R", 0.24, "a")],                                          // pure "&" stab
      [h(0.5, "R", 0.24, "a"), h(0.75, "O", 0.2, "g")],                  // & + ghost octave on "a"
      [h(0.25, "O", 0.2, "g"), h(0.5, "R", 0.24, "a")],                  // ghost "e" into the &
      [h(0.5, "O", 0.24, "a"), h(0.75, "R", 0.2, "g")],                  // octave pop on the &
      [h(0, "R", 0.2, "n"), h(0.5, "R", 0.45, "a")],                     // down + held &
      [h(0.5, "R", 0.5, "a")],                                           // held & (bounce)
      [h(0.75, "V", 0.2, "g")],                                          // lone "a" pickup — space
      [],                                                                // rest beat — kick owns it
      [h(0.25, "R", 0.2, "g"), h(0.75, "F", 0.2, "g")],                  // e+a ghost skip
      [h(0, "O", 0.2, "n"), h(0.75, "R", 0.2, "g")],
      [h(0.5, "R", 0.24, "a"), h(0.75, "S", 0.2, "g")],                  // & + b7 colour ghost
    ],
    pickups: [ // rolling end-of-2-bar pickups into the next chord
      [h(0.5, "S", 0.22, "n"), h(0.75, "A", 0.22, "a")],
      [h(0.25, "R", 0.2, "g"), h(0.5, "O", 0.2, "n"), h(0.75, "A", 0.22, "a")],
      [h(0.5, "F", 0.24, "n"), h(0.75, "O", 0.2, "a")],
      [h(0, "R", 0.2, "n"), h(0.5, "S", 0.2, "n"), h(0.75, "A", 0.2, "a")],
    ],
  },
  // 303-flavoured: dense accented 16ths, octave jumps, occasional overlapping
  // note into a DIFFERENT pitch for the slide feel (seeded).
  acid: {
    cellBeats: 1, swingStep: 0.5, pickupEvery: 2, slide: 0.45,
    enforce: { variety: true },
    cells: [
      [h(0, "R", 0.22, "a"), h(0.5, "R", 0.2, "n"), h(0.75, "O", 0.2, "g")],
      [h(0, "R", 0.22, "a"), h(0.25, "O", 0.2, "g"), h(0.5, "R", 0.2, "n")],
      [h(0, "O", 0.22, "a"), h(0.5, "R", 0.2, "n"), h(0.75, "R", 0.18, "g")],
      [h(0, "R", 0.2, "n"), h(0.25, "R", 0.18, "g"), h(0.5, "O", 0.22, "a"), h(0.75, "R", 0.18, "g")],
      [h(0.5, "S", 0.22, "a"), h(0.75, "O", 0.2, "g")],
      [h(0, "R", 0.45, "a")],                                            // slide candidate (long)
      [h(0, "F", 0.2, "n"), h(0.5, "O", 0.22, "a")],
      [h(0.25, "R", 0.18, "g"), h(0.5, "R", 0.22, "a"), h(0.75, "S", 0.18, "g")],
    ],
    pickups: [
      [h(0, "R", 0.2, "n"), h(0.5, "O", 0.2, "a"), h(0.75, "A", 0.2, "n")],
      [h(0.25, "S", 0.18, "g"), h(0.5, "R", 0.2, "n"), h(0.75, "A", 0.22, "a")],
    ],
  },
  // classic house "&" bass — every cell keeps the &-of-beat anchor (the signature),
  // variation comes from ghosts, octave &s and held lengths around it.
  offbeat: {
    cellBeats: 1, swingStep: 1, pickupEvery: 0,
    enforce: { variety: true },
    cells: [
      [h(0.5, "R", 0.4, "a")],
      [h(0.5, "R", 0.4, "a")],
      [h(0.5, "R", 0.4, "a"), h(0.75, "O", 0.18, "g")],
      [h(0.5, "O", 0.4, "a")],
      [h(0.25, "R", 0.18, "g"), h(0.5, "R", 0.4, "a")],
      [h(0.5, "R", 0.55, "a")],
    ],
    pickups: [
      [h(0.5, "R", 0.4, "a"), h(0.75, "A", 0.2, "g")],
      [h(0.5, "O", 0.4, "a"), h(0.75, "A", 0.2, "g")],
    ],
  },
  // deep rolling 16ths — busy, ghost-heavy, mostly root with octave/fifth colour.
  rolling: {
    cellBeats: 1, swingStep: 0.5, pickupEvery: 2,
    enforce: { off16: true, variety: true },
    cells: [
      [h(0, "R", 0.2, "a"), h(0.5, "R", 0.2, "n"), h(0.75, "R", 0.18, "g")],
      [h(0, "R", 0.2, "a"), h(0.25, "R", 0.18, "g"), h(0.5, "R", 0.2, "n"), h(0.75, "O", 0.18, "g")],
      [h(0.5, "R", 0.2, "n"), h(0.75, "R", 0.18, "g")],
      [h(0, "R", 0.2, "a"), h(0.5, "O", 0.2, "n")],
      [h(0, "R", 0.2, "a"), h(0.75, "F", 0.18, "g")],
      [h(0, "R", 0.2, "n"), h(0.25, "R", 0.18, "g"), h(0.5, "R", 0.2, "a")],
    ],
    pickups: [
      [h(0, "R", 0.2, "a"), h(0.5, "S", 0.2, "n"), h(0.75, "A", 0.2, "n")],
      [h(0.25, "O", 0.18, "g"), h(0.5, "R", 0.2, "n"), h(0.75, "A", 0.2, "a")],
    ],
  },
  // octave bounce — root/octave alternation core with ghost decorations.
  octave: {
    cellBeats: 1, swingStep: 0.5, pickupEvery: 0,
    enforce: { variety: true },
    cells: [
      [h(0, "R", 0.2, "a"), h(0.5, "O", 0.2, "n")],
      [h(0, "R", 0.2, "a"), h(0.5, "O", 0.2, "n")],
      [h(0, "R", 0.2, "a"), h(0.25, "O", 0.18, "g"), h(0.5, "R", 0.2, "n"), h(0.75, "O", 0.18, "g")],
      [h(0, "O", 0.2, "n"), h(0.5, "R", 0.2, "a")],
      [h(0, "R", 0.2, "a"), h(0.5, "O", 0.2, "n"), h(0.75, "O", 0.16, "g")],
    ],
    pickups: [
      [h(0, "R", 0.2, "a"), h(0.5, "O", 0.2, "n"), h(0.75, "A", 0.2, "g")],
    ],
  },
  // 2-step garage — shuffled placements with real gaps.
  garage: {
    cellBeats: 1, swingStep: 0.5, pickupEvery: 2,
    enforce: { restGap: true, variety: true },
    cells: [
      [h(0, "R", 0.3, "a"), h(0.75, "O", 0.2, "g")],
      [h(0.75, "R", 0.24, "n")],
      [h(0.5, "R", 0.3, "a")],
      [],
      [h(0.25, "F", 0.2, "g"), h(0.5, "R", 0.3, "a")],
      [h(0, "R", 0.3, "a")],
      [h(0.5, "O", 0.28, "n"), h(0.75, "R", 0.2, "g")],
    ],
    pickups: [
      [h(0.25, "R", 0.2, "g"), h(0.75, "A", 0.24, "n")],
      [h(0.5, "F", 0.24, "n"), h(0.75, "A", 0.2, "a")],
    ],
  },
  // long detuned-style notes in 2-beat cells, with fifth/b7/octave tails.
  reese: {
    cellBeats: 2, swingStep: 1, pickupEvery: 0,
    enforce: {},
    cells: [
      [h(0, "R", 1.9, "a")],
      [h(0, "R", 1.4, "a"), h(1.5, "F", 0.45, "g")],
      [h(0, "R", 1.4, "a"), h(1.5, "O", 0.45, "g")],
      [h(0, "R", 2.4, "a")],                                             // drone over the bar line
      [h(0, "R", 0.9, "a"), h(1, "S", 0.9, "n")],
    ],
    pickups: [
      [h(0, "R", 1.4, "a"), h(1.5, "A", 0.45, "n")],
      [h(0, "R", 0.9, "a"), h(1, "F", 0.45, "n"), h(1.5, "A", 0.45, "g")],
    ],
  },
  // sparse long roots — the ONE style allowed to stay on a single pitch;
  // variation is in lengths / re-trigger pickups / velocity, never in pitch.
  sub: {
    cellBeats: 4, swingStep: 1, pickupEvery: 0, singlePitch: true,
    enforce: {},
    cells: [
      [h(0, "R", 3.9, "a")],
      [h(0, "R", 3.9, "a")],
      [h(0, "R", 2.4, "a"), h(2.5, "R", 1.4, "n")],
      [h(0, "R", 3.4, "a"), h(3.5, "R", 0.45, "g")],
    ],
    pickups: [
      [h(0, "R", 2.9, "a"), h(3, "R", 0.9, "n")],
      [h(0, "R", 3.4, "a"), h(3.5, "R", 0.45, "g")],
    ],
  },
  // quarter-note plucks with octave/fifth substitutions and pickup ghosts.
  pluck: {
    cellBeats: 1, swingStep: 1, pickupEvery: 0,
    enforce: { variety: true },
    cells: [
      [h(0, "R", 0.85, "a")],
      [h(0, "R", 0.85, "a")],
      [h(0, "O", 0.85, "n")],
      [h(0, "R", 0.6, "a"), h(0.75, "V", 0.2, "g")],
      [h(0, "F", 0.85, "n")],
    ],
    pickups: [
      [h(0, "R", 0.6, "a"), h(0.5, "F", 0.24, "g"), h(0.75, "A", 0.22, "n")],
    ],
  },
};

function resolveStyle(s) {
  const k = String(s || "offbeat").toLowerCase().trim().replace(/[\s_]+/g, "-");
  if (BASS_GRAMMAR[k]) return k;
  if (k === "techhouse") return "tech-house";
  if (k === "303" || k === "acid-house" || k === "acidhouse") return "acid";
  if (k.includes("tech")) return "tech-house";
  if (k.includes("acid")) return "acid";
  return "offbeat";
}

// --- pitch helpers ---------------------------------------------------------
// REGISTER: all pitches live in [LOW, LOW+23] where LOW = octave*12 + 16.
// For octave 1 that is MIDI 28..51 (E1..D#3): roots in 28..39, octave pops +12.
function lowBound(octave) { return octave * 12 + 16; }
function foldRange(p, LOW) { while (p < LOW) p += 12; while (p > LOW + 23) p -= 12; return p; }

// Chord context: root placed in the bass register + the chord's own fifth and a
// b7-ish colour tone (chord 7th if present, else b7/maj7 picked from the key scale).
function chordCtx(chord, key, mode, LOW, scalePcs) {
  let tones;
  if (typeof chord === "string") {
    tones = C.chordForRoman(chord, T.noteToMidi(key, 3), mode);
  } else {
    const q = chord.quality && T.CHORDS[chord.quality] ? chord.quality : "maj";
    tones = T.buildChord(T.noteToMidi(chord.root, 1), q);
  }
  const rootPc = ((tones[0] % 12) + 12) % 12;
  const root = LOW + ((rootPc - (LOW % 12) + 12) % 12);
  const fifthIv = tones.length > 2 ? (((tones[2] - tones[0]) % 12) + 12) % 12 || 7 : 7;
  let sevIv;
  if (tones.length > 3) sevIv = (((tones[3] - tones[0]) % 12) + 12) % 12;
  else if (scalePcs.includes((rootPc + 10) % 12)) sevIv = 10;
  else if (scalePcs.includes((rootPc + 11) % 12)) sevIv = 11;
  else sevIv = fifthIv;
  return { root, rootPc, fifth: root + fifthIv, seventh: root + sevIv };
}

// Resolve a cell hit's ROLE to a MIDI pitch (all in key/chord, folded into range).
function resolvePitch(role, ctx, nextCtx, scalePcs, LOW, r) {
  switch (role) {
    case "O": return ctx.root + 12;
    case "F": return ctx.fifth;
    case "S": return ctx.seventh;
    case "V": return [ctx.root + 12, ctx.fifth, ctx.seventh][Math.floor(r() * 3)];
    case "A": { // approach tone walking into the NEXT chord's root (diatonic if possible)
      const t = nextCtx.root;
      const cands = [t - 1, t + 1, t - 2, t + 2].filter((p) => scalePcs.includes(((p % 12) + 12) % 12));
      return foldRange(cands.length ? cands[Math.floor(r() * cands.length)] : t - 1, LOW);
    }
    default: return ctx.root;
  }
}

// velocity tiers: accents on anchors, ghosts at ~62-75% — never flat.
function hitVel(tier, base, r) {
  let v;
  if (tier === "a") v = base + 10 + Math.round((r() - 0.5) * 6);
  else if (tier === "g") v = Math.round(base * (0.62 + r() * 0.13));
  else v = base - 6 + Math.round((r() - 0.5) * 8);
  return Math.max(25, Math.min(127, v));
}

const cellHasOff16 = (cell) => cell.some((x) => Math.abs((x.t % 0.5) - 0.25) < 1e-9);

// Longest silent stretch in a window built from cells (pre-pitch, exact).
function windowMaxGap(cells, cellBeats, total) {
  const iv = [];
  cells.forEach((cell, ci) => {
    for (const x of cell) {
      const at = ci * cellBeats + x.t;
      if (at < total) iv.push([at, Math.min(total, at + x.len)]);
    }
  });
  iv.sort((a, b) => a[0] - b[0]);
  let cur = 0, gap = 0;
  for (const [s, e] of iv) { gap = Math.max(gap, s - cur); cur = Math.max(cur, e); }
  return Math.max(gap, total - cur);
}

let bassSeq = 0; // rotates when no seed is pinned, so repeated calls differ (like drums)

// Build a bassline that locks to the chord progression.
//   opts: style, beatsPerChord, octave, swing, velocity, seed (same seed = identical,
//   omit = a fresh variation every call). Returns [{pitch,start,duration,velocity,mute}].
function writeBassline(key, mode, chords, opts = {}) {
  const { style = "offbeat", beatsPerChord = 4, octave = 1, velocity = 105, swing = 0.12 } = opts;
  const seed = opts.seed != null ? Math.floor(opts.seed) : bassSeq++;
  const g = BASS_GRAMMAR[resolveStyle(style)];
  const r = rng(seed + 1);

  const scaleArr = T.SCALES[mode] || T.SCALES.minor;
  const tonicPc = ((T.noteToMidi(key, 3) % 12) + 12) % 12;
  const scalePcs = scaleArr.map((s) => (tonicPc + s) % 12);
  const LOW = lowBound(octave);

  const ctxs = chords.map((ch) => chordCtx(ch, key, mode, LOW, scalePcs));
  const notes = [];

  ctxs.forEach((ctx, wi) => {
    const nextCtx = ctxs[(wi + 1) % ctxs.length];
    const windowStart = wi * beatsPerChord;
    const isLast = wi === ctxs.length - 1;
    const nCells = Math.max(1, Math.floor(beatsPerChord / g.cellBeats));

    // 1) seeded cell choices
    const cells = [];
    for (let i = 0; i < nCells; i++) cells.push(pick(r, g.cells));

    // 2) pickup/fill: the final cell of the LAST window always varies (fill), and
    //    tech-house/acid/rolling/garage also pick up at the end of every 2nd window.
    const pickupHere = g.pickups && (isLast || (g.pickupEvery > 0 && wi % g.pickupEvery === g.pickupEvery - 1));
    const pickupIdx = pickupHere ? nCells - 1 : -1;
    if (pickupHere) cells[pickupIdx] = pick(r, g.pickups);

    // 3) enforce syncopation: at least one off-grid 16th (.25/.75) in the window
    let idx16 = -1;
    if (g.enforce.off16 && !cells.some(cellHasOff16)) {
      const bank = g.cells.filter(cellHasOff16);
      const cand = [1, 3, 0, 2].filter((i) => i < nCells && i !== pickupIdx);
      if (bank.length && cand.length) { idx16 = cand[0]; cells[idx16] = pick(r, bank); }
    }
    // 4) enforce breathing room: a silent stretch >= 0.5 beat per window
    let emptied = -1;
    if (g.enforce.restGap && nCells >= 3 && windowMaxGap(cells, g.cellBeats, beatsPerChord) < 0.5) {
      const cand = [0, 2].filter((i) => i < nCells && i !== pickupIdx && i !== idx16);
      if (cand.length) { emptied = cand[Math.floor(r() * cand.length)]; cells[emptied] = []; }
    }
    // 4b) emptying may have removed the only off-grid cell — re-assert
    if (g.enforce.off16 && !cells.some(cellHasOff16)) {
      const bank = g.cells.filter(cellHasOff16);
      const cand = [1, 3].filter((i) => i < nCells && i !== pickupIdx && i !== emptied);
      if (bank.length && cand.length) cells[cand[0]] = pick(r, bank);
    }

    // 5) materialise notes: resolve roles to in-key pitches + tiered velocities
    const wNotes = [];
    cells.forEach((cell, ci) => {
      for (const x of cell) {
        const at = ci * g.cellBeats + x.t;
        if (at >= beatsPerChord) continue;
        const dur = Math.max(0.05, Math.min(x.len, beatsPerChord - at));
        const pitch = resolvePitch(x.role, ctx, nextCtx, scalePcs, LOW, r);
        wNotes.push({ pitch, start: snapToGrid(windowStart + at), duration: dur, velocity: hitVel(x.vel, velocity, r), mute: 0 });
      }
    });
    if (!wNotes.length) { // a window must never be silent
      wNotes.push({ pitch: ctx.root, start: windowStart, duration: Math.max(0.1, Math.min(1, beatsPerChord) * 0.9), velocity: hitVel("a", velocity, r), mute: 0 });
    }
    wNotes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    // 6) chord lock: the FIRST sounding note of every chord window is the ROOT
    wNotes[0].pitch = ctx.root;
    // 7) pitch variety: outside 'sub', a window never stays on a single pitch
    if (g.enforce.variety && !g.singlePitch && wNotes.length >= 2 && wNotes.every((n) => n.pitch === ctx.root)) {
      wNotes[wNotes.length - 1].pitch = ctx.root + 12;
    }
    notes.push(...wNotes);
  });

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  // acid slide feel: occasionally let a note overlap the NEXT (different-pitch) note
  if (g.slide) {
    for (let i = 0; i + 1 < notes.length; i++) {
      const a = notes[i], b = notes[i + 1];
      if (b.pitch !== a.pitch && b.start > a.start && b.start - (a.start + a.duration) <= 0.13 && r() < g.slide) {
        a.duration = b.start - a.start + 0.12;
      }
    }
  }

  // hygiene: drop exact duplicates, clip same-pitch overlaps (never clip slides —
  // those overlap a different pitch by design)
  const seen = new Set(), out = [];
  for (const n of notes) { const k = n.start + "/" + n.pitch; if (!seen.has(k)) { seen.add(k); out.push(n); } }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length && out[j].start < out[i].start + out[i].duration; j++) {
      if (out[j].pitch === out[i].pitch) { out[i].duration = Math.max(0.05, out[j].start - out[i].start); break; }
    }
  }

  // exact swing last: 8th swing for sparse styles, 16th swing for 16th-based grammars
  return applySwing(out, swing, g.swingStep);
}

// Named rhythm patterns (beat durations per note, cycled) for melodies/hooks.
const MELODY_RHYTHMS = {
  straight: [1, 1, 1, 1],
  eighths: [0.5, 0.5, 0.5, 0.5],
  house: [0.5, 0.5, 1, 0.5, 0.5, 1],          // syncopated, breathes
  syncopated: [0.75, 0.25, 0.5, 0.5, 1],
  dotted: [0.75, 0.25, 0.75, 0.25],
  offbeat: [0.5, 1, 0.5, 1, 1],               // emphasises the "and"
  gallop: [0.25, 0.25, 0.5, 0.25, 0.25, 0.5],
};

// Apply exact 8th-note swing to a note list: delay only off-8ths by a precise
// fraction of an 8th. Snaps each start to the grid first so it works even if the
// incoming note isn't perfectly on x.5, and the result lands on a predictable spot.
// stepBeats = the beat length of one step (1 = a quarter, so an 8th = 0.5 beat).
function applySwing(notes, amount = 0.12, stepBeats = 1) {
  if (!amount) return notes;
  return notes.map((n) => {
    const snapped = snapToGrid(n.start);
    const start = swungStart(snapped, amount, stepBeats);
    return start === n.start ? n : { ...n, start };
  });
}

module.exports = { BASS_STYLES, BASS_GRAMMAR, MELODY_RHYTHMS, writeBassline, applySwing, swungStart, snapToGrid, seeded, resolveStyle };
