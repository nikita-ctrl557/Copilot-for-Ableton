// spectral.js — turn a recorded WAV of a sound into a SPECTRAL PROFILE the agent can
// "see": the full frequency balance (is it thick? bright? muddy?) AND the temporal
// behaviour (attack transient vs sustain vs decay) — short-term and long-term.
// Pure Node, no deps: a WAV parser + an iterative radix-2 FFT + band/descriptor analysis.
// The in-Live capture writes a WAV; this module is what reads it and reports the sound.

// ---------- WAV parsing (PCM 16/24/32-bit + 32-bit float) -> mono Float32 ----------
// For stereo (channels >= 2) ALSO returns left/right Float32Arrays — the stereo
// metering (correlation/width/low-end mono) needs the real channels; the mono
// downmix in `samples` stays the input for everything spectral. Mono → left/right null.
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
  const left = channels >= 2 ? new Float32Array(frames) : null;
  const right = channels >= 2 ? new Float32Array(frames) : null;
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
      if (c === 0 && left) left[i] = s;
      else if (c === 1 && right) right[i] = s;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate, left, right };
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

// time-domain autocorrelation pitch for LOW fundamentals — below ~150Hz the FFT
// grid is semitones wide (10.8Hz bins at 4096/44.1k), but ACF lags are sample-
// accurate. Picks the SHORTEST strong lag (not the global max) to dodge the
// subharmonic-multiple trap.
function acfHz(s, start, win, sr, minHz, maxHz) {
  const minLag = Math.floor(sr / maxHz), maxLag = Math.min(Math.floor(sr / minHz), win - 2);
  let e0 = 0;
  for (let i = start; i < start + win; i++) e0 += s[i] * s[i];
  if (e0 / win < 1e-6) return null;
  const corr = new Float64Array(maxLag + 2);
  let bc = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0, e1 = 0;
    for (let i = start; i < start + win - lag; i++) { c += s[i] * s[i + lag]; e1 += s[i + lag] * s[i + lag]; }
    corr[lag] = c / (Math.sqrt(e0 * e1) || 1e-12);
    if (corr[lag] > bc) bc = corr[lag];
  }
  if (bc < 0.5) return null;
  let bl = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag] >= 0.9 * bc && corr[lag] >= (corr[lag - 1] || 0) && corr[lag] >= (corr[lag + 1] || 0)) { bl = lag; break; }
  }
  if (bl < 0) return null;
  const a = corr[bl - 1] || 0, b = corr[bl], c2 = corr[bl + 1] || 0, den = a - 2 * b + c2;
  const d = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c2) / den)) : 0;
  return sr / (bl + d);
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

// FUNDAMENTAL from a magnitude spectrum — not the loudest bin (that's often the
// 2nd/3rd HARMONIC: a kick or bass read an octave/fifth wrong, poisoning the
// tuning checks). Harmonic Product Spectrum: the true fundamental is the bin
// whose 1×,2×,3×,4× multiples are ALL strong. Then parabolic interpolation gives
// sub-bin precision — critical below ~100Hz where one bin spans whole semitones.
function dominantHz(mag, sampleRate, N) {
  const minBin = Math.max(1, Math.floor(25 / (sampleRate / N))); // ignore <25Hz rumble
  const hpsLen = Math.floor(mag.length / 4);
  let maxMag = 0;
  for (let i = minBin; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  let bi = minBin, bv = -Infinity;
  for (let i = minBin; i < hpsLen; i++) {
    // the fundamental must itself be PRESENT — without this floor, a noise bin at
    // f/2 or f/3 of a pure tone wins purely because one multiple hits the peak
    if (mag[i] < 0.05 * maxMag) continue;
    const v = Math.log(mag[i] + 1e-12) + Math.log(mag[2 * i] + 1e-12)
            + Math.log(mag[3 * i] + 1e-12) + 0.5 * Math.log(mag[4 * i] + 1e-12);
    if (v > bv) { bv = v; bi = i; }
  }
  if (bv === -Infinity) { // nothing passed the floor below hpsLen (very high tones) — fall back to the peak bin
    for (let i = minBin; i < mag.length - 1; i++) if (mag[i] === maxMag) { bi = i; break; }
  }
  // sub-bin refinement on the raw spectrum around the winner
  const a = Math.log(mag[bi - 1] + 1e-12), b = Math.log(mag[bi] + 1e-12), c = Math.log(mag[bi + 1] + 1e-12);
  const den = a - 2 * b + c;
  const delta = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
  return Math.round((bi + delta) * (sampleRate / N) * 10) / 10;
}

// ---------- TRUE LUFS (ITU-R BS.1770-4 / EBU R128 integrated) ----------
// The spec's K-weighting coefficients are written for 48k only — re-derive both
// biquad stages at the file's ACTUAL sample rate from the de-normalised analog
// parameters: high shelf +3.99984dB @ 1681.97Hz Q 0.70718 (head diffraction),
// then a high-pass @ 38.135Hz Q 0.50033 (rumble out of the loudness reading).
// The shelf uses the spec's exact gain distribution (Vb = Vh^0.4996667741545416,
// the libebur128 de-normalisation) — the RBJ cookbook shelf shape under-weights
// ~0.26dB at 1kHz; this form reproduces the published 48k table to the last digit.
function kShelfCoeffs(sr) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
}
function kHighPassCoeffs(sr) {
  const f0 = 38.13547087602444, Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + K / Q + K * K;
  return [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]; // spec keeps b = [1,-2,1]
}

// K-weight one channel and return its energy per 100ms chunk (Float64Array) —
// 400ms gating blocks at 75% overlap are sums of 4 consecutive chunks, 3s
// short-term windows are 30, so this is the only pass over the samples.
function kWeightChunkEnergies(ch, sr, hop) {
  const shelf = kShelfCoeffs(sr);
  const hp = kHighPassCoeffs(sr);
  const nChunks = Math.max(1, Math.floor(ch.length / hop));
  const e = new Float64Array(nChunks);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
  const end = nChunks * hop;
  for (let i = 0; i < end; i++) {
    const x = ch[i];
    const y = shelf[0] * x + shelf[1] * x1 + shelf[2] * x2 - shelf[3] * y1 - shelf[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const v = hp[0] * y + hp[1] * u1 + hp[2] * u2 - hp[3] * v1 - hp[4] * v2;
    u2 = u1; u1 = y; v2 = v1; v1 = v;
    e[(i / hop) | 0] += v * v;
  }
  return e;
}

// integrated loudness: block loudness = -0.691 + 10log10(Σ-over-channels meanSquare),
// 400ms blocks / 75% overlap, absolute gate -70 LUFS, then relative gate 10 LU below
// the absolutely-gated mean, integrated = mean of what survives. Channels are SUMMED
// (G=1 for L/R per the spec) — averaging a downmix under-reads correlated material ~3dB.
// Also returns loudnessRange (EBU Tech 3342: 3s windows, -20 LU relative gate, p95-p10)
// since the chunk energies make it nearly free.
function integratedLufs(channels, sr) {
  const hop = Math.max(1, Math.round(0.1 * sr));
  const chunks = channels.map((ch) => kWeightChunkEnergies(ch, sr, hop));
  const nChunks = Math.min(...chunks.map((c) => c.length));
  const LK = (p) => -0.691 + 10 * Math.log10(p > 1e-12 ? p : 1e-12);
  // mean square over `len` chunks starting at chunk k, summed across channels
  const power = (k, len) => {
    let p = 0;
    for (const c of chunks) for (let i = k; i < k + len; i++) p += c[i];
    return p / (len * hop);
  };
  const blockLen = Math.min(4, nChunks); // 400ms blocks (a shorter file measures as one block)
  const blocks = [];
  for (let k = 0; k + blockLen <= nChunks; k++) blocks.push(power(k, blockLen));
  const abs = blocks.filter((p) => LK(p) > -70); // absolute gate
  if (!abs.length) return { lufs: null, lra: null };
  const relThresh = LK(abs.reduce((a, b) => a + b, 0) / abs.length) - 10; // relative gate
  const rel = abs.filter((p) => LK(p) > relThresh);
  const used = rel.length ? rel : abs;
  const lufs = Math.round(LK(used.reduce((a, b) => a + b, 0) / used.length) * 10) / 10;
  // loudness range from 3s short-term windows, 1s hop
  let lra = null;
  const stLen = 30, stHop = 10;
  if (nChunks >= stLen + stHop) {
    const st = [];
    for (let k = 0; k + stLen <= nChunks; k += stHop) { const p = power(k, stLen); if (LK(p) > -70) st.push(p); }
    if (st.length >= 3) {
      const th = LK(st.reduce((a, b) => a + b, 0) / st.length) - 20;
      const g = st.map(LK).filter((l) => l > th).sort((a, b) => a - b);
      if (g.length >= 2) {
        const q = (f) => g[Math.min(g.length - 1, Math.round(f * (g.length - 1)))];
        lra = Math.round((q(0.95) - q(0.10)) * 10) / 10;
      }
    }
  }
  return { lufs, lra };
}

// ---------- STEREO: correlation / width / low-end mono safety ----------
function pearson(a, b, n) {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cab = 0, ca = 0, cb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cab += x * y; ca += x * x; cb += y * y; }
  const den = Math.sqrt(ca * cb);
  return den < 1e-12 ? 0 : cab / den;
}

function stereoProfile(left, right, sr) {
  const n = Math.min(left.length, right.length);
  if (!n) return null;
  const correlation = Math.round(pearson(left, right, n) * 100) / 100;
  let midSq = 0, sideSq = 0, fullSqL = 0, fullSqR = 0;
  for (let i = 0; i < n; i++) {
    const m = (left[i] + right[i]) / 2, s = (left[i] - right[i]) / 2;
    midSq += m * m; sideSq += s * s; fullSqL += left[i] * left[i]; fullSqR += right[i] * right[i];
  }
  const midRms = Math.sqrt(midSq / n), sideRms = Math.sqrt(sideSq / n);
  const width = Math.round(Math.min(99, sideRms / (midRms > 1e-9 ? midRms : 1e-9)) * 100) / 100;
  // low end (<120Hz) mono check: one-pole low-pass both channels and correlate —
  // out-of-phase lows CANCEL on club/phone mono systems, the classic invisible killer
  const a = 1 - Math.exp((-2 * Math.PI * 120) / sr);
  const ll = new Float64Array(n), rl = new Float64Array(n);
  let yl = 0, yr = 0, el = 0, er = 0;
  for (let i = 0; i < n; i++) {
    yl += a * (left[i] - yl); yr += a * (right[i] - yr);
    ll[i] = yl; rl[i] = yr; el += yl * yl; er += yr * yr;
  }
  // only judge the low band if it carries real energy (>15% of either channel's
  // amplitude — below that it's just the one-pole's leakage from higher content)
  const hasLow = Math.sqrt(el / n) > 0.15 * Math.sqrt(fullSqL / n) || Math.sqrt(er / n) > 0.15 * Math.sqrt(fullSqR / n);
  const lowEndMono = hasLow ? pearson(ll, rl, n) > 0.9 : true; // no low end → nothing can cancel
  let summary;
  if (!lowEndMono) summary = "PHASE RISK: low end not mono";
  else if (correlation < -0.2) summary = "PHASE RISK: channels out of phase";
  else if (width < 0.1 && correlation > 0.95) summary = "essentially mono";
  else if (width > 0.5) summary = "wide and mono-safe";
  else summary = "moderate stereo, mono-safe";
  return { correlation, width, lowEndMono, summary };
}

// ---------- TRANSIENT: attack speed of the loudest onset ----------
// RMS envelope at ~1ms hops (5ms windows — stable down to bass fundamentals),
// then around the loudest peak: walk back to the last point at <=10% of the peak,
// forward to the first at >=90% — that span is the attack time.
function transientAttackMs(samples, sr) {
  const n = samples.length;
  const hopN = Math.max(1, Math.round(sr / 1000));
  const win = Math.max(2 * hopN, Math.round(sr * 0.005));
  if (n < win) return null;
  const env = [];
  for (let s = 0; s + win <= n; s += hopN) {
    let sq = 0;
    for (let i = s; i < s + win; i++) sq += samples[i] * samples[i];
    env.push(Math.sqrt(sq / win));
  }
  if (!env.length) return null;
  let kPeak = 0;
  for (let k = 1; k < env.length; k++) if (env[k] > env[kPeak]) kPeak = k;
  const ePeak = env[kPeak];
  if (ePeak <= 1e-6) return null;
  let k10 = 0;
  for (let k = kPeak; k >= 0; k--) if (env[k] <= 0.1 * ePeak) { k10 = k; break; }
  let k90 = kPeak;
  for (let k = k10; k <= kPeak; k++) if (env[k] >= 0.9 * ePeak) { k90 = k; break; }
  return Math.round((((k90 - k10) * hopN) / sr) * 1000 * 10) / 10;
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
  let loudStart = 0, loudRms = 0; // loudest frame → where the ACF low-pitch refinement listens
  for (let start = 0; start + N <= total; start += hop) {
    const mag = frameMag(samples, start, N);
    const bands = bandsFromMag(mag, sampleRate, N);
    let fSq = 0; for (let i = start; i < start + N; i++) fSq += samples[i] * samples[i];
    const frms = Math.sqrt(fSq / N);
    if (frms > loudRms) { loudRms = frms; loudStart = start; }
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

  // SECTION EVOLUTION: how the element CHANGES through the song — per time window
  // (opts.sectionSec, default 10s ≈ 5 bars at 124bpm): loudness + low/high balance,
  // so "the bass opens up after the breakdown" is a measured fact, not a feel
  const sectionSec = opts.sectionSec || 10;
  const secAgg = [];
  for (const f of frames) {
    const si = Math.floor(f.tSec / sectionSec);
    if (!secAgg[si]) secAgg[si] = { n: 0, rmsSq: 0, low: 0, high: 0, total: 0 };
    const a = secAgg[si];
    a.n++;
    a.rmsSq += Math.pow(10, f.rmsDb / 10);
    const e = f.bands;
    const tot = e.reduce((x, y) => x + y, 0) || 1e-12;
    a.low += (e[0] + e[1] + e[2]) / tot; a.high += (e[6] + e[7] + e[8] + e[9]) / tot; a.total += tot;
  }
  const sections = secAgg.map((a, i) => a && a.n ? {
    fromSec: Math.round(i * sectionSec), toSec: Math.round((i + 1) * sectionSec),
    rmsDb: db(a.rmsSq / a.n),
    lowRatio: Math.round((a.low / a.n) * 100) / 100,
    highRatio: Math.round((a.high / a.n) * 100) / 100,
  } : null).filter(Boolean);

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
  let fundamental = +Object.entries(domAccum).sort((a, b) => b[1] - a[1])[0][0];
  // LOW fundamentals (kicks, subs): the FFT grid is semitones-wide down there —
  // refine with sample-accurate autocorrelation on the loudest stretch
  if (fundamental < 150) {
    const win = Math.min(8192, total - loudStart);
    const r = win > 2048 ? acfHz(samples, loudStart, win, sampleRate, 25, 250) : null;
    if (r) fundamental = Math.round(r * 10) / 10;
  }

  // ---- pro metering: true LUFS, stereo image, transient attack, clipping ----
  const left = opts.left || null, right = opts.right || null;
  const isStereo = !!(left && right);
  // LUFS from the REAL channels when we have them (summed per the spec); the mono
  // downmix is only the fallback for mono sources
  const loud = integratedLufs(isStereo ? [left, right] : [samples], sampleRate);
  const stereo = isStereo ? stereoProfile(left, right, sampleRate) : null;
  const peakDb = db(peak * peak), rmsDb = db(rms * rms);
  const attackMs = transientAttackMs(samples, sampleRate);
  const crestDb = Math.round((peakDb - rmsDb) * 10) / 10;
  const transient = attackMs != null && peak > 0.0005
    ? { attackMs, crestDb, punchy: attackMs < 15 && crestDb > 10 }
    : null;
  // clipped samples on ANY real channel (the downmix can hide single-channel clips)
  let clippedSamples = 0;
  for (const ch of isStereo ? [left, right] : [samples]) {
    for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) >= 0.999) clippedSamples++;
  }
  const clipping = clippedSamples > 10;

  // human-readable character labels
  const labels = [];
  if (peak <= 0.0005) labels.push("silent (no signal captured)");
  else {
    if (clipping) labels.push(`CLIPPING (${clippedSamples} samples at full scale)`);
    if (lowRatio > 0.55) labels.push("thick / weighty (strong low end)");
    else if (lowRatio < 0.25) labels.push("thin (weak low end)");
    if (centroid > 3000 || highRatio > 0.35) labels.push("bright");
    else if (centroid < 600) labels.push("dark / sub-heavy");
    if (balance.lowmid + balance.mid > 0.55 && highRatio < 0.12) labels.push("muddy / boxy (mid build-up, no air)");
    if (transient && transient.punchy) labels.push("punchy (fast attack, high crest)");
    else if (plucky) labels.push("plucky (sharp attack, fast decay)");
    else if (sustained) labels.push("sustained");
    if (highRatio > 0.45) labels.push("harsh / fizzy (lots of top)");
    // loudness + stereo notes only when they'd change a decision
    if (loud.lufs != null && loud.lufs > -8) labels.push(`very hot (${loud.lufs} LUFS integrated)`);
    else if (loud.lufs != null && loud.lufs < -30) labels.push(`very quiet (${loud.lufs} LUFS integrated)`);
    if (stereo && /PHASE RISK/.test(stereo.summary)) labels.push(stereo.summary);
    else if (stereo && stereo.summary === "wide and mono-safe") labels.push("wide stereo (mono-safe)");
  }

  return {
    ok: true,
    durationSec: Math.round((total / sampleRate) * 100) / 100,
    sampleRate,
    loudness: { rmsDb, peakDb },
    lufs: loud.lufs,                                          // integrated, BS.1770 gated
    loudnessRange: loud.lra != null ? loud.lra : undefined,   // LRA in LU (EBU 3342)
    stereo,                                                   // null for mono sources
    transient,                                                // { attackMs, crestDb, punchy }
    clippedSamples,
    clipping,
    fundamentalHz: fundamental,
    centroidHz: centroid,
    balance,                         // long-term: fraction of energy per band
    lowRatio: Math.round(lowRatio * 100) / 100,
    highRatio: Math.round(highRatio * 100) / 100,
    temporal: { attackDb, sustainDb, tailDb, plucky, sustained, frames: env.length },
    activeRanges: activeRanges.map((r) => ({ fromSec: Math.round(r.fromSec * 100) / 100, toSec: Math.round(r.toSec * 100) / 100 })),
    sections,
    spectrogram: frames.slice(0, 24),   // short-term: per-frame bands + envelope (capped)
    character: labels,
    summary: labels.length ? labels.join(", ") : "neutral",
  };
}

function analyzeWavBuffer(buf, opts) { const { samples, sampleRate, left, right } = parseWav(buf); return analyze(samples, sampleRate, { left, right, ...(opts || {}) }); }

module.exports = { parseWav, analyze, analyzeWavBuffer, BAND_NAMES, BAND_EDGES };
