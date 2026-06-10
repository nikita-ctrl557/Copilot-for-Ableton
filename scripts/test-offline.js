// test-offline.js — exercise the tool dispatch layer against a MOCK Ableton.
// Proves tools.js translates each Claude tool into the right live.call(kind, args)
// and that the chord engine feeds add_notes correctly. No API key / no Live needed.
//   run: node scripts/test-offline.js

// Force the remote-script client offline so tests are deterministic and NEVER touch
// a running Live session (otherwise load_instrument would talk to real Ableton).
process.env.CLAUDE_COPILOT_NO_REMOTE = "1";

const { dispatch, TOOLS } = require("../core/tools");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));

// A mock `live` that records calls and returns plausible results.
function mockLive() {
  const calls = [];
  return {
    calls,
    last: () => calls[calls.length - 1],
    async call(kind, args = {}) {
      calls.push({ kind, args });
      switch (kind) {
        case "session_info": return { tempo: 120, timeSignature: [4, 4], isPlaying: false, trackCount: 4, sceneCount: 8, selectedTrack: 1 };
        case "list_tracks": return { tracks: [
          { index: 0, name: "Drums", type: "midi", volume: 0.85, pan: 0, isMuted: false, deviceCount: 2 },
          { index: 1, name: "Bass", type: "midi", volume: 0.8, pan: 0, isMuted: false, deviceCount: 1 },
        ] };
        case "list_params": return { params: [
          { index: 0, name: "Device On", value: 1, min: 0, max: 1 },
          { index: 12, name: "3 Filter On A", value: 1, min: 0, max: 1 },
          { index: 13, name: "3 Frequency A", value: 1000, min: 10, max: 22000 },
          { index: 14, name: "3 Gain A", value: 0, min: -15, max: 15 },
          { index: 15, name: "3 Resonance A", value: 0.7, min: 0.1, max: 9 },
          { index: 30, name: "Threshold", value: -10, min: -60, max: 0 },
          { index: 31, name: "Ratio", value: 2, min: 1, max: 100 },
          { index: 32, name: "Attack", value: 10, min: 0.01, max: 500 },
          { index: 33, name: "Release", value: 100, min: 1, max: 3000 },
          { index: 34, name: "Makeup", value: 0, min: 0, max: 24 },
          { index: 35, name: "Dry/Wet", value: 100, min: 0, max: 100 },
        ] };
        case "add_notes": return { requested: args.notes.length, wrote: args.notes.length, method: "mock", verified: true };
        case "find_and_load": return { loaded: { name: "Grand Piano", browserPath: "Instruments/Grand Piano" }, alternatives: [] };
        default: return { ok: true, echo: args };
      }
    },
  };
}

(async () => {
  // every tool name is unique and dispatch handles it
  ok("all tool names unique", new Set(TOOLS.map((t) => t.name)).size === TOOLS.length);

  // write_chords -> add_notes with the right note count + clip length
  {
    const live = mockLive();
    const r = await dispatch("write_chords", { track: 2, key: "C", mode: "major", chords: ["I", "V", "vi", "IV"], enrich: false }, { live });
    const c = live.last();
    ok("write_chords calls add_notes", c.kind === "add_notes" && c.args.track === 2);
    // the spread-voicing engine may double the root/5th for body (3–5 notes per
    // triad), but every chord onset must carry at least a full triad and the
    // reported count must be the REAL count
    const onsets = {};
    for (const n of c.args.notes) onsets[n.start] = (onsets[n.start] || 0) + 1;
    ok("write_chords voices 4 chord onsets (0/4/8/12)", [0, 4, 8, 12].every((b) => (onsets[b] || 0) >= 3));
    ok("write_chords wrote at least the 4 triads", c.args.notes.length >= 12);
    ok("write_chords clip length = 16 beats", c.args.lengthBeats === 16);
    ok("write_chords overwrite defaults true", c.args.overwrite === true);
    ok("write_chords result reports actual wrote count", r.result.wrote === c.args.notes.length);
  }

  // write_melody -> add_notes
  {
    const live = mockLive();
    await dispatch("write_melody", { track: 1, key: "C", mode: "major", degrees: [1, 2, 3, 4, 5], rhythm: 1 }, { live });
    ok("write_melody calls add_notes with 5 notes", live.last().kind === "add_notes" && live.last().args.notes.length === 5);
  }

  // write_notes raw passthrough
  {
    const live = mockLive();
    await dispatch("write_notes", { track: 0, notes: [{ pitch: 36, start: 0, duration: 1 }, { pitch: 38, start: 1, duration: 1 }] }, { live });
    ok("write_notes defaults velocity to 100", live.last().args.notes[0].velocity === 100);
  }

  // set_mixer
  {
    const live = mockLive();
    await dispatch("set_mixer", { track: 1, volume: 0.7, pan: -0.2 }, { live });
    ok("set_mixer forwards volume+pan", live.last().kind === "set_mixer" && live.last().args.volume === 0.7 && live.last().args.pan === -0.2);
  }

  // set_eq_band -> reads params then sets matched indices
  {
    const live = mockLive();
    await dispatch("set_eq_band", { track: 1, device: 0, band: 3, freq: 200, gain: -3, q: 1.2 }, { live });
    const sets = live.calls.filter((c) => c.kind === "set_param");
    ok("set_eq_band read params first", live.calls[0].kind === "list_params");
    ok("set_eq_band set Frequency (idx 13) to 200", sets.some((s) => s.args.param === 13 && s.args.value === 200));
    ok("set_eq_band set Gain (idx 14) to -3", sets.some((s) => s.args.param === 14 && s.args.value === -3));
    ok("set_eq_band set Resonance (idx 15) to 1.2", sets.some((s) => s.args.param === 15 && s.args.value === 1.2));
  }

  // set_compressor -> matches Threshold/Ratio/etc by name
  {
    const live = mockLive();
    const r = await dispatch("set_compressor", { track: 1, device: 0, threshold: -18, ratio: 4, attack: 5 }, { live });
    const sets = live.calls.filter((c) => c.kind === "set_param");
    ok("set_compressor set Threshold idx 30", sets.some((s) => s.args.param === 30 && s.args.value === -18));
    ok("set_compressor set Ratio idx 31", sets.some((s) => s.args.param === 31 && s.args.value === 4));
    ok("set_compressor reports applied", r.result.applied.threshold === -18 && r.result.applied.ratio === 4);
  }

  // load_instrument -> find_and_load(kind: instrument)
  {
    const live = mockLive();
    const r = await dispatch("load_instrument", { track: 3, description: "warm analog pad" }, { live });
    ok("load_instrument -> find_and_load instrument", live.last().kind === "find_and_load" && live.last().args.kind === "instrument");
    ok("load_instrument returns chosen device", (r.result.loaded && (r.result.loaded.name || r.result.loaded)) === "Grand Piano"); // loaded is now normalized to a string
  }

  // transport mapping
  {
    const live = mockLive();
    await dispatch("transport", { action: "start", bpm: 128 }, { live });
    ok("transport start -> set_transport {play,tempo}", live.last().kind === "set_transport" && live.last().args.play === true && live.last().args.tempo === 128);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
