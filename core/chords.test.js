// Minimal assertion harness — run: node chords.test.js
const T = require("./theory");
const C = require("./chords");

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

// --- note parsing ---
eq("C3 = 60", T.noteToMidi("C3"), 60);
eq("A4 = 81", T.noteToMidi("A4"), 81);
eq("F#3 = 66", T.noteToMidi("F#3"), 66);
eq("Bb2 = 58", T.noteToMidi("Bb2"), 58);
eq("midiToNote 60", T.midiToNote(60), "C3");

// --- chords ---
eq("C maj triad", T.buildChord("C3", "maj"), [60, 64, 67]);
eq("A min triad", T.buildChord("A3", "min"), [69, 72, 76]);
eq("G dom7", T.buildChord("G3", "7"), [67, 71, 74, 77]);
eq("D min7", T.buildChord("D3", "min7"), [62, 65, 69, 72]);

// --- diatonic progression in C major: I V vi IV ---
const prog = C.writeProgression("C", "major", ["I", "V", "vi", "IV"], {
  octave: 3, beatsPerChord: 4, voiceLeading: false, voicing: "close",
});
// I = C(60,64,67), V = G(67,71,74), vi = Am(69,72,76), IV = F(65,69,72)
const pitchesAt = (b) => prog.filter((n) => n.start === b).map((n) => n.pitch).sort((a, z) => a - z);
eq("I  @0  = C major", pitchesAt(0), [60, 64, 67]);
eq("V  @4  = G major", pitchesAt(4), [67, 71, 74]);
eq("vi @8  = A minor", pitchesAt(8), [69, 72, 76]);
eq("IV @12 = F major", pitchesAt(12), [65, 69, 72]);
ok("progression has 12 notes (4 triads)", prog.length === 12);
ok("every note has start/duration/velocity/pitch", prog.every(n =>
  Number.isFinite(n.pitch) && Number.isFinite(n.start) && n.duration > 0 && n.velocity >= 1));

// --- voice leading keeps chords close (smaller leaps than root position) ---
const led = C.writeProgression("C", "major", ["I", "V", "vi", "IV"], { voiceLeading: true, voicing: "close" });
const topLine = (notes) => [0, 4, 8, 12].map((b) => Math.max(...notes.filter(n => n.start === b).map(n => n.pitch)));
const spread = (line) => Math.max(...line) - Math.min(...line);
ok("voice-leading tightens the top line vs root position",
  spread(topLine(led)) <= spread(topLine(prog)));

// --- minor key: i iv v in A minor ---
const am = C.writeProgression("A", "minor", ["i", "iv", "v"], { octave: 3, voiceLeading: false, voicing: "close" });
eq("i @0 = A minor", am.filter(n => n.start === 0).map(n => n.pitch).sort((a, z) => a - z), [69, 72, 76]);

// --- DEFAULT voicing is now 'spread': much wider than close, root in the bass ---
const sp = C.writeProgression("C", "major", ["I", "V", "vi", "IV"], { octave: 3, enrich: true });
const spAt = (b) => sp.filter((n) => n.start === b).map((n) => n.pitch).sort((a, z) => a - z);
ok("spread voicing spans > 1.5 octaves (wide, not a cramped cluster)", spAt(0)[spAt(0).length - 1] - spAt(0)[0] >= 19);
ok("spread voicing keeps the root in the bass register (<= C3)", spAt(0)[0] <= 48);
ok("spread voicing has no cramped low cluster (every adjacent gap >= a major 2nd)",
  [0, 4, 8, 12].every((b) => { const p = spAt(b); return p.slice(1).every((x, i) => x - p[i] >= 2); }));

// --- melody: C major scale degrees 1..7 ascending ---
const mel = C.writeMelody("C", "major", [1, 2, 3, 4, 5, 6, 7, 8], { octave: 4, rhythm: 1 });
eq("melody pitches = C major scale", mel.map(n => n.pitch), [72, 74, 76, 77, 79, 81, 83, 84]);
eq("melody is sequential in time", mel.map(n => n.start), [0, 1, 2, 3, 4, 5, 6, 7]);

// --- voicings ---
ok("drop2 lowers the 2nd-from-top voice", (() => {
  const close = T.buildChord("C3", "maj7"); // 60,64,67,71
  const d2 = C.voiceChord(close, "drop2");
  return d2.includes(67 - 12); // the 67 (G) dropped an octave -> 55
})());

// === register hygiene, top-line contour, cadences (the new voicing engine) ===

// helpers: group a progression's notes per chord
const chordSlices = (prog, bpc = 4) => {
  const m = new Map();
  for (const n of prog) {
    const ci = Math.floor(n.start / bpc + 1e-6);
    if (!m.has(ci)) m.set(ci, []);
    m.get(ci).push(n.pitch);
  }
  return [...m.keys()].sort((a, b) => a - b).map((k) => m.get(k).sort((a, b) => a - b));
};
const ROMAN_ROOT_PC = { I: 0, ii: 2, iii: 4, IV: 5, V: 7, vi: 9, i: 0, III: 3, iv: 5, v: 7, VI: 8, VII: 10 };

// --- no colour below the mud line: 3rds/7ths >= 52, 9ths above middle C ---
{
  let clean = true;
  for (const [key, mode, roms] of [
    ["C", "major", ["I", "V", "vi", "IV"]],
    ["Db", "major", ["I", "V", "vi", "IV"]],
    ["A", "minor", ["i", "VI", "III", "VII"]],
  ]) {
    const tonicPc = T.noteToMidi(key + "3") % 12;
    const prog = C.writeProgression(key, mode, roms, { enrich: true });
    chordSlices(prog).forEach((pitches, ci) => {
      const rootPc = (tonicPc + ROMAN_ROOT_PC[roms[ci]]) % 12;
      for (const p of pitches) {
        const iv = ((p - rootPc) % 12 + 12) % 12;
        if (p < 52 && iv !== 0 && iv !== 7) clean = false;        // only root/5th low
        if ((iv === 1 || iv === 2) && p <= 60) clean = false;     // 9ths above middle C
        if ((iv === 3 || iv === 4 || iv === 10 || iv === 11) && p < 52) clean = false; // guide tones
      }
    });
  }
  ok("enriched voicings: no 3rd/7th/9th below MIDI 52, 9ths above middle C", clean);
}

// --- 13ths (enrich level 2) also live above middle C ---
{
  const prog = C.writeProgression("C", "major", ["I", "IV", "V", "I"], { enrich: true, enrichLevel: 2 });
  const roms = ["I", "IV", "V", "I"];
  let clean = true;
  chordSlices(prog).forEach((pitches, ci) => {
    const rootPc = ROMAN_ROOT_PC[roms[ci]];
    for (const p of pitches) {
      const iv = ((p - rootPc) % 12 + 12) % 12;
      if ((iv === 2 || iv === 9) && p <= 60) clean = false; // 9th & 13th colour
    }
  });
  ok("enrichLevel 2: 13th colour voiced above middle C", clean);
}

// --- spread is WIDE now (electronic spec): may exceed the old 2.2-octave cap,
// --- but never balloons past ~3.2 octaves. (Deliberate spec change: the old
// --- "<= 27 semitones" assertion is gone — tight caps belong to close/drop.)
{
  const prog = C.writeProgression("C", "major", ["I", "vi", "ii", "V", "I", "IV", "ii", "V"], { enrich: true, enrichLevel: 2 });
  ok("spread span capped at ~3.2 octaves (<= 38 semitones)",
    chordSlices(prog).every((p) => p[p.length - 1] - p[0] <= 38));
  // a lush (enrichLevel 2) chord actually USES the new width: foundation + 3rd,
  // 7th, 9th, 13th stacked above clears the old 26-semitone cap
  const lush = chordSlices(C.writeProgression("C", "major", ["I"], { enrich: true, enrichLevel: 2 }))[0];
  ok("lush spread exceeds the old 2.2-octave cap (> 27 semitones)",
    lush[lush.length - 1] - lush[0] > 27);
}

// --- top-note line: singable (mostly steps, no big leaps, one clear peak) ---
{
  const topsOf = (roms, opts) => chordSlices(C.writeProgression("C", "major", roms, opts)).map((p) => p[p.length - 1]);
  const t4 = topsOf(["I", "V", "vi", "IV"], { enrich: true });
  const t8 = topsOf(["I", "vi", "ii", "V", "I", "IV", "ii", "V"], { enrich: true });
  const moves = (t) => t.slice(1).map((x, i) => Math.abs(x - t[i]));
  ok("top line: no move bigger than a 4th", [...moves(t4), ...moves(t8)].every((d) => d <= 5));
  ok("top line: at least half the moves are steps (<= 2 semitones)",
    [t4, t8].every((t) => moves(t).filter((d) => d <= 2).length * 2 >= moves(t).length));
  ok("top line: not a flat drone (the contour actually moves)",
    [t4, t8].every((t) => Math.max(...t) > Math.min(...t)));
  ok("top line: one clear peak (max top hit at most twice)",
    [t4, t8].every((t) => t.filter((x) => x === Math.max(...t)).length <= 2));
}

// --- voice-leading: common tones retained, upper voices move by tiny amounts ---
{
  const slices = chordSlices(C.writeProgression("C", "major", ["I", "vi", "ii", "V"], { enrich: true }));
  let shared = 0, upperMove = 0, upperCount = 0;
  for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1], b = slices[i];
    shared += b.filter((p) => a.includes(p)).length;
    for (const p of b.filter((x) => x >= 52)) { // upper structure
      upperMove += Math.min(...a.map((q) => Math.abs(p - q)));
      upperCount++;
    }
  }
  ok("voice-leading: common tones retained across the progression", shared >= 3);
  ok("voice-leading: upper voices move <= 3 semitones on average", upperMove / upperCount <= 3);
}

// --- V -> I cadence: the leading tone resolves UP A SEMITONE to the tonic ---
{
  const prog = C.writeProgression("C", "major", ["V", "I"], {});
  const [v, i] = chordSlices(prog);
  const lt = Math.max(...v.filter((p) => p % 12 === 11)); // B in the V chord
  ok("V->I (major): leading tone present in V", lt > 0);
  ok("V->I (major): leading tone resolves up a semitone to the tonic", i.includes(lt + 1));
}
{
  const prog = C.writeProgression("A", "minor", ["V7", "i"], {});
  const [v, i] = chordSlices(prog);
  const lt = Math.max(...v.filter((p) => p % 12 === 8)); // G# in E7
  ok("V7->i (minor): leading tone resolves up a semitone to the tonic", lt > 0 && i.includes(lt + 1));
}

// --- enrich stays register-aware even in blocky voicings (close + enrich) ---
{
  const prog = C.writeProgression("C", "major", ["I"], { voicing: "close", voiceLeading: false, enrich: true, octave: 1 });
  const ninths = prog.map((n) => n.pitch).filter((p) => p % 12 === 2); // D = the added 9th
  ok("enrichChord lifts the 9th above middle C regardless of chord octave",
    ninths.length > 0 && ninths.every((p) => p > 60));
}

// === the modern electronic 'spread' shape (the producer spec) ===============
// Low foundation = root + its octave double; the chord's colour lives ABOVE it
// and never restates the root pitch-class (rootless upper structure).

// --- spread: each chord's two lowest notes are the root and its octave double ---
{
  let foundation = true, rootless = true;
  for (const [key, mode, roms, opts] of [
    ["C", "major", ["I", "V", "vi", "IV"], { enrich: true }],
    ["C", "major", ["I", "V", "vi", "IV"], {}], // plain triads, default opts
    ["A", "minor", ["i", "VI", "III", "VII"], { enrich: true, enrichLevel: 2 }],
  ]) {
    const tonicPc = T.noteToMidi(key + "3") % 12;
    chordSlices(C.writeProgression(key, mode, roms, opts)).forEach((p, ci) => {
      const rootPc = (tonicPc + ROMAN_ROOT_PC[roms[ci]]) % 12;
      if (p[0] % 12 !== rootPc || p[1] - p[0] !== 12) foundation = false;   // root + root+12 low
      if (p.slice(2).some((x) => x % 12 === rootPc)) rootless = false;     // no root up top
    });
  }
  ok("spread: two lowest notes are root + its octave double (root, root+12)", foundation);
  ok("spread: upper structure never restates the root pitch-class (rootless)", rootless);
}

// --- duo: exactly two notes — low root + ONE colour tone 12–24 semitones up ---
{
  const tonicPc = 0; // C
  const duo = C.writeProgression("C", "major", ["I", "V", "vi", "IV"], { voicing: "duo" });
  ok("duo: exactly 2 notes per chord (8 total for 4 chords)", duo.length === 8);
  const slices = chordSlices(duo);
  const roms = ["I", "V", "vi", "IV"];
  ok("duo: lower note is the chord root",
    slices.every((p, ci) => p[0] % 12 === (tonicPc + ROMAN_ROOT_PC[roms[ci]]) % 12));
  ok("duo: colour tone sits 12-24 semitones above the root",
    slices.every((p) => p[1] - p[0] >= 12 && p[1] - p[0] <= 24));
  // plain triads: the defining colour is the 3rd
  const THIRD_PC = { I: 4, V: 11, vi: 0, IV: 9 }; // E, B, C, A in C major
  ok("duo (plain): the colour tone is the 3rd",
    slices.every((p, ci) => p[1] % 12 === THIRD_PC[roms[ci]]));
  // enriched: the defining colour becomes a 7th/9th
  const duoE = chordSlices(C.writeProgression("C", "major", ["I", "V", "vi", "IV"], { voicing: "duo", enrich: true }));
  ok("duo (enriched): exactly 2 notes per chord, colour is a 7th or 9th",
    duoE.every((p, ci) => {
      const iv = ((p[1] - (tonicPc + ROMAN_ROOT_PC[roms[ci]])) % 12 + 12) % 12;
      return p.length === 2 && [10, 11, 1, 2].includes(iv);
    }));
  ok("duo (enriched): colour still 12-24 above the root",
    duoE.every((p) => p[1] - p[0] >= 12 && p[1] - p[0] <= 24));
}

// --- determinism: same input -> byte-identical output (seeded humanize only) ---
{
  const a = C.writeProgression("C", "major", ["I", "vi", "ii", "V"], { enrich: true });
  const b = C.writeProgression("C", "major", ["I", "vi", "ii", "V"], { enrich: true });
  ok("determinism: spread progression is reproducible", JSON.stringify(a) === JSON.stringify(b));
  const d1 = C.writeProgression("C", "major", ["I", "V"], { voicing: "duo", enrich: true });
  const d2 = C.writeProgression("C", "major", ["I", "V"], { voicing: "duo", enrich: true });
  ok("determinism: duo progression is reproducible", JSON.stringify(d1) === JSON.stringify(d2));
}

// --- 12-keys x major/minor sweep: foundation, rootless upper, span, floors, duo ---
{
  const KEYS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  let foundation = true, rootless = true, span = true, floors = true, duo = true;
  for (const key of KEYS) {
    const tonicPc = T.noteToMidi(key + "3") % 12;
    for (const [mode, roms] of [
      ["major", ["I", "V", "vi", "IV"]],
      ["minor", ["i", "VI", "III", "VII"]],
    ]) {
      const slices = chordSlices(C.writeProgression(key, mode, roms, { enrich: true }));
      slices.forEach((p, ci) => {
        const rootPc = (tonicPc + ROMAN_ROOT_PC[roms[ci]]) % 12;
        if (p[0] % 12 !== rootPc || p[1] - p[0] !== 12) foundation = false;
        if (p.slice(2).some((x) => x % 12 === rootPc)) rootless = false;
        if (p[p.length - 1] - p[0] > 38) span = false;
        for (const x of p) {
          const iv = ((x - rootPc) % 12 + 12) % 12;
          if (x < 52 && iv !== 0 && iv !== 7) floors = false;     // only root/5th low
          if ((iv === 1 || iv === 2) && x <= 60) floors = false;  // 9ths above middle C
        }
      });
      const dslices = chordSlices(C.writeProgression(key, mode, roms, { voicing: "duo" }));
      dslices.forEach((p, ci) => {
        const rootPc = (tonicPc + ROMAN_ROOT_PC[roms[ci]]) % 12;
        if (p.length !== 2 || p[0] % 12 !== rootPc) duo = false;
        if (p[1] - p[0] < 12 || p[1] - p[0] > 24) duo = false;
      });
    }
  }
  ok("sweep 12 keys x major/minor: foundation = root + octave double", foundation);
  ok("sweep 12 keys x major/minor: rootless upper structure", rootless);
  ok("sweep 12 keys x major/minor: span <= ~3.2 octaves", span);
  ok("sweep 12 keys x major/minor: register floors hold", floors);
  ok("sweep 12 keys x major/minor: duo = 2 notes, root low, colour 12-24 up", duo);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
