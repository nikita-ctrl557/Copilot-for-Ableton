// audioToMidi.js — turn a VOICE recording into MIDI. Two modes, pure Node DSP:
//   beatbox → drum hits: onset detection (energy flux) + per-hit spectral
//     classification (kick / snare / hat by band balance + centroid) → MIDI 36/38/42
//     quantized to the grid at the session tempo.
//   humming/singing → melody: autocorrelation pitch tracking (80–1000Hz, human
//     voice), median smoothing, stable-pitch segmentation → in-grid notes.
// Used by the audio_to_midi tool ("make this into a beat", then the user beatboxes).

// ---- shared frame helpers -------------------------------------------------

function frames(samples, win, hop) {
  const out = [];
  for (let s = 0; s + win <= samples.length; s += hop) out.push(s);
  return out;
}
function rmsAt(samples, start, win) {
  let e = 0;
  for (let i = start; i < start + win; i++) e += samples[i] * samples[i];
  return Math.sqrt(e / win);
}

// band energies via simple one-pole filters run over a window — cheap and stable
function bandFeatures(samples, start, win, sr) {
  let low = 0, mid = 0, high = 0, zc = 0;
  let lp = 0, prev = 0;
  const aLow = Math.exp(-2 * Math.PI * 200 / sr);   // <200 Hz
  const aHigh = Math.exp(-2 * Math.PI * 3500 / sr); // >3.5 kHz
  let hpState = 0;
  for (let i = start; i < Math.min(start + win, samples.length); i++) {
    const x = samples[i];
    lp = (1 - aLow) * x + aLow * lp;                 // low-passed
    const hp = x - ((1 - aHigh) * x + aHigh * hpState); hpState = (1 - aHigh) * x + aHigh * hpState; // crude high band
    low += lp * lp;
    high += hp * hp;
    const band = x - lp - hp; mid += band * band;
    if ((x >= 0) !== (prev >= 0)) zc++;
    prev = x;
  }
  const total = low + mid + high || 1e-12;
  return { lowRatio: low / total, midRatio: mid / total, highRatio: high / total, zcr: zc / win };
}

// ---- beatbox → drums ------------------------------------------------------

// returns [{timeSec, type: 'kick'|'snare'|'hat', velocity}]
// Onsets via ENERGY FLUX (positive frame-to-frame jumps), not absolute level —
// a hit right after a loud tail still registers, and decays never double-trigger.
function detectHits(samples, sr) {
  const win = 512, hop = 256;
  const idx = frames(samples, win, hop);
  const env = idx.map((s) => rmsAt(samples, s, win));
  const flux = env.map((e, i) => Math.max(0, e - (i ? env[i - 1] : 0)));
  const fluxWin = Math.max(1, Math.round(1.0 * sr / hop)); // adaptive ref: last ~1s
  const hits = [];
  let lastHit = -1e9;
  for (let i = 0; i < flux.length; i++) {
    // baseline = mean flux over the WHOLE last second (zeros included): spikes stand
    // ~10-40x above it; averaging only the spikes would reject every normal hit
    let m = 0, n = 0;
    for (let j = Math.max(0, i - fluxWin); j < i; j++) { m += flux[j]; n++; }
    m = n ? m / n : 0;
    const isPeak = flux[i] >= (flux[i + 1] || 0) || (env[i + 1] || 0) > env[i]; // attack frame or still rising into the next
    const t = idx[i] / sr;
    if (flux[i] > Math.max(0.012, m * 1.8) && isPeak && t - lastHit > 0.09) {
      lastHit = t;
      const peakEnv = Math.max(env[i], env[i + 1] || 0);
      // classify from 60ms of SIGNAL: skip the leading silence inside the onset frame
      // (the frame grid lands up to 16ms early — silence dilutes zcr and mislabels)
      let s0 = idx[i];
      const sEnd = Math.min(samples.length, idx[i] + win);
      while (s0 < sEnd && Math.abs(samples[s0]) < 0.02) s0++;
      const f = bandFeatures(samples, s0, Math.round(0.06 * sr), sr);
      let type = "snare";
      if (f.lowRatio > 0.6 && f.zcr < 0.06) type = "kick";        // dominant lows, near-pure tone
      else if (f.highRatio > 0.15 || f.zcr > 0.25) type = "hat";  // top-heavy / very noisy
      hits.push({ timeSec: t, type, peakEnv });
    }
  }
  // velocity from level RELATIVE to the loudest hit (absolute mic level means nothing)
  const maxE = hits.reduce((mx, h) => Math.max(mx, h.peakEnv), 1e-9);
  for (const h of hits) { h.velocity = Math.max(40, Math.min(127, Math.round(50 + 77 * Math.pow(h.peakEnv / maxE, 0.7)))); delete h.peakEnv; }
  return hits;
}

const DRUM_NOTE = { kick: 36, snare: 38, hat: 42 }; // GM-ish / Drum Rack bottom row

// → { notes: [{pitch,start,duration,velocity}], bars, hits: {kick,snare,hat} }
function beatboxToDrums(samples, sr, { bpm = 120, grid = 4 } = {}) {
  const hits = detectHits(samples, sr);
  if (!hits.length) return { notes: [], bars: 1, hits: {}, note: "no clear hits detected — beatbox closer to the mic, sharper sounds" };
  const beatSec = 60 / bpm;
  const q = 1 / grid; // grid in fractions of a beat (4 = 16ths)
  const t0 = hits[0].timeSec; // first hit lands on beat 0
  const seen = new Set();
  const notes = [];
  const counts = { kick: 0, snare: 0, hat: 0 };
  for (const h of hits) {
    const beat = Math.round(((h.timeSec - t0) / beatSec) / q) * q;
    if (beat < 0) continue;
    const key = h.type + "@" + beat;
    if (seen.has(key)) continue; // collapse double-triggers on the same grid slot
    seen.add(key);
    counts[h.type]++;
    notes.push({ pitch: DRUM_NOTE[h.type], start: beat, duration: h.type === "hat" ? 0.1 : 0.25, velocity: h.velocity });
  }
  const lastBeat = notes.reduce((m, n) => Math.max(m, n.start), 0);
  const bars = Math.max(1, Math.ceil((lastBeat + 0.26) / 4));
  return { notes: notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch), bars, hits: counts };
}

// ---- humming → melody -----------------------------------------------------

// autocorrelation pitch for one frame; returns {hz, clarity} or null
function pitchAt(samples, start, win, sr) {
  const minHz = 80, maxHz = 1000;
  const minLag = Math.floor(sr / maxHz), maxLag = Math.min(Math.floor(sr / minHz), win - 1);
  let e0 = 0;
  for (let i = start; i < start + win; i++) e0 += samples[i] * samples[i];
  if (e0 / win < 1e-5) return null; // too quiet to be voiced
  let bestLag = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0, e1 = 0;
    for (let i = start; i < start + win - lag; i++) { c += samples[i] * samples[i + lag]; e1 += samples[i + lag] * samples[i + lag]; }
    const norm = Math.sqrt(e0 * e1) || 1e-12;
    const corr = c / norm;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag < 0 || bestCorr < 0.75) return null;
  return { hz: sr / bestLag, clarity: bestCorr };
}

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

// → { notes, bars, voicedRatio }
function melodyFromVoice(samples, sr, { bpm = 120, grid = 4 } = {}) {
  const win = 1024, hop = 256;
  const idx = frames(samples, win, hop);
  const track = idx.map((s) => { const p = pitchAt(samples, s, win, sr); return p ? hzToMidi(p.hz) : null; });
  const voiced = track.filter((x) => x != null).length;
  // median-of-5 smoothing kills octave blips
  const smooth = track.map((v, i) => {
    if (v == null) return null;
    const wnd = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(track.length - 1, i + 2); j++) if (track[j] != null) wnd.push(track[j]);
    wnd.sort((a, b) => a - b);
    return wnd[Math.floor(wnd.length / 2)];
  });
  // segment: runs of the same rounded midi ≥ ~70ms become notes
  const frameSec = hop / sr;
  const minFrames = Math.max(2, Math.round(0.07 / frameSec));
  const segs = [];
  let cur = null;
  for (let i = 0; i < smooth.length; i++) {
    const m = smooth[i] == null ? null : Math.round(smooth[i]);
    if (m != null && cur && cur.midi === m) { cur.end = i + 1; }
    else {
      if (cur && cur.end - cur.startF >= minFrames) segs.push(cur);
      cur = m != null ? { midi: m, startF: i, end: i + 1 } : null;
    }
  }
  if (cur && cur.end - cur.startF >= minFrames) segs.push(cur);
  if (!segs.length) return { notes: [], bars: 1, voicedRatio: voiced / Math.max(1, track.length), note: "no stable pitch found — hum/sing more clearly" };
  const beatSec = 60 / bpm;
  const q = 1 / grid;
  const t0 = segs[0].startF * frameSec;
  const notes = [];
  for (const s of segs) {
    const start = Math.max(0, Math.round((((s.startF * frameSec) - t0) / beatSec) / q) * q);
    const durBeats = Math.max(q, Math.round((((s.end - s.startF) * frameSec) / beatSec) / q) * q);
    const prev = notes[notes.length - 1];
    if (prev && prev.start === start) continue; // keep the first of grid-colliding segments
    if (prev && prev.start + prev.duration > start) prev.duration = Math.max(q, start - prev.start); // no overlaps
    notes.push({ pitch: Math.max(36, Math.min(96, s.midi)), start, duration: durBeats, velocity: 100 });
  }
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  return { notes, bars: Math.max(1, Math.ceil(lastEnd / 4)), voicedRatio: voiced / Math.max(1, track.length) };
}

// how "pitched" the recording is — drives auto mode (hum vs beatbox).
// Counts only SUSTAINED voiced runs (≥ ~220ms of continuous singing-range pitch):
// a beatboxed kick has a tonal 100–200ms tail that would otherwise read as "voiced",
// while humming holds pitch for whole syllables.
function voicedRatio(samples, sr) {
  const win = 1024, hop = 512;
  const idx = frames(samples, win, hop);
  if (!idx.length) return 0;
  const hopSec = hop / sr;
  const minRun = Math.max(2, Math.ceil(0.22 / hopSec));
  const flags = idx.map((s) => {
    if (rmsAt(samples, s, win) < 0.01) return null; // silent
    const p = pitchAt(samples, s, win, sr);
    return !!(p && p.hz >= 90 && p.hz <= 800 && p.clarity >= 0.8); // singing range only
  });
  let active = 0, sustained = 0, run = 0;
  const flush = () => { if (run >= minRun) sustained += run; run = 0; };
  for (const f of flags) {
    if (f === null) { flush(); continue; }
    active++;
    if (f) run++;
    else flush();
  }
  flush();
  return active ? sustained / active : 0;
}

module.exports = { beatboxToDrums, melodyFromVoice, detectHits, voicedRatio, DRUM_NOTE };
