// melody.js — a phrase-based melody/hook generator (not a random walk):
//   - a seeded 1–2 bar MOTIF (rhythm cell + contour) developed A A' B A'' across the
//     progression: A' re-maps the motif's chord-tone ROLES onto the current chord
//     (real adaptation, not a parallel shift), B contrasts (new rhythm, inverted
//     contour), and the final phrase CADENCES on the root/3rd of the last chord
//   - CHORD TONES land on beats 1 and 3 of each bar; non-chord tones move by STEP;
//     leaps bigger than a 4th resolve by step in the opposite direction
//   - RESTS between phrases (each bar stops short of the barline so the line breathes)
//   - total range capped at an 11th; never more than 3 identical pitches in a row
//   - velocity phrasing: accented downbeats, softer passing tones (1..127)
//   - fully deterministic per seed; different seeds give genuinely different motifs
// Output = Live clip notes {pitch, start(beats), duration, velocity, mute}.
const T = require("./theory");
const ch = require("./chords");

function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Motif rhythm cells (onsets within a 4-beat bar). Every cell hits beat 1 AND beat 3
// (the chord-tone anchors) and its last onset is <= beat 4, so each bar can breathe.
const RHYTHMS = [
  [0, 1, 2, 3],
  [0, 1, 1.5, 2, 3],
  [0, 0.5, 1, 2, 2.5],
  [0, 1.5, 2, 3],
  [0, 0.5, 2, 2.5, 3],
  [0, 1, 2, 2.5, 3],
];

// Build one bar of motif: anchors (chord-tone roles) on beats 1 & 3, steps between,
// possibly an inner rest, and at most one chord-tone leap that a step then resolves.
// `invertOf` makes a CONTRAST cell: same machinery, contour dirs inverted vs source.
function makeCell(r, rhythmIdx, invertOf) {
  const onsets = RHYTHMS[rhythmIdx];
  const srcDirs = invertOf ? invertOf.events.filter((e) => e.dir).map((e) => e.dir) : null;
  let si = 0;
  const events = onsets.map((on) => {
    if (on === 0 || on === 2) return { on, type: "anchor", role: Math.floor(r() * 3) };
    const dir = srcDirs && srcDirs.length ? -srcDirs[si++ % srcDirs.length] : (r() < 0.5 ? -1 : 1);
    return { on, type: "step", dir };
  });
  // space inside the bar too: one weak event may become a rest (never the downbeat)
  const weak = events.map((e, i) => (e.type === "step" ? i : -1)).filter((i) => i > 0);
  if (weak.length > 1 && r() < 0.45) events[weak[Math.floor(r() * weak.length)]].type = "rest";
  // one leap for character — only where another step follows to resolve it
  for (let i = 0; i + 1 < events.length; i++) {
    if (events[i].type === "step" && events[i + 1].type === "step" && r() < 0.4) { events[i].type = "leap"; break; }
  }
  return { rhythmIdx, events };
}

function generateMelody(key, mode, chordList, opts = {}) {
  const { octave = 4, beatsPerChord = 4, seed = 0, velocity = 100 } = opts;
  const scaleIv = T.SCALES[mode] || T.SCALES.major;
  const tonicMidi = T.noteToMidi(typeof key === "number" ? key : String(key), octave);

  // scale register (an octave below to two above the tonic — the window clamps it)
  const reg = [];
  for (let o = -1; o <= 2; o++) for (const iv of scaleIv) reg.push(tonicMidi + o * 12 + iv);
  reg.sort((a, b) => a - b);
  const regIndexNear = (p) => { let bi = 0, bd = 1e9; for (let i = 0; i < reg.length; i++) { const d = Math.abs(reg[i] - p); if (d < bd) { bd = d; bi = i; } } return bi; };

  const r = rng(seed + 1);

  // chord-tone tables: pcs ordered by interval above the root (root, 3rd, 5th, 7th…)
  const chordInfos = chordList.map((c) => {
    let pitches;
    try {
      pitches = typeof c === "string"
        ? ch.chordForRoman(c, tonicMidi, mode, false)
        : T.buildChord(c.root, c.quality || "maj", { octave });
    } catch (e) { pitches = [tonicMidi, tonicMidi + 4, tonicMidi + 7]; }
    const rootPc = ((Math.min(...pitches) % 12) + 12) % 12;
    const pcs = [...new Set(pitches.map((p) => ((p % 12) + 12) % 12))];
    pcs.sort((a, b) => ((a - rootPc + 12) % 12) - ((b - rootPc + 12) % 12));
    return { rolePcs: pcs, pcSet: new Set(pcs) };
  });

  // phrase plan: A A' B A'' (cycled); long even progressions get a 2-bar motif
  const N = chordList.length;
  const phraseLen = N >= 8 && N % 2 === 0 ? 2 : 1;
  const cellA = [makeCell(r, Math.floor(r() * RHYTHMS.length))];
  if (phraseLen === 2) cellA.push(makeCell(r, cellA[0].rhythmIdx));
  let bIdx = Math.floor(r() * RHYTHMS.length);
  if (bIdx === cellA[0].rhythmIdx) bIdx = (bIdx + 3) % RHYTHMS.length; // B = new rhythm…
  const cellB = [makeCell(r, bIdx, cellA[0])];                         // …and inverted contour
  if (phraseLen === 2) cellB.push(makeCell(r, bIdx, cellA[1]));

  const sc = beatsPerChord / 4; // rhythm cells are written for 4-beat bars
  const notes = [];
  let prev = null, lo = 0, hi = 127, pending = 0, run = 0;

  const pcNear = (pc, target) => {
    let best = null, bd = 1e9;
    for (let p = ((pc % 12) + 12) % 12; p <= 127; p += 12) {
      if (p < lo || p > hi) continue;
      const d = Math.abs(p - target);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const nearestChordTone = (pcSet, target, excl = -1) => {
    let best = null, bd = 1e9;
    for (let p = Math.max(0, lo); p <= Math.min(127, hi); p++) {
      if (p === excl || !pcSet.has(((p % 12) + 12) % 12)) continue;
      const d = Math.abs(p - target);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const push = (pitch, start, duration, vel) => {
    notes.push({ pitch, start, duration, velocity: Math.max(1, Math.min(127, vel)), mute: 0 });
    run = pitch === prev ? run + 1 : 1;
    pending = prev !== null && Math.abs(pitch - prev) > 5 ? -Math.sign(pitch - prev) : 0;
    prev = pitch;
    if (notes.length === 1) { lo = pitch - 7; hi = pitch + 10; } // total range: an 11th
  };

  chordList.forEach((c, idx) => {
    const info = chordInfos[idx];
    const phraseIdx = Math.floor(idx / phraseLen);
    const letter = ["A", "A", "B", "A"][phraseIdx % 4];
    const cell = (letter === "B" ? cellB : cellA)[idx % phraseLen];
    const isFinalBar = idx === N - 1;
    const barStart = idx * beatsPerChord;
    const cadOn = 2 * sc; // the cadence lands on beat 3 of the final bar

    const events = cell.events;
    for (let j = 0; j < events.length; j++) {
      const ev = events[j];
      const on = ev.on * sc;
      if (on >= beatsPerChord - 1e-9) continue;
      if (isFinalBar && on >= cadOn - 1e-9) break; // the cadence takes over from here
      if (ev.type === "rest") continue;

      let pitch = null;
      if (ev.type === "anchor") {
        const rolePc = info.rolePcs[ev.role % info.rolePcs.length];
        pitch = prev === null ? pcNear(rolePc, tonicMidi + 12) : pcNear(rolePc, prev);
        if (prev !== null && (pitch === null || Math.abs(pitch - prev) > 5)) {
          pitch = nearestChordTone(info.pcSet, prev); // stay smooth AND on a chord tone
        }
      } else {
        const dir = pending || ev.dir;
        if (ev.type === "leap" && !pending) {
          // chord-tone leap of a 4th–6th; the following step resolves it (opposite dir)
          let bd = 1e9;
          for (let p = Math.max(lo, prev - 9); p <= Math.min(hi, prev + 9); p++) {
            const d = (p - prev) * dir;
            if (d < 4 || d > 9 || !info.pcSet.has(((p % 12) + 12) % 12)) continue;
            const dd = Math.abs(p - (prev + 7 * dir));
            if (dd < bd) { bd = dd; pitch = p; }
          }
        }
        if (pitch === null) { // plain step (also: leap fallback, forced resolution)
          let i2 = regIndexNear(prev) + dir;
          i2 = Math.max(0, Math.min(reg.length - 1, i2));
          if (reg[i2] < lo || reg[i2] > hi) i2 = Math.max(0, Math.min(reg.length - 1, regIndexNear(prev) - dir));
          pitch = reg[i2];
        }
      }
      // never more than 3 identical consecutive pitches
      if (pitch === prev && run >= 3) {
        if (ev.type === "anchor") pitch = nearestChordTone(info.pcSet, prev, prev) ?? pitch;
        else {
          const away = prev > (lo + hi) / 2 ? -1 : 1;
          pitch = reg[Math.max(0, Math.min(reg.length - 1, regIndexNear(prev) + away))];
        }
      }

      const nextOn = (j + 1 < events.length ? events[j + 1].on : 4) * sc;
      // notes stop short of the barline so there's a REST before the next phrase
      const dur = Math.max(0.2, Math.min(Math.min(nextOn - on, 1) - 0.05, beatsPerChord - 0.5 - on));
      const vel = ev.type === "anchor"
        ? (on === 0 ? velocity : velocity - 5)            // downbeat accent, beat-3 a touch less
        : Math.round(velocity * 0.8 + (r() - 0.5) * 6);   // softer passing tones
      push(pitch, barStart + on, dur, vel);
    }

    if (isFinalBar) {
      // cadence: land on the ROOT or 3RD of the final chord and let it ring
      const rootPc = info.rolePcs[0];
      const thirdPc = info.rolePcs.length > 1 ? info.rolePcs[1] : rootPc;
      const target = prev === null ? tonicMidi + 12 : prev;
      const cr = pcNear(rootPc, target), ct = pcNear(thirdPc, target);
      let pitch = cr;
      if (ct !== null && (cr === null || Math.abs(ct - target) < Math.abs(cr - target))) pitch = ct;
      if (pitch === null) pitch = target;
      push(pitch, barStart + cadOn, beatsPerChord - cadOn - 0.05, Math.min(127, velocity + 2));
    }
  });

  // snap to a clean grid (no off-grid)
  const SNAP = 1 / 24;
  for (const n of notes) n.start = Math.round(n.start / SNAP) * SNAP;
  return notes;
}

module.exports = { generateMelody };
