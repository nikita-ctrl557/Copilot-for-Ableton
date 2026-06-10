// spectral.js — turn a recorded WAV of a sound into a SPECTRAL PROFILE the agent can
// "see": the full frequency balance (is it thick? bright? muddy?) AND the temporal
// behaviour (attack transient vs sustain vs decay) — short-term and long-term.
// Pure Node, no deps: a WAV parser + an iterative radix-2 FFT + band/descriptor analysis.
// The in-Live capture writes a WAV; this module is what reads it and reports the sound.

// ---------- WAV parsing (PCM 16/24/32-bit + 32-bit float) -> mono Float32 ----------
function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let fmt = null, dataOff = -1, dataLen = 0, p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(p + 8),
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        bits: buf.readUInt16LE(p + 22),
      };
    } else if (id === "data") {
      dataOff = p + 8; dataLen = sz; break;
    }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error("WAV missing fmt/data");
  const { channels, bits, audioFormat, sampleRate } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(Math.min(dataLen, buf.length - dataOff) / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bytes;
      let s;
      if (audioFormat === 3 && bits === 32) s = buf.readFloatLE(o);
      else if (bits === 16) s = buf.readInt16LE(o) / 32768;
      else if (bits === 24) { let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16); if (v & 0x800000) v |= ~0xffffff; s = v / 8388608; }
      else if (bits === 32) s = buf.readInt32LE(o) / 2147483648;
      else if (bits === 8) s = (buf[o] - 128) / 128;
      else s = 0;
      acc += s;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate };
}

// ---------- iterative radix-2 FFT (in-place) ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cwr - im[b] * cwi, vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

// magnitude spectrum of one Hann-windowed frame (length must be power of 2)
function frameMag(samples, start, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = (start + i < samples.length) ? samples[start + i] : 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann
    re[i] = s * w;
  }
  fft(re, im);
  const half = N / 2, mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]) / half;
  return mag;
}

// log-spaced perceptual bands (Hz edges)
const BAND_EDGES = [20, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000, 22050];
const BAND_NAMES = ["sub", "lowbass", "lowmid", "mid", "uppermid", "presence", "brilliance", "high", "air", "ultra"];

function bandsFromMag(mag, sampleRate, N) {
  const binHz = sampleRate / N;
  const e = new Float64Array(BAND_NAMES.length);
  for (let i = 1; i < mag.length; i++) {
    const f = i * binHz, p = mag[i] * mag[i];
    for (let b = 0; b < BAND_NAMES.length; b++) if (f >= BAND_EDGES[b] && f < BAND_EDGES[b + 1]) { e[b] += p; break; }
  }
  return e;
}

function db(x) { return x <= 1e-12 ? -120 : Math.round(100 * (10 * Math.log10(x))) / 100; }

// dominant frequency (rough fundamental) from a magnitude spectrum
function dominantHz(mag, sampleRate, N) {
  let bi = 1, bv = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > bv) { bv = mag[i]; bi = i; }
  return Math.round(bi * (sampleRate / N));
}

// ---------- the analysis: short-term (over time) + long-term (overall) ----------
function analyze(samples, sampleRate, opts = {}) {
  const N = opts.fftSize || 2048;
  const total = samples.length;
  if (total < N) throw new Error("recording too short to analyse");

  // overall RMS + peak
  let sumSq = 0, peak = 0;
  for (let i = 0; i < total; i++) { const a = Math.abs(samples[i]); sumSq += samples[i] * samples[i]; if (a > peak) peak = a; }
  const rms = Math.sqrt(sumSq / total);

  // short-term: hop through the file, one band-vector + RMS per frame (the spectrogram/envelope)
  const hop = N; // non-overlapping is fine for character
  const frames = [];
  const longBands = new Float64Array(BAND_NAMES.length);
  let domAccum = {};
  for (let start = 0; start + N <= total; start += hop) {
    const mag = frameMag(samples, start, N);
    const bands = bandsFromMag(mag, sampleRate, N);
    let fSq = 0; for (let i = start; i < start + N; i++) fSq += samples[i] * samples[i];
    const frms = Math.sqrt(fSq / N);
    const d = dominantHz(mag, sampleRate, N);
    domAccum[d] = (domAccum[d] || 0) + frms;
    frames.push({ tSec: Math.round((start / sampleRate) * 1000) / 1000, rmsDb: db(frms * frms), bands: Array.from(bands) });
    for (let b = 0; b < longBands.length; b++) longBands[b] += bands[b];
  }
  if (!frames.length) throw new Error("no analysable frames");

  // long-term spectral balance (normalised band energy)
  const totalE = longBands.reduce((a, b) => a + b, 0) || 1e-12;
  const balance = {}; BAND_NAMES.forEach((n, i) => (balance[n] = Math.round(1000 * (longBands[i] / totalE)) / 1000));
  const lowRatio = balance.sub + balance.lowbass + balance.lowmid;       // weight / "thickness"
  const highRatio = balance.brilliance + balance.high + balance.air + balance.ultra;

  // spectral centroid (brightness), Hz
  let csum = 0, cden = 0;
  for (let b = 0; b < BAND_NAMES.length; b++) { const fc = (BAND_EDGES[b] + BAND_EDGES[b + 1]) / 2; csum += fc * longBands[b]; cden += longBands[b]; }
  const centroid = Math.round(csum / (cden || 1));

  // ACTIVE SECTIONS: where in the file the signal is actually audible (> -48 dB),
  // merged into ranges — with the song tempo this becomes "plays bars 9–16, 33–48"
  const frameSec = N / sampleRate;
  const activeRanges = [];
  let curR = null;
  for (const f of frames) {
    if (f.rmsDb > -48) {
      if (curR && f.tSec - curR.toSec <= frameSec * 2 + 0.01) curR.toSec = f.tSec + frameSec;
      else { curR = { fromSec: f.tSec, toSec: f.tSec + frameSec }; activeRanges.push(curR); }
    }
  }

  // temporal behaviour: attack (first frames) vs sustain (middle) vs tail (last)
  const env = frames.map((f) => f.rmsDb);
  const attackDb = env[0];
  const sustainDb = env[Math.floor(env.length / 2)];
  const tailDb = env[env.length - 1];
  const sustained = sustainDb > attackDb - 6 && sustainDb > -48;   // still ringing in the middle
  const plucky = attackDb - sustainDb > 8;                          // big drop after the hit
  const fundamental = +Object.entries(domAccum).sort((a, b) => b[1] - a[1])[0][0];

  // human-readable character labels
  const labels = [];
  if (peak <= 0.0005) labels.push("silent (no signal captured)");
  else {
    if (lowRatio > 0.55) labels.push("thick / weighty (strong low end)");
    else if (lowRatio < 0.25) labels.push("thin (weak low end)");
    if (centroid > 3000 || highRatio > 0.35) labels.push("bright");
    else if (centroid < 600) labels.push("dark / sub-heavy");
    if (balance.lowmid + balance.mid > 0.55 && highRatio < 0.12) labels.push("muddy / boxy (mid build-up, no air)");
    if (plucky) labels.push("plucky (sharp attack, fast decay)");
    else if (sustained) labels.push("sustained");
    if (highRatio > 0.45) labels.push("harsh / fizzy (lots of top)");
  }

  return {
    ok: true,
    durationSec: Math.round((total / sampleRate) * 100) / 100,
    sampleRate,
    loudness: { rmsDb: db(rms * rms), peakDb: db(peak * peak) },
    fundamentalHz: fundamental,
    centroidHz: centroid,
    balance,                         // long-term: fraction of energy per band
    lowRatio: Math.round(lowRatio * 100) / 100,
    highRatio: Math.round(highRatio * 100) / 100,
    temporal: { attackDb, sustainDb, tailDb, plucky, sustained, frames: env.length },
    activeRanges: activeRanges.map((r) => ({ fromSec: Math.round(r.fromSec * 100) / 100, toSec: Math.round(r.toSec * 100) / 100 })),
    spectrogram: frames.slice(0, 24),   // short-term: per-frame bands + envelope (capped)
    character: labels,
    summary: labels.length ? labels.join(", ") : "neutral",
  };
}

function analyzeWavBuffer(buf, opts) { const { samples, sampleRate } = parseWav(buf); return analyze(samples, sampleRate, opts); }

module.exports = { parseWav, analyze, analyzeWavBuffer, BAND_NAMES, BAND_EDGES };
