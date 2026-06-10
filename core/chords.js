// chords.js — progressions, voicings, voice-leading, melody, humanize.
// Output model = Live clip notes: { pitch, start, duration, velocity, mute }
//   start/duration are in BEATS (quarter notes). This matches Live's add_new_notes.

const T = require("./theory");

// --- voicings -------------------------------------------------------------

// Re-voice a set of chord pitches. styles: close | open | drop2 | drop3 | rootless
function voiceChord(pitches, style = "close") {
  const p = [...pitches].sort((a, b) => a - b);
  switch (style) {
    case "close":
      return p;
    case "rootless":
      return p.length > 3 ? p.slice(1) : p;
    case "open": {
      // spread: lift every other inner voice up an octave
      const out = [p[0]];
      for (let i = 1; i < p.length; i++) out.push(i % 2 ? p[i] + 12 : p[i]);
      return out.sort((a, b) => a - b);
    }
    case "spread": {
      // wide modern voicing without a voice-leading context: low root + octave
      // double, rootless colour fanned above. Delegates to spreadVoices().
      const rootPc = ((p[0] % 12) + 12) % 12;
      const pcs = [rootPc, ...p.map((n) => ((n % 12) + 12) % 12).filter((pc) => pc !== rootPc)];
      return spreadVoices(null, pcs, { bassMidi: p[0] });
    }
    case "duo":
      // two-osc mode: root + one defining colour tone, octave-plus apart
      return duoVoices(p, p[0]);
    case "drop2": {
      if (p.length < 3) return p;
      const dropped = [...p];
      dropped[dropped.length - 2] -= 12; // 2nd from top down an octave
      return dropped.sort((a, b) => a - b);
    }
    case "drop3": {
      if (p.length < 4) return p;
      const dropped = [...p];
      dropped[dropped.length - 3] -= 12;
      return dropped.sort((a, b) => a - b);
    }
    default:
      return p;
  }
}

function applyInversion(pitches, inversion = 0) {
  let p = [...pitches].sort((a, b) => a - b);
  for (let i = 0; i < inversion; i++) p = [...p.slice(1), p[0] + 12];
  return p.sort((a, b) => a - b);
}

// Voice-lead `next` to sit as close as possible to `prev` (minimise total motion)
// by octave-shifting the whole chord. Keeps the chord's internal voicing intact.
function voiceLead(prev, next) {
  if (!prev || !prev.length) return next;
  const prevCentroid = prev.reduce((a, b) => a + b, 0) / prev.length;
  let best = next, bestDist = Infinity;
  for (let shift = -24; shift <= 24; shift += 12) {
    const cand = next.map((n) => n + shift);
    const c = cand.reduce((a, b) => a + b, 0) / cand.length;
    const d = Math.abs(c - prevCentroid);
    if (d < bestDist) { bestDist = d; best = cand; }
  }
  return best;
}

// Proper voice-leading: try every inversion across nearby octaves and pick the
// voicing whose notes move the LEAST from the previous chord. Sounds smooth/pro
// instead of blocky parallel triads.
function voiceLeadInvert(prev, pitches) {
  const base = [...pitches].sort((a, b) => a - b);
  const cands = [];
  for (let oct = -1; oct <= 1; oct++) {
    for (let inv = 0; inv < base.length; inv++) {
      cands.push(applyInversion(base, inv).map((p) => p + 12 * oct));
    }
  }
  const cost = (cand) => {
    if (!prev || !prev.length) return Math.abs(cand.reduce((a, b) => a + b, 0) / cand.length - 60);
    let s = 0;
    for (const n of cand) { let m = Infinity; for (const q of prev) m = Math.min(m, Math.abs(n - q)); s += m; }
    return s + Math.abs(cand.reduce((a, b) => a + b, 0) / cand.length - 60) * 0.1; // keep it centred-ish
  };
  let best = cands[0], bc = Infinity;
  for (const c of cands) { const x = cost(c); if (x < bc) { bc = x; best = c; } }
  return best.slice().sort((a, b) => a - b);
}

// TRUE voice-leading: move each voice to the NEAREST tone of the next chord, so no
// voice leaps more than a few semitones, common tones are held, and the lead (top)
// voice moves smoothly. Fixes "jumps more than 5 steps, no lead voice".
function leadVoices(prev, chordPCs) {
  const pcs = [...new Set(chordPCs.map((p) => ((p % 12) + 12) % 12))];
  if (!prev || !prev.length) {
    // initial closed voicing ascending from ~C4, grouped within one octave
    let cur = 60; const out = [];
    for (const pc of pcs.slice().sort((a, b) => a - b)) { let n = cur - (cur % 12) + pc; while (n < cur) n += 12; out.push(n); cur = n; }
    return out.sort((a, b) => a - b);
  }
  const nearest = (pv, pc) => { const base = pv - (((pv % 12) - pc + 12) % 12); let b = base, bd = Infinity; for (const c of [base - 12, base, base + 12]) if (Math.abs(c - pv) < bd) { bd = Math.abs(c - pv); b = c; } return b; };
  const used = new Set(); const out = [];
  for (const pv of prev.slice().sort((a, b) => a - b)) {
    let best = null, bestD = Infinity, bestPc = null;
    for (const pc of pcs) { if (used.has(pc)) continue; const n = nearest(pv, pc); if (Math.abs(n - pv) < bestD) { bestD = Math.abs(n - pv); best = n; bestPc = pc; } }
    if (best === null) { best = nearest(pv, pcs[0]); for (const pc of pcs) { const n = nearest(pv, pc); if (Math.abs(n - pv) < Math.abs(best - pv)) best = n; } } // more voices than tones
    else used.add(bestPc);
    out.push(best);
  }
  for (const pc of pcs) if (!used.has(pc)) { const top = Math.max(...out); let n = top - (((top % 12) - pc + 12) % 12); while (n <= top) n += 12; out.push(n); } // cover remaining tones up top
  return out.sort((a, b) => a - b);
}

// --- register-aware SPREAD voicing engine ----------------------------------
// DEFAULT 'spread' = the modern electronic voicing:
//   * LOW FOUNDATION — the chord root plus its octave double (root, root+12):
//     "play the root and its octave" like a two-osc bass under the chord;
//   * UPPER STRUCTURE — the chord's colour (3rd, 7th, 9th/6th…) fanned ABOVE
//     the foundation WITHOUT restating the root pitch-class (the bass already
//     owns the root, so the upper chord is rootless); the 5th is optional body.
// Register hygiene rules (the "session keyboardist" rules):
//   * below ~MIDI 52 only the ROOT and the perfect 5TH are allowed (anything else
//     is low-interval mud);
//   * 3rds and 7ths (guide tones) live at >= 52;
//   * 9ths/11ths/13ths (colour) live strictly ABOVE middle C (> 60);
//   * a SPREAD voicing may span up to ~3 octaves (close/drop voicings stay
//     tight by construction — they never enter this engine).

const SPREAD_SPAN = 36; // ~3 octaves for the wide electronic spread

// Lowest register a chord tone may be voiced in, from its interval above the root.
function toneFloor(iv) {
  const ivc = ((iv % 12) + 12) % 12;
  if (ivc === 0 || ivc === 7) return 0;               // root & perfect 5th: free
  if (iv >= 12 || ivc === 1 || ivc === 2) return 61;  // 9/11/13 colour: above middle C
  return 52;                                          // 3rds/7ths/sus/altered: out of the mud
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

function upperOrderings(set) {
  if (set.length <= 4) return permutations(set);
  const sorted = [...set].sort((a, b) => a.fl - b.fl || a.pc - b.pc);
  return sorted.map((_, i) => [...sorted.slice(i), ...sorted.slice(0, i)]); // rotations
}

// Stack one candidate: the LOW FOUNDATION (root + its octave double), then the
// given upper tones ascending, each >= a major 2nd above the last and respecting
// its register floor. Unplaceable COLOUR tones are dropped (register-aware
// enrichment); an unplaceable guide tone invalidates the shape.
function stackVoices(order, bass, cap) {
  const voices = [bass, bass + 12]; // foundation: low root and its octave
  let cur = bass + 14; // upper structure sits clear above the octave double
  for (const t of order) {
    const lo = Math.max(t.fl, cur);
    const n = lo + ((t.pc - (lo % 12) + 12) % 12);
    if (n - bass > cap) {
      if (t.fl >= 61) continue; // drop colour that can't fit above middle C in-span
      return null;
    }
    voices.push(n);
    cur = n + 2;
  }
  return voices;
}

// All register-legal spread shapes for one chord: low octave FOUNDATION
// (root, root+12) with the rootless UPPER STRUCTURE fanned above it.
// Candidates come on TWO foundation octaves so the progression planner can sit
// a chord lower/higher when that lets the leading tone resolve into the next
// chord's foundation (the resolved tonic often IS the next octave double).
function spreadCandidatesFor(pitches, bassMidi = 48) {
  const sorted = [...pitches].sort((a, b) => a - b);
  const root = sorted[0];
  const rootPc = ((root % 12) + 12) % 12;
  const floors = new Map(); // pc -> most permissive floor seen
  for (const p of sorted) {
    const pc = ((p % 12) + 12) % 12;
    const fl = toneFloor(p - root);
    if (!floors.has(pc) || fl < floors.get(pc)) floors.set(pc, fl);
  }
  const fifthPc = (rootPc + 7) % 12;
  const hasFifth = floors.get(fifthPc) === 0;
  // Upper-structure pool: every chord tone EXCEPT the root pc — the foundation
  // already states the root twice, so up top we use colour instead (rootless
  // upper). The plain 5th is pulled out and re-offered as optional body only.
  const base = [...floors.entries()]
    .filter(([pc, fl]) => pc !== rootPc && !(pc === fifthPc && fl === 0))
    .map(([pc, fl]) => ({ pc, fl }));

  // Colour tones are individually droppable (a keyboardist omits a 9th/13th when
  // the line doesn't want it) at a cost. DEFAULT = normal placements (guide tones
  // + the level-1 9); only a "lush/thick" request (enrichLevel >= 2 upstream)
  // stacks extra extensions into this upper structure.
  const core = base.filter((t) => t.fl < 61);
  const tensions = base.filter((t) => t.fl >= 61);
  const tensionSets = [[]];
  for (const t of tensions) for (const s of tensionSets.slice()) tensionSets.push([...s, t]);
  const subsets = []; // [{set, dropped}]
  for (const ts of tensionSets) {
    const u = [...core, ...ts];
    const dropped = tensions.length - ts.length;
    if (u.length) subsets.push({ set: u, dropped });
    if (hasFifth && u.length <= 3) subsets.push({ set: [...u, { pc: fifthPc, fl: 52 }], dropped }); // optional 5th for body
  }
  if (!subsets.length) subsets.push({ set: hasFifth ? [{ pc: fifthPc, fl: 52 }] : [], dropped: 0 });

  // foundation octaves: the root at/below the requested bass register + the octave up
  const bassLo = bassMidi - ((((bassMidi % 12) - rootPc) % 12) + 12) % 12;

  const byKey = new Map();
  for (const cap of [SPREAD_SPAN, SPREAD_SPAN + 2]) {
    for (const bass of [bassLo, bassLo + 12]) {
      const reg = Math.abs(bass - bassMidi); // distance from the asked-for register
      for (const { set, dropped } of subsets) {
        for (const order of upperOrderings(set)) {
          const v = stackVoices(order, bass, cap);
          if (!v) continue;
          const k = v.join(",");
          if (!byKey.has(k) || byKey.get(k).dropped > dropped) byKey.set(k, { v, dropped, reg });
          const top = v[v.length - 1];
          if (v.length > 2 && top + 12 - bass <= cap) {
            const lifted = [...v.slice(0, -1), top + 12]; // top-note variety for contour shaping
            const lk = lifted.join(",");
            if (!byKey.has(lk) || byKey.get(lk).dropped > dropped) byKey.set(lk, { v: lifted, dropped, reg });
          }
        }
      }
    }
    if (byKey.size) break; // only relax the span cap when nothing fits at all
  }
  return [...byKey.values()].map(({ v, dropped, reg }) => ({ voices: v, top: v[v.length - 1], bass: v[0], dropped, reg }));
}

// total semitone motion between two voicings (nearest-voice, symmetric)
function vlMoveCost(a, b) {
  let s = 0;
  for (const v of b) { let m = Infinity; for (const p of a) m = Math.min(m, Math.abs(v - p)); s += m; }
  for (const p of a) { let m = Infinity; for (const v of b) m = Math.min(m, Math.abs(p - v)); s += m; }
  return s / 2;
}
function commonTones(a, b) { const s = new Set(a); let c = 0; for (const v of b) if (s.has(v)) c++; return c; }

// Plan the WHOLE progression at once (dynamic programming over candidate voicings):
//   * minimal total semitone movement voice-to-voice, common tones retained
//   * the top notes form a singable line: mostly steps, one clear peak (arch target)
//   * V->I / V->i cadences resolve the leading tone UP A SEMITONE to the tonic
function planSpreadProgression(pitchSets, { bassMidi = 48 } = {}) {
  const infos = pitchSets.map((pitches) => {
    const root = Math.min(...pitches);
    const rootPc = ((root % 12) + 12) % 12;
    return {
      rootPc,
      pcs: new Set(pitches.map((p) => ((p % 12) + 12) % 12)),
      cands: spreadCandidatesFor(pitches, bassMidi),
    };
  });
  // dominant->tonic flags: next root a 4th up AND this chord carries the leading tone
  for (let i = 0; i + 1 < infos.length; i++) {
    infos[i].domOfNext =
      infos[i + 1].rootPc === (infos[i].rootPc + 5) % 12 &&
      infos[i].pcs.has((infos[i].rootPc + 4) % 12);
  }

  // top-note contour target: a single-peak arch over the progression (start a touch
  // low, rise to ONE clear peak ~60% through, settle back down)
  const n = infos.length;
  const t0 = infos[0].cands.map((c) => c.top).sort((a, b) => a - b);
  const baseTop = t0[Math.floor(t0.length / 2)];
  const peak = Math.max(1, Math.round((n - 1) * 0.6));
  const arch = infos.map((_, i) =>
    n < 3 ? baseTop : baseTop - 2 + 6 * (i <= peak ? i / peak : (n - 1 - i) / Math.max(1, n - 1 - peak)));

  infos.forEach((inf, i) => {
    inf.cands.sort((a, b) =>
      (Math.abs(a.top - arch[i]) + 0.5 * a.reg) - (Math.abs(b.top - arch[i]) + 0.5 * b.reg));
    inf.cands = inf.cands.slice(0, 96);
  });

  // top-line move cost: steps nearly free, a singable 3rd/4th mild, real leaps dear.
  // A flat repeat costs about as much as a small leap so the line arcs through ONE
  // clear peak instead of parking on it (the wide shapes made holds too cheap).
  const topMove = (dt) => (dt === 0 ? 2 : dt <= 2 ? dt * 0.25 : dt <= 4 ? 1 + (dt - 2) * 0.8 : 3 + (dt - 4) * 3);

  let layers = [infos[0].cands.map((c) => ({ cost: Math.abs(c.top - arch[0]) * 0.8 + 3.5 * c.dropped + 0.5 * c.reg, back: -1 }))];
  for (let i = 1; i < n; i++) {
    const prevInfo = infos[i - 1];
    const layer = infos[i].cands.map((cand) => {
      let bc = Infinity, bk = 0;
      for (let k = 0; k < prevInfo.cands.length; k++) {
        const pcand = prevInfo.cands[k];
        let cost = layers[i - 1][k].cost
          + vlMoveCost(pcand.voices, cand.voices)
          - 0.8 * commonTones(pcand.voices, cand.voices)
          + Math.abs(cand.top - arch[i]) * 0.8
          + 3.5 * cand.dropped // colour is the default — drop it only for the line
          + 0.5 * cand.reg; // stay near the asked-for bass register
        cost += topMove(Math.abs(cand.top - pcand.top));
        if (prevInfo.domOfNext) {
          const ltPc = (prevInfo.rootPc + 4) % 12; // = leading tone of the target key
          let lt = -1;
          for (const v of pcand.voices) if (((v % 12) + 12) % 12 === ltPc) lt = Math.max(lt, v);
          if (lt >= 0) cost += cand.voices.includes(lt + 1) ? -6 : 9; // resolve LT up a semitone
        }
        if (cost < bc) { bc = cost; bk = k; }
      }
      return { cost: bc, back: bk };
    });
    layers.push(layer);
  }
  let bi = 0;
  layers[n - 1].forEach((s, k) => { if (s.cost < layers[n - 1][bi].cost) bi = k; });
  const picks = new Array(n);
  for (let i = n - 1; i >= 0; i--) { picks[i] = infos[i].cands[bi].voices.slice(); bi = layers[i][bi].back; }
  return picks;
}

// SPREAD / OPEN voicing for a rich, modern electronic sound (the default).
//   chordPCs: pitch classes, FIRST element is the chord ROOT.
//   Shape: low foundation (root + octave double), rootless colour fanned above.
//   Register-aware: guide tones >= 52, colour above middle C, span <= ~3 octaves.
//   With a `prev` voicing it picks the register-legal shape with the least total
//   voice movement and the smoothest top note.
function spreadVoices(prev, chordPCs, { bassMidi = 48 } = {}) {
  const rootPc = ((chordPCs[0] % 12) + 12) % 12;
  const pseudo = chordPCs.map((pc) => 60 + ((((pc % 12) + 12) % 12) - rootPc + 12) % 12);
  const cands = spreadCandidatesFor(pseudo, bassMidi);
  let best = cands[0], bc = Infinity;
  for (const c of cands) {
    let cost;
    if (prev && prev.length) {
      const dt = Math.abs(c.top - Math.max(...prev));
      cost = vlMoveCost(prev, c.voices) - 1.2 * commonTones(prev, c.voices)
        + (dt <= 2 ? dt * 0.25 : 1 + (dt - 2) * 3) + 2.5 * c.dropped + 0.5 * c.reg;
    } else {
      cost = Math.abs(c.top - (bassMidi + 24)) * 0.5 + 2.5 * c.dropped + 0.5 * c.reg;
    }
    if (cost < bc) { bc = cost; best = c; }
  }
  return best ? best.voices.slice() : pseudo.sort((a, b) => a - b);
}

// 'duo' voicing — exactly TWO notes, made for analog two-osc patches: the chord
// root low plus ONE defining colour tone an octave-plus (12–24 semitones) above.
// Prefers the 3rd; when the chord carries extensions (7th/9th from enrich) it
// reaches for those instead. Lowest pitch of `pitches` is taken as the root.
function duoVoices(pitches, bassMidi = 48) {
  const root = Math.min(...pitches);
  const rootPc = ((root % 12) + 12) % 12;
  let bass = bassMidi - ((((bassMidi % 12) - rootPc) % 12) + 12) % 12;
  if (bassMidi - bass > 6) bass += 12; // root nearest the asked-for bass register
  const ivs = new Set(pitches.map((p) => (((p - root) % 12) + 12) % 12));
  const extended = ivs.has(10) || ivs.has(11) || ivs.has(1) || ivs.has(2);
  // colour preference: enriched -> 7th/9th first; plain -> the 3rd defines the chord
  const prefs = extended ? [10, 11, 2, 1, 4, 3, 9, 5] : [4, 3, 9, 5, 2, 1];
  let iv = prefs.find((x) => ivs.has(x));
  if (iv === undefined) iv = ivs.has(7) ? 7 : 12; // power chord / bare-root fallback
  // 12–24 semitones above the root: iv in 1..11 lands at bass+13..bass+23
  const colour = bass + (iv < 12 ? iv + 12 : iv);
  return [bass, colour];
}

// Enrich a triad/chord with colour tones (9th, and a 13th at level 2) for a richer,
// less "simple" sound. DEFAULT = normal placements (level 1: a single 9 in the
// upper structure); level >= 2 is the "user said lush/thick" case — extra
// extensions stack into the rootless upper structure. Register-aware: colour is
// added ABOVE middle C so it never thickens the low-mids (the voicing engine
// keeps it there too).
function enrichChord(pitches, level = 1) {
  const out = [...pitches];
  const root = Math.min(...pitches);
  if (level >= 1) { let nine = root + 14; while (nine <= 60) nine += 12; out.push(nine); }
  if (level >= 2) { let thirteen = root + 21; while (thirteen <= 60) thirteen += 12; out.push(thirteen); }
  return out.sort((a, b) => a - b);
}

// --- progressions ---------------------------------------------------------

// Parse a roman numeral token: "ii", "V7", "vi", "IVmaj7", "bVII".
function parseRoman(token, mode) {
  let t = token.trim();
  let flat = 0;
  while (t[0] === "b") { flat++; t = t.slice(1); }
  const m = t.match(/^([iIvV]+)(.*)$/);
  if (!m) throw new Error(`bad roman numeral: ${token}`);
  const base = m[1];
  const explicitQual = m[2]; // may be "", "7", "maj7", "dim", "m"...
  const degree = T.ROMAN[base.toLowerCase()];
  if (degree === undefined) throw new Error(`bad roman numeral: ${token}`);
  const isUpper = base === base.toUpperCase();
  return { degree, flat, explicitQual, isUpper };
}

// Build chord pitches for a roman numeral in a key.
function chordForRoman(token, tonicMidi, mode = "major", sevenths = false) {
  const { degree, flat, explicitQual, isUpper } = parseRoman(token, mode);
  const scale = T.SCALES[mode] || T.SCALES.major;
  let rootOffset = scale[degree % scale.length] - flat;
  const root = tonicMidi + rootOffset;

  let quality;
  if (explicitQual) {
    quality = explicitQual === "m" ? "min" : explicitQual;
  } else if (sevenths && T.DIATONIC_SEVENTHS[mode]) {
    quality = T.DIATONIC_SEVENTHS[mode][degree];
  } else if (T.DIATONIC_TRIADS[mode]) {
    quality = T.DIATONIC_TRIADS[mode][degree];
    // honour case override (e.g. "IV" in minor => major)
    if (isUpper && quality.startsWith("min")) quality = quality.replace("min", "maj");
    if (!isUpper && quality.startsWith("maj")) quality = quality.replace("maj", "min");
  } else {
    quality = isUpper ? "maj" : "min";
  }
  return T.buildChord(root, quality);
}

// --- humanize -------------------------------------------------------------

// Deterministic pseudo-random in [0,1) seeded by index — no global RNG so output
// is reproducible (important for tests and for re-running a prompt).
function seeded(i, salt = 1) {
  const x = Math.sin((i + 1) * 12.9898 * salt + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Snap a beat value to a clean musical grid so notes land exactly on the line.
// res = grid step in beats; 1/24 covers 1/16, 1/8, triplets and quarters cleanly.
function snapToGrid(beat, res = 1 / 24) {
  if (!res) return beat;
  return Math.round(beat / res) * res;
}

// timing: OFF unless an explicit, positive timing offset is requested (opt-in).
//   When timing>0 it is still a *seeded* feel offset; default callers pass 0.
// velocity: humanizing velocity is fine and stays available.
// grid: snap start times to a clean grid (default on) so nothing is "slightly off".
function humanize(notes, { timing = 0, velocity = 0, grid = 1 / 24 } = {}) {
  if (!timing && !velocity && !grid) return notes;
  return notes.map((n, i) => {
    let start = n.start + (timing ? (seeded(i, 1) - 0.5) * 2 * timing : 0);
    if (grid) start = snapToGrid(start, grid);
    return {
      ...n,
      start: Math.max(0, start),
      velocity: velocity
        ? Math.max(1, Math.min(127, Math.round(n.velocity + (seeded(i, 2) - 0.5) * 2 * velocity)))
        : n.velocity,
    };
  });
}

// --- top-level builders ---------------------------------------------------

// Write a chord progression to a flat note list.
//   key: "C" | midi  mode: "major"|...  chords: ["I","V","vi","IV"] or [{root,quality}]
//   opts: { octave, beatsPerChord, voicing, sevenths, inversion, voiceLeading, humanizeMs }
function writeProgression(key, mode, chords, opts = {}) {
  const {
    octave = 3, beatsPerChord = 4, voicing = "spread", sevenths = false,
    inversion = 0, voiceLeading = true, velocity = 90,
    humanizeTiming = 0, humanizeVelocity = 0, startBeat = 0,
    enrich = false, enrichLevel = 1,
  } = opts;
  const tonic = T.noteToMidi(typeof key === "number" ? key : String(key).replace(/-?\d+$/, "") + octave, octave); // strip any octave digits the caller embedded ("C3" means C)

  const built = chords.map((c) => {
    let pitches =
      typeof c === "string"
        ? chordForRoman(c, tonic, mode, sevenths || enrich) // enrich implies 7ths
        : T.buildChord(c.root, c.quality || "maj", { octave });
    if (enrich) pitches = enrichChord(pitches, enrichLevel); // add 9/13 colour (register-aware)
    const style = (typeof c === "object" && c.voicing) || voicing;
    return { c, pitches, style };
  });

  const blocky = (s) => s === "close" || s === "rootless" || s === "drop2" || s === "drop3";
  const planned = (s) => !blocky(s) && s !== "duo"; // spread/open go through the DP planner
  const notes = [];
  const emit = (voiced, idx) => {
    const start = startBeat + idx * beatsPerChord;
    for (const pitch of voiced) notes.push({ pitch, start, duration: beatsPerChord, velocity, mute: 0 });
  };

  if (voiceLeading && built.length && built.every((b) => planned(b.style))) {
    // SPREAD default: plan the whole progression — minimal voice motion, retained
    // common tones, register-clean colour, a singable top line, resolved cadences.
    planSpreadProgression(built.map((b) => b.pitches), { bassMidi: (octave + 1) * 12 })
      .forEach(emit);
  } else {
    let prev = null;
    built.forEach((b, idx) => {
      let voiced;
      if (b.style === "duo") {
        // analog two-osc mode: exactly two notes — low root + one colour tone
        voiced = duoVoices(b.pitches, (octave + 1) * 12);
        prev = voiced;
      } else if (voiceLeading && !blocky(b.style)) {
        const root = Math.min(...b.pitches);
        const rootPc = ((root % 12) + 12) % 12;
        const pcs = [rootPc, ...b.pitches.map((p) => ((p % 12) + 12) % 12).filter((pc) => pc !== rootPc)];
        voiced = spreadVoices(prev, pcs, { bassMidi: (octave + 1) * 12 });
        prev = voiced;
      } else if (voiceLeading) {
        voiced = leadVoices(prev, b.pitches.map((p) => p % 12)); // nearest-tone, grouped, smooth lead
        // drift guard: keep the voicing centred (~C4) so it doesn't creep up/down over a long progression
        const ctr = voiced.reduce((a, x) => a + x, 0) / voiced.length;
        if (ctr > 74) voiced = voiced.map((x) => x - 12);
        else if (ctr < 52) voiced = voiced.map((x) => x + 12);
        prev = voiced;
      } else {
        const inv = (typeof b.c === "object" ? b.c.inversion : undefined) ?? inversion;
        voiced = voiceChord(applyInversion(b.pitches, inv), b.style);
      }
      emit(voiced, idx);
    });
  }
  return humanize(notes, { timing: humanizeTiming, velocity: humanizeVelocity });
}

// Write a single chord (one hit).
function writeChord(root, quality, opts = {}) {
  const { beatsPerChord = 4, voicing = "close", inversion = 0, velocity = 90, startBeat = 0, octave = 3 } = opts;
  let pitches = T.buildChord(root, quality, { octave });
  pitches = voiceChord(applyInversion(pitches, inversion), voicing);
  return pitches.map((pitch) => ({ pitch, start: startBeat, duration: beatsPerChord, velocity, mute: 0 }));
}

// Write a melody from scale degrees (1-based) over a key/mode.
//   degrees: [1, 3, 5, 4, 2] ; rhythm: beats per note (number or array)
function writeMelody(key, mode, degrees, opts = {}) {
  const { octave = 4, rhythm = 1, velocity = 100, startBeat = 0, humanizeTiming = 0, humanizeVelocity = 0 } = opts;
  const tonic = T.noteToMidi(typeof key === "number" ? key : String(key).replace(/-?\d+$/, "") + octave, octave); // strip any octave digits the caller embedded ("C3" means C)
  const scale = T.SCALES[mode] || T.SCALES.major;
  let t = startBeat;
  const notes = degrees.map((deg, i) => {
    const d = typeof deg === "object" ? deg.degree : deg;
    const octShift = typeof deg === "object" ? deg.octave || 0 : 0;
    const idx = ((d - 1) % scale.length + scale.length) % scale.length;
    const octJump = Math.floor((d - 1) / scale.length);
    const pitch = tonic + scale[idx] + 12 * (octJump + octShift);
    const dur = Array.isArray(rhythm) ? rhythm[i % rhythm.length] : rhythm;
    // snap the running cursor to the grid every step so repeated += of e.g. 1/3
    // can't accumulate float drift — each note starts exactly on a gridline.
    const note = { pitch, start: snapToGrid(t), duration: dur, velocity, mute: 0 };
    t += dur;
    return note;
  });
  return humanize(notes, { timing: humanizeTiming, velocity: humanizeVelocity });
}

module.exports = {
  voiceChord, spreadVoices, duoVoices, applyInversion, voiceLead, parseRoman, chordForRoman,
  humanize, writeProgression, writeChord, writeMelody,
};
