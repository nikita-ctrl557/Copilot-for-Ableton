// run: node core/key.test.js
const K = require("./key");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));

// helper: build a histogram emphasizing given pitch-class names
const PC = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
function hist(weights) { const h = new Array(12).fill(0); for (const [n, w] of Object.entries(weights)) h[PC[n]] = w; return h; }

// C major: tonic triad C-E-G strong + diatonic scale present
{
  const h = hist({ C: 10, D: 4, E: 8, F: 4, G: 9, A: 4, B: 3 });
  const r = K.detectKey(h);
  ok("C major detected (" + r.key + ", conf " + r.confidence + ")", r.tonic === "C" && r.mode === "major");
}
// A minor: A-C-E strong, natural minor scale
{
  const h = hist({ A: 10, B: 3, C: 8, D: 4, E: 9, F: 4, G: 4 });
  const r = K.detectKey(h);
  ok("A minor detected (" + r.key + ")", r.tonic === "A" && r.mode === "minor");
}
// G major: F# present (the giveaway vs C major)
{
  const h = hist({ G: 10, A: 4, B: 8, C: 4, D: 9, E: 4, "F#": 6 });
  const r = K.detectKey(h);
  ok("G major detected (" + r.key + ")", r.tonic === "G" && r.mode === "major");
}
// F# minor (vocal-ish)
{
  const h = hist({ "F#": 10, "G#": 3, A: 8, B: 4, "C#": 9, D: 4, E: 4 });
  const r = K.detectKey(h);
  ok("F# minor detected (" + r.key + ")", r.tonic === "F#" && r.mode === "minor");
}

// chord suggestions for C major
{
  const s = K.suggestChords(0, "major");
  ok("C major diatonic I = C", s.diatonic[0].name === "C");
  ok("C major vi = Am", s.diatonic[5].name === "Am");
  ok("offers I-V-vi-IV", s.progressions.some(p => p.join("") === "IViIV".replace(/.*/, "IVviIV") || p.join("-") === "I-V-vi-IV"));
}
// histogram from MIDI pitches
{
  const h = K.histFromPitches([60, 64, 67, 60, 72]); // C E G C C
  ok("histFromPitches counts C=3,E=1,G=1", h[0] === 3 && h[4] === 1 && h[7] === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
