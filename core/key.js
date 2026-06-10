// key.js — key detection from a 12-bin pitch-class histogram via the
// Krumhansl-Schmuckler algorithm, plus chord suggestions that fit the key.
// Pure + testable. Used for both audio (sigmund~ pitch histogram) and MIDI.

const T = require("./theory");

// Krumhansl-Kessler key profiles (major / minor), tonic at index 0.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const PC = T.PC_SHARP; // ["C","C#",...]

function pearson(a, b) {
  const n = a.length;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den === 0 ? 0 : num / den;
}
// rotate a profile so its tonic sits at pitch-class `t`
function rotate(profile, t) { const r = new Array(12); for (let i = 0; i < 12; i++) r[i] = profile[((i - t) % 12 + 12) % 12]; return r; }

// hist: 12-element array of pitch-class counts. Returns the best key + runner-up.
function detectKey(hist) {
  const total = hist.reduce((a, b) => a + b, 0);
  const ranked = [];
  for (let t = 0; t < 12; t++) {
    ranked.push({ tonicPc: t, mode: "major", corr: pearson(hist, rotate(MAJOR, t)) });
    ranked.push({ tonicPc: t, mode: "minor", corr: pearson(hist, rotate(MINOR, t)) });
  }
  ranked.sort((a, b) => b.corr - a.corr);
  const best = ranked[0], alt = ranked[1];
  return {
    key: `${PC[best.tonicPc]} ${best.mode}`,
    tonic: PC[best.tonicPc], mode: best.mode, tonicPc: best.tonicPc,
    confidence: Math.round(best.corr * 100) / 100,
    alternative: `${PC[alt.tonicPc]} ${alt.mode}`,
    samples: total,
  };
}

// Suggest chords + progressions that work in a detected key.
function suggestChords(tonicPc, mode) {
  const scale = T.SCALES[mode] || T.SCALES.major;
  const quals = T.DIATONIC_TRIADS[mode] || T.DIATONIC_TRIADS.major;
  const sevenths = T.DIATONIC_SEVENTHS[mode] || T.DIATONIC_SEVENTHS.major;
  const roman = mode === "minor" ? ["i", "ii°", "III", "iv", "v", "VI", "VII"] : ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
  const diatonic = scale.map((semi, i) => {
    const rootPc = (tonicPc + semi) % 12;
    return { degree: roman[i], root: PC[rootPc], quality: quals[i], seventh: sevenths ? sevenths[i] : null,
      name: PC[rootPc] + (quals[i] === "maj" ? "" : quals[i] === "min" ? "m" : quals[i]) };
  });
  const progressions = mode === "minor"
    ? [["i", "VI", "III", "VII"], ["i", "iv", "v"], ["i", "VII", "VI", "VII"], ["i", "iv", "VII", "III"]]
    : [["I", "V", "vi", "IV"], ["ii", "V", "I"], ["I", "vi", "IV", "V"], ["vi", "IV", "I", "V"]];
  return { romanNumerals: roman, diatonic, progressions };
}

// Build a pitch-class histogram from MIDI pitches.
function histFromPitches(pitches) {
  const h = new Array(12).fill(0);
  for (const p of pitches) { const pc = ((Math.round(p) % 12) + 12) % 12; h[pc]++; }
  return h;
}

module.exports = { detectKey, suggestChords, histFromPitches, MAJOR, MINOR };
