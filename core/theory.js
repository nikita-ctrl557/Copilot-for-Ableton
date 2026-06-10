// theory.js — note/scale/chord primitives. Pure functions, no Live dependency.
// MIDI convention: C3 = 60 (Ableton Live default display). All pitches are MIDI ints 0..127.

const NOTE_TO_PC = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3,
  E: 4, Fb: 4, "E#": 5, F: 5, "F#": 6, Gb: 6, G: 7,
  "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11,
};
const PC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Parse "C", "F#3", "Bb2" -> MIDI int. Octave optional (defaults to 3 -> around middle).
function noteToMidi(name, defaultOctave = 3) {
  if (typeof name === "number") return name;
  const m = String(name).trim().match(/^([A-Ga-g])([#b]{0,2})(-?\d+)?$/);
  if (!m) throw new Error(`bad note name: ${name}`);
  const letter = m[1].toUpperCase();
  const acc = m[2] || "";
  const oct = m[3] !== undefined ? parseInt(m[3], 10) : defaultOctave;
  const pc = NOTE_TO_PC[letter + acc] ?? NOTE_TO_PC[letter];
  if (pc === undefined) throw new Error(`bad note name: ${name}`);
  return (oct + 2) * 12 + pc; // C3=60 -> (3+2)*12 + 0 = 60
}

function midiToNote(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 2;
  return `${PC_SHARP[pc]}${oct}`;
}

// Scale formulas as semitone offsets from the tonic.
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

// Chord quality -> semitone intervals from the chord root.
const CHORDS = {
  maj: [0, 4, 7], major: [0, 4, 7], M: [0, 4, 7],
  min: [0, 3, 7], minor: [0, 3, 7], m: [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
  "6": [0, 4, 7, 9], m6: [0, 3, 7, 9],
  maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10], m7: [0, 3, 7, 10],
  "7": [0, 4, 7, 10], dom7: [0, 4, 7, 10],
  m7b5: [0, 3, 6, 10], halfdim7: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9], minMaj7: [0, 3, 7, 11], mMaj7: [0, 3, 7, 11],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  "9": [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14],
  "11": [0, 4, 7, 10, 14, 17], "13": [0, 4, 7, 10, 14, 17, 21],
};

// Diatonic triad qualities per scale degree (for roman-numeral progressions).
const DIATONIC_TRIADS = {
  major: ["maj", "min", "min", "maj", "maj", "min", "dim"],
  minor: ["min", "dim", "maj", "min", "min", "maj", "maj"],
  dorian: ["min", "min", "maj", "maj", "min", "dim", "maj"],
  phrygian: ["min", "maj", "maj", "min", "dim", "maj", "min"],
  lydian: ["maj", "maj", "min", "dim", "maj", "min", "min"],
  mixolydian: ["maj", "min", "dim", "maj", "min", "min", "maj"],
};
const DIATONIC_SEVENTHS = {
  major: ["maj7", "min7", "min7", "maj7", "7", "min7", "m7b5"],
  minor: ["min7", "m7b5", "maj7", "min7", "min7", "maj7", "7"],
};

const ROMAN = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

// Build a chord as MIDI pitches from a root (name or midi) + quality.
function buildChord(root, quality = "maj", { octave = 3 } = {}) {
  const r = typeof root === "number" ? root : noteToMidi(root, octave);
  const ivals = CHORDS[quality];
  if (!ivals) throw new Error(`unknown chord quality: ${quality}`);
  return ivals.map((i) => r + i);
}

module.exports = {
  NOTE_TO_PC, PC_SHARP, SCALES, CHORDS, DIATONIC_TRIADS, DIATONIC_SEVENTHS, ROMAN,
  noteToMidi, midiToNote, buildChord,
};
