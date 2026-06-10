// Minimal assertion harness — run: node melody.test.js
const T = require("./theory");
const M = require("./melody");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

const PROG = ["I", "V", "vi", "IV"];
const CHORD_PCS = { 0: [0, 4, 7], 1: [7, 11, 2], 2: [9, 0, 4], 3: [5, 9, 0] }; // I V vi IV in C
const MAJOR_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const barNotes = (m, bar, bpc = 4) => m.filter((n) => n.start >= bar * bpc && n.start < (bar + 1) * bpc);
const relOnsets = (m, bar, bpc = 4) => barNotes(m, bar, bpc).map((n) => +(n.start - bar * bpc).toFixed(3));

// --- basic shape ---
const mel = M.generateMelody("C", "major", PROG, { seed: 3 });
ok("melody returns notes", mel.length >= 12);
ok("every note well-formed (pitch/start/duration/velocity in range)", mel.every((n) =>
  Number.isFinite(n.pitch) && n.pitch >= 0 && n.pitch <= 127 &&
  n.start >= 0 && n.start < 16 && n.duration > 0 &&
  n.velocity >= 1 && n.velocity <= 127 && n.mute === 0));
ok("notes are in time order", mel.every((n, i) => i === 0 || n.start > mel[i - 1].start - 1e-9));

// --- in key ---
ok("every pitch is in C major", mel.every((n) => MAJOR_PCS.has(((n.pitch % 12) + 12) % 12)));

// --- chord tones on the strong beats (1 and 3 of each bar) ---
ok("notes on beats 1 & 3 are chord tones of the bar's chord", mel.every((n) => {
  const rel = n.start % 4, ci = Math.floor(n.start / 4);
  const strong = Math.abs(rel) < 1e-9 || Math.abs(rel - 2) < 1e-9;
  return !strong || CHORD_PCS[ci].includes(((n.pitch % 12) + 12) % 12);
}));
ok("every bar starts with a downbeat note", [0, 1, 2, 3].every((b) => relOnsets(mel, b).includes(0)));

// --- phrase architecture: A A' B A'' ---
eq("A' repeats the motif rhythm of A (bar 1 vs bar 0)", relOnsets(mel, 1), relOnsets(mel, 0));
ok("B phrase contrasts (bar 2 rhythm differs from the motif)",
  JSON.stringify(relOnsets(mel, 2)) !== JSON.stringify(relOnsets(mel, 0)));
ok("A' is an adaptation, not a parallel shift (pitches differ from A)",
  JSON.stringify(barNotes(mel, 1).map((n) => n.pitch)) !== JSON.stringify(barNotes(mel, 0).map((n) => n.pitch)));

// --- rests between phrases: every non-final bar stops short of the barline ---
ok("phrases breathe (>= 0.4 beats of rest before each new bar)", [0, 1, 2].every((b) => {
  const end = Math.max(...barNotes(mel, b).map((n) => n.start + n.duration));
  return end <= b * 4 + 3.6 + 1e-9;
}));

// --- melodic grammar ---
ok("leaps bigger than a 4th resolve by step in the opposite direction", (() => {
  for (let i = 1; i + 1 < mel.length; i++) {
    const d = mel[i].pitch - mel[i - 1].pitch;
    if (Math.abs(d) > 5) {
      const r = mel[i + 1].pitch - mel[i].pitch;
      if (!(Math.abs(r) <= 2 && Math.sign(r) === -Math.sign(d))) return false;
    }
  }
  return true;
})());
ok("never more than 3 identical consecutive pitches", (() => {
  let run = 1;
  for (let i = 1; i < mel.length; i++) {
    run = mel[i].pitch === mel[i - 1].pitch ? run + 1 : 1;
    if (run > 3) return false;
  }
  return true;
})());
ok("total range within an 11th (17 semitones)", (() => {
  const ps = mel.map((n) => n.pitch);
  return Math.max(...ps) - Math.min(...ps) <= 17;
})());

// --- cadence: the last phrase lands on the root or 3rd of the final chord ---
{
  const last = mel[mel.length - 1];
  ok("final note is the latest note", mel.every((n) => n.start <= last.start));
  ok("final note lands on beat 3 of the last bar", Math.abs(last.start - 14) < 1e-9);
  ok("final note is the root or 3rd of the final chord (IV: F or A)",
    [5, 9].includes(((last.pitch % 12) + 12) % 12));
  ok("final note rings (longer cadence duration)", last.duration >= 1.5);
}

// --- velocity phrasing ---
{
  const down = mel.filter((n) => n.start % 4 === 0 && n.start < 12);
  const weak = mel.filter((n) => (n.start % 4) % 1 !== 0 || ((n.start % 4) % 2 === 1));
  ok("downbeats are accented at the asked velocity", down.every((n) => n.velocity === 100));
  ok("passing tones are softer than the downbeats", weak.every((n) => n.velocity < 100));
}

// --- determinism & seed variety ---
eq("same seed => identical melody",
  M.generateMelody("C", "major", PROG, { seed: 7 }),
  M.generateMelody("C", "major", PROG, { seed: 7 }));
{
  const distinct = new Set();
  for (let s = 0; s < 8; s++) distinct.add(JSON.stringify(M.generateMelody("C", "major", PROG, { seed: s })));
  ok("different seeds give genuinely different melodies (>= 6 distinct of 8)", distinct.size >= 6);
}

// --- the hard properties hold across many seeds ---
{
  let cleanSeeds = true;
  for (let seed = 0; seed < 24 && cleanSeeds; seed++) {
    const m = M.generateMelody("C", "major", PROG, { seed });
    const ps = m.map((n) => n.pitch);
    if (Math.max(...ps) - Math.min(...ps) > 17) cleanSeeds = false;
    for (const n of m) {
      if (!MAJOR_PCS.has(((n.pitch % 12) + 12) % 12)) cleanSeeds = false;
      const rel = n.start % 4, ci = Math.floor(n.start / 4);
      if ((Math.abs(rel) < 1e-9 || Math.abs(rel - 2) < 1e-9) && !CHORD_PCS[ci].includes(((n.pitch % 12) + 12) % 12)) cleanSeeds = false;
    }
    const last = m[m.length - 1];
    if (!(Math.abs(last.start - 14) < 1e-9 && [5, 9].includes(((last.pitch % 12) + 12) % 12))) cleanSeeds = false;
  }
  ok("range/key/strong-beat/cadence guarantees hold for seeds 0..23", cleanSeeds);
}

// --- 2-bar motif for long progressions (8 chords): A spans bars 0-1, A' bars 2-3 ---
{
  const prog8 = ["I", "vi", "ii", "V", "I", "IV", "ii", "V"];
  const m8 = M.generateMelody("C", "major", prog8, { seed: 5 });
  const rel2 = (lo) => m8.filter((n) => n.start >= lo && n.start < lo + 8).map((n) => +(n.start - lo).toFixed(3));
  eq("2-bar motif rhythm repeats in A' (bars 0-1 vs 2-3)", rel2(8), rel2(0));
}

// --- minor mode cadence ---
{
  const mm = M.generateMelody("A", "minor", ["i", "VI", "VII", "i"], { seed: 4 });
  const last = mm[mm.length - 1];
  ok("minor: final note is root or 3rd of the final i chord (A or C)",
    [9, 0].includes(((last.pitch % 12) + 12) % 12));
}

// --- non-default beats per chord still lands anchors and stays in the clip ---
{
  const m2 = M.generateMelody("C", "major", PROG, { seed: 3, beatsPerChord: 2 });
  ok("beatsPerChord=2: all notes inside the clip", m2.every((n) => n.start >= 0 && n.start < 8));
  ok("beatsPerChord=2: strong-beat chord tones (beats 1 & 2 of each bar)", m2.every((n) => {
    const rel = n.start % 2, ci = Math.floor(n.start / 2);
    const strong = Math.abs(rel) < 1e-9 || Math.abs(rel - 1) < 1e-9;
    return !strong || CHORD_PCS[ci].includes(((n.pitch % 12) + 12) % 12);
  }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
