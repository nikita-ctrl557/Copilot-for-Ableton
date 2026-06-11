// test-metering.js — synthetic-signal tests for the pro metering in core/spectral.js:
// true LUFS (ITU-R BS.1770 K-weighting + gating), stereo correlation/width/low-end
// mono safety, transient attack, clipping detection. No Live, no files, no deps.
//   run: node scripts/test-metering.js
//
// LUFS reference cases (BS.1770-4 / EBU Tech 3341): a 0dBFS ~1kHz sine applied to
// ONE channel of a stereo pair reads -3.01 LUFS; applied to BOTH channels the
// per-channel powers SUM, so it reads ~0.0 LUFS (3341 case 1: -23dBFS in both
// channels = -23.0 LUFS). A mono file at 0dBFS likewise reads -3.01. A downmix
// average would under-read the both-channels case by ~3dB — that's what we test against.

const spectral = require("../core/spectral");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));

const SR = 48000;
function sine(hz, secs, amp = 1) {
  const n = Math.round(secs * SR), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return o;
}
// minimal 16-bit PCM interleaved WAV (1 or 2 channels) — exercises parseWav L/R extraction
function wav16(chans, sr) {
  const n = chans[0].length, ch = chans.length;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    data.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
  }
  const buf = Buffer.alloc(44 + data.length);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + data.length, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

// ---- LUFS reference + coherent stereo image ---------------------------------
{
  const s = sine(1000, 3);
  // (a) the BS.1770 reference verbatim: 0dBFS 1kHz in ONE channel → -3.01 LUFS
  const zeros = new Float32Array(s.length);
  const half = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) half[i] = s[i] / 2; // mono downmix of (s, silence)
  const a = spectral.analyze(half, SR, { left: s, right: zeros });
  ok(`lufs: 0dBFS 1kHz in one stereo channel ≈ -3.01 (got ${a.lufs})`, Math.abs(a.lufs - -3.01) <= 0.5);
  // (b) identical full-scale signal in BOTH channels: powers sum → ≈ 0.0 LUFS
  //     (a downmix-averaging implementation would wrongly read ≈ -3 here)
  const b = spectral.analyzeWavBuffer(wav16([s, s], SR));
  ok(`lufs: 0dBFS 1kHz in both channels ≈ 0.0 (got ${b.lufs})`, Math.abs(b.lufs) <= 0.5);
  ok(`stereo: identical channels correlation ≈ 1 (got ${b.stereo && b.stereo.correlation})`, b.stereo && b.stereo.correlation >= 0.99);
  ok(`stereo: identical channels width ≈ 0 (got ${b.stereo && b.stereo.width})`, b.stereo && b.stereo.width <= 0.05);
  ok("stereo: identical channels lowEndMono", b.stereo && b.stereo.lowEndMono === true);
  ok(`stereo: summary 'essentially mono' (got '${b.stereo && b.stereo.summary}')`, b.stereo && b.stereo.summary === "essentially mono");
}

// ---- decorrelated stereo ----------------------------------------------------
{
  const l = sine(1000, 3, 0.5), r = sine(1700, 3, 0.5);
  const m = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2;
  const p = spectral.analyze(m, SR, { left: l, right: r });
  ok(`stereo: decorrelated correlation ≈ 0 (got ${p.stereo.correlation})`, Math.abs(p.stereo.correlation) < 0.1);
  ok(`stereo: decorrelated width > 0.5 (got ${p.stereo.width})`, p.stereo.width > 0.5);
}

// ---- low band phase-inverted (the club-mono killer) -------------------------
{
  const n = Math.round(3 * SR);
  const l = new Float32Array(n), r = new Float32Array(n), m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = 0.4 * Math.sin((2 * Math.PI * 60 * i) / SR);   // 60Hz inverted on R
    const hi = 0.4 * Math.sin((2 * Math.PI * 2000 * i) / SR); // 2kHz common
    l[i] = lo + hi; r[i] = -lo + hi; m[i] = (l[i] + r[i]) / 2;
  }
  const p = spectral.analyze(m, SR, { left: l, right: r });
  ok("stereo: inverted 60Hz → lowEndMono false", p.stereo.lowEndMono === false);
  ok(`stereo: phase risk surfaced (got '${p.stereo.summary}')`, /PHASE RISK: low end not mono/.test(p.stereo.summary));
}

// ---- transient: kick-like vs pad-like ---------------------------------------
{
  const n = Math.round(0.5 * SR), k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < 0.005 ? t / 0.005 : Math.exp(-(t - 0.005) / 0.05); // 5ms attack, ~200ms decay
    k[i] = env * Math.sin(2 * Math.PI * 200 * t);
  }
  const p = spectral.analyze(k, SR);
  ok(`kick: attack < 15ms (got ${p.transient && p.transient.attackMs})`, p.transient && p.transient.attackMs < 15);
  ok(`kick: crest > 10dB (got ${p.transient && p.transient.crestDb})`, p.transient && p.transient.crestDb > 10);
  ok("kick: punchy verdict", p.transient && p.transient.punchy === true);
}
{
  const n = Math.round(1.2 * SR), pd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < 0.2 ? t / 0.2 : t > 1.0 ? Math.max(0, (1.2 - t) / 0.2) : 1; // 200ms swell
    pd[i] = 0.7 * env * Math.sin(2 * Math.PI * 440 * t);
  }
  const p = spectral.analyze(pd, SR);
  ok(`pad: attack > 100ms (got ${p.transient && p.transient.attackMs})`, p.transient && p.transient.attackMs > 100);
  ok("pad: not punchy", p.transient && p.transient.punchy === false);
}

// ---- clipping ----------------------------------------------------------------
{
  const n = Math.round(1 * SR), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.sin((2 * Math.PI * 100 * i) / SR) >= 0 ? 1 : -1; // clipped square
  const p = spectral.analyze(q, SR);
  ok("clip: clipping flag true", p.clipping === true);
  ok(`clip: clippedSamples counted (got ${p.clippedSamples})`, p.clippedSamples > 1000);
  ok("clip: CLIPPING label in character", p.character.some((c) => /CLIPPING/.test(c)));
}

// ---- mono file ---------------------------------------------------------------
{
  const s = sine(1000, 3);
  const w = spectral.parseWav(wav16([s], SR));
  ok("mono wav: left/right null", w.left === null && w.right === null);
  const p = spectral.analyze(w.samples, SR, { left: w.left, right: w.right });
  ok("mono: stereo null", p.stereo === null);
  ok(`mono: lufs finite (got ${p.lufs})`, Number.isFinite(p.lufs));
  ok(`mono: full-scale 1kHz ≈ -3.01 LUFS (got ${p.lufs})`, Math.abs(p.lufs - -3.01) <= 0.5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
