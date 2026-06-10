// test-audio2midi.js — synthetic-signal tests for core/audioToMidi.js.
// Builds known beatbox-like and hummed-melody-like signals in memory (16 kHz mono,
// the voice pipeline's rate) and asserts detection, classification, quantization,
// and the auto-mode pivot (voicedRatio). No Live, no files, no deps.
//   run: node scripts/test-audio2midi.js

const a2m = require("../core/audioToMidi");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));

const SR = 16000;
const BPM = 120;          // beat = 0.5s
const sec = (n) => Math.round(n * SR);

function silence(seconds) { return new Float32Array(sec(seconds)); }
function addKick(buf, at) {
  // 70 Hz sine, pitch+amp decay over 180ms — reads as low-dominant
  const n0 = sec(at);
  for (let i = 0; i < sec(0.18); i++) {
    const t = i / SR;
    const env = Math.exp(-t * 22);
    const f = 70 * Math.exp(-t * 3) + 45;
    if (n0 + i < buf.length) buf[n0 + i] += 0.9 * env * Math.sin(2 * Math.PI * f * t);
  }
}
let seed = 1234567;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
function addHat(buf, at) {
  // 30ms of high-passed noise (differentiated noise ≈ high band)
  const n0 = sec(at);
  let prev = 0;
  for (let i = 0; i < sec(0.03); i++) {
    const w = rnd();
    const hp = w - prev; prev = w;
    if (n0 + i < buf.length) buf[n0 + i] += 1.4 * hp * Math.exp(-i / SR * 80);
  }
}
function addSnare(buf, at) {
  // body tone ~190 Hz + broadband noise, 120ms
  const n0 = sec(at);
  for (let i = 0; i < sec(0.12); i++) {
    const t = i / SR;
    const env = Math.exp(-t * 18);
    if (n0 + i < buf.length) buf[n0 + i] += env * (0.45 * Math.sin(2 * Math.PI * 190 * t) + 0.5 * rnd());
  }
}
function addTone(buf, at, hz, dur) {
  const n0 = sec(at);
  for (let i = 0; i < sec(dur); i++) {
    const t = i / SR;
    const env = Math.min(1, t * 50) * Math.min(1, (dur - t) * 50);
    if (n0 + i < buf.length) buf[n0 + i] += 0.5 * env * Math.sin(2 * Math.PI * hz * t);
  }
}

// ---- beatbox → drums -------------------------------------------------------
{
  const buf = silence(4.2);
  [0, 1, 2, 3].forEach((t) => addKick(buf, t));                       // beats 0,2,4,6
  [0.5, 2.5].forEach((t) => addSnare(buf, t));                        // beats 1,5
  [0.25, 0.75, 1.25, 1.75, 2.25, 2.75].forEach((t) => addHat(buf, t)); // offbeat 8ths
  const r = a2m.beatboxToDrums(buf, SR, { bpm: BPM, grid: 4 });
  const kicks = r.notes.filter((n) => n.pitch === 36);
  const snares = r.notes.filter((n) => n.pitch === 38);
  const hats = r.notes.filter((n) => n.pitch === 42);
  ok("beatbox: 4 kicks detected", kicks.length === 4);
  ok("beatbox: kicks land on beats 0,2,4,6", JSON.stringify(kicks.map((n) => n.start)) === JSON.stringify([0, 2, 4, 6]));
  ok("beatbox: >= 1 snare classified", snares.length >= 1);
  ok("beatbox: snares on the backbeat grid", snares.every((n) => Math.abs(n.start % 1) < 1e-9));
  ok("beatbox: >= 4 hats classified", hats.length >= 4);
  ok("beatbox: hats sit on half-beat offsets", hats.every((n) => Math.abs((n.start % 1) - 0.5) < 1e-9));
  ok("beatbox: bars cover the pattern", r.bars >= 2);
  ok("beatbox: velocities in MIDI range", r.notes.every((n) => n.velocity >= 40 && n.velocity <= 127));
  ok("beatbox: low voicedRatio (auto would pick drums)", a2m.voicedRatio(buf, SR) < 0.45);
}

// ---- humming → melody ------------------------------------------------------
{
  const buf = silence(2.4);
  addTone(buf, 0.0, 220.0, 0.45);   // A3 = 57
  addTone(buf, 0.55, 329.63, 0.45); // E4 = 64
  addTone(buf, 1.1, 261.63, 0.45);  // C4 = 60
  const r = a2m.melodyFromVoice(buf, SR, { bpm: BPM, grid: 4 });
  const pitches = r.notes.map((n) => n.pitch);
  ok("melody: 3 notes segmented", r.notes.length === 3);
  ok("melody: pitches A3 E4 C4", JSON.stringify(pitches) === JSON.stringify([57, 64, 60]));
  ok("melody: starts quantized to 16ths", r.notes.every((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 1e-9));
  ok("melody: durations near a beat", r.notes.every((n) => n.duration >= 0.5 && n.duration <= 1.5));
  ok("melody: no overlaps", r.notes.every((n, i) => i === 0 || r.notes[i - 1].start + r.notes[i - 1].duration <= n.start + 1e-9));
  ok("melody: high voicedRatio (auto would pick melody)", a2m.voicedRatio(buf, SR) > 0.45);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
