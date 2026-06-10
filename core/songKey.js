// songKey.js — the ACTUAL key of the song, detected from the MIDI content of the
// set (Krumhansl on a duration-weighted pitch-class histogram from the remote
// script's `pitches` op). Live's scale chooser (song.root_note/scale_name) is just
// a SETTING the user may never have touched — reporting it as "the key" was wrong.
// Cached briefly; falls back to Live's scale setting (clearly labelled) when there
// isn't enough MIDI to detect from.
const remoteClient = require("./remoteClient");
const keymod = require("./key");

const PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let _cache = null, _at = 0;
const TTL = 12000;

// → { key, tonic, tonicPc, mode, confidence, source: 'clips'|'live-setting', liveScale, label } | null
async function detect() {
  if (_cache !== null && Date.now() - _at < TTL) return _cache;
  _at = Date.now();
  _cache = null;
  let liveScale = null;
  try {
    const r = await remoteClient.pitches();
    if (r && r.ok) {
      liveScale = r.liveScale && r.liveScale !== "?" ? r.liveScale : null;
      if (r.total >= 8 && (r.hist || []).some((x) => x > 0)) {
        const det = keymod.detectKey(r.hist);
        if (det && det.confidence >= 0.5) {
          _cache = {
            key: det.key, tonic: det.tonic, tonicPc: det.tonicPc, mode: det.mode,
            confidence: det.confidence, source: "clips", liveScale,
            label: det.key + " (detected from your clips" + (liveScale && liveScale.toLowerCase() !== det.key.toLowerCase() ? "; Live's scale chooser says " + liveScale + " — likely never set" : "") + ")",
          };
          return _cache;
        }
      }
    }
  } catch (e) { /* loader off */ }
  if (liveScale) {
    const pc = PC.indexOf(liveScale.split(" ")[0]);
    _cache = { key: liveScale, tonic: liveScale.split(" ")[0], tonicPc: pc < 0 ? null : pc,
      mode: /minor/i.test(liveScale) ? "minor" : "major", confidence: null,
      source: "live-setting", liveScale, label: liveScale + " (Live's scale setting — no MIDI to detect from yet)" };
  }
  return _cache;
}
function invalidate() { _cache = null; _at = 0; }

// tuning of a measured fundamental against a key: nearest note, cents off, and
// whether it lands on the key's root or fifth (what a kick/bass should sit on)
function tuningInfo(hz, keyObj) {
  if (!hz || hz < 20 || hz > 4000) return null;
  const midiF = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midiF);
  const centsOff = Math.round((midiF - nearest) * 100);
  const pc = ((nearest % 12) + 12) % 12;
  const out = { hz: Math.round(hz * 10) / 10, nearestNote: PC[pc] + (Math.floor(nearest / 12) - 1), centsOff };
  if (keyObj && keyObj.tonicPc != null) {
    const root = keyObj.tonicPc, fifth = (keyObj.tonicPc + 7) % 12;
    out.key = keyObj.key;
    out.onKeyRoot = pc === root && Math.abs(centsOff) <= 30;
    out.onKeyFifth = pc === fifth && Math.abs(centsOff) <= 30;
    out.inTune = out.onKeyRoot || out.onKeyFifth;
    out.semitonesToRoot = ((root - pc + 18) % 12) - 6; // shortest transpose to land on the root
    if (!out.inTune) out.fix = `retune ${out.semitonesToRoot >= 0 ? "+" : ""}${out.semitonesToRoot} st${Math.abs(centsOff) > 10 ? ` ${centsOff > 0 ? "-" : "+"}${Math.abs(centsOff)} cents` : ""} to sit on ${PC[root]} (the root of ${keyObj.key})`;
  }
  return out;
}

module.exports = { detect, invalidate, tuningInfo, PC };
