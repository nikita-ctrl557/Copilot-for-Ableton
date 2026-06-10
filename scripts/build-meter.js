#!/usr/bin/env node
// build-meter.js — bake ClaudeMeter.amxd: a per-track audio analyzer that reports
// loudness AND a 4-band spectral split (low / low-mid / mid / high) PLUS transport
// state + song position, so the agent can DISSECT the sound (thick? bright? muddy?)
// and know WHERE in the song it is. Audio passes straight through (plugin~ ->
// plugout~); analysis is a parallel side-branch (band filters -> rms -> snapshot),
// so it can never alter/silence audio. A parallel [sfrecord~ 2] side-branch lets the
// main panel capture this track to wav via "rec ..." commands from the node sender.
// Throttled to ~12 Hz via ONE qlim; its own node.script POSTs to 127.0.0.1:8723/meter.
//
// metrics message (must match metersend.js):
//   "metrics <peak> <rms> <low> <lowmid> <mid> <high> <playing> <beats>"
// playing/beats come from [plugsync~] — per the Max 8 reference ALL plugsync~ outlets
// are EVENT outlets (no snapshot~ needed): outlet 0 = transport running (int 0/1),
// outlet 6 = beat position in 1 PPQ, i.e. song position in quarter notes (float).
//
// usage: node build-meter.js [deviceDir]
const fs = require("fs");
const path = require("path");
const { buildAmxd, parseAmxd } = require("../tools/amxd.js");

const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "device"));
const meterDir = path.join(dir, "meter");
const trackJs = path.join(meterDir, "metertrack.js");
const sendJs = path.join(meterDir, "metersend.js");
const outPath = path.join(dir, "ClaudeMeter.amxd");
for (const f of [trackJs, sendJs]) if (!fs.existsSync(f)) { console.error("! missing " + f); process.exit(1); }

const box = (b) => ({ box: b });
const sig = (id, text, x, y) => box({ id, maxclass: "newobj", numinlets: 2, numoutlets: 1, outlettype: ["signal"], patching_rect: [x, y, 90, 22], text });
const snap = (id, x, y) => box({ id, maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: ["float"], patching_rect: [x, y, 70, 22], text: "snapshot~ 80" });
// presentation comment label (pr = presentation_rect)
const cmt = (id, text, x, y, pr, fontsize) => box({ id, maxclass: "comment", numinlets: 1, numoutlets: 0, patching_rect: [x, y, 130, 18], presentation: 1, presentation_rect: pr, fontsize: fontsize || 9, text });
// per-band live.meter~ (signal tap only — never in the audio path)
const met = (id, x, y, pr) => box({ id, maxclass: "live.meter~", numinlets: 1, numoutlets: 1, outlettype: ["float"], patching_rect: [x, y, 22, 60], presentation: 1, presentation_rect: pr });
// numeric readout
const num = (id, x, y, pr) => box({ id, maxclass: "flonum", numinlets: 1, numoutlets: 2, outlettype: ["", "bang"], patching_rect: [x, y, 70, 22], presentation: 1, presentation_rect: pr });
const line = (s, so, d, di) => ({ patchline: { source: [s, so], destination: [d, di] } });
// linear amp -> dB. Max saves commas in object text escaped: \, (=> \\, in JSON bytes)
const DB_EXPR = "expr 20*log10(max($f1\\,0.000001))";

const PW = 380, PH = 250; // presentation size

const patch = {
  patcher: {
    fileversion: 1,
    appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect: [80, 80, 960, 780],
    presentation_rect: [0, 0, PW, PH],
    openinpresentation: 1,
    default_fontsize: 12.0, default_fontname: "Ableton Sans Medium",
    boxes: [
      // ---- presentation: title / scope / main meter ----
      box({ id: "lbl", maxclass: "comment", numinlets: 1, numoutlets: 0, patching_rect: [12, 12, 420, 18],
        presentation: 1, presentation_rect: [6, 2, 368, 16], fontsize: 11, text: "🎧 Claude Meter — loudness + 4-band spectrum + recorder" }),
      box({ id: "scope", maxclass: "spectroscope~", numinlets: 1, numoutlets: 0,
        patching_rect: [12, 580, 300, 130], presentation: 1, presentation_rect: [6, 24, 230, 120] }),
      box({ id: "lmeter", maxclass: "live.meter~", numinlets: 1, numoutlets: 1, outlettype: ["float"],
        patching_rect: [330, 580, 26, 130], presentation: 1, presentation_rect: [240, 24, 24, 120] }),
      // ---- core: track id + audio passthrough ----
      box({ id: "tdev", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["bang", "bang", ""], patching_rect: [12, 40, 110, 22], text: "live.thisdevice" }),
      box({ id: "mtrack", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [12, 70, 320, 22], text: "v8 " + trackJs }),
      box({ id: "plugin", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["signal", "signal", ""], patching_rect: [12, 100, 60, 22], text: "plugin~" }),
      box({ id: "plugout", maxclass: "newobj", numinlets: 2, numoutlets: 0, patching_rect: [12, 450, 60, 22], text: "plugout~" }),
      // ---- transport (plugsync~: all EVENT outlets — 0=running int, 6=beats PPQ float) ----
      box({ id: "psync", maxclass: "newobj", numinlets: 1, numoutlets: 9,
        outlettype: ["int", "int", "int", "float", "", "float", "float", "int", "int"],
        patching_rect: [480, 40, 150, 22], text: "plugsync~" }),
      box({ id: "ps_chg", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["", "bang", "bang"], patching_rect: [480, 70, 60, 22], text: "change" }),
      box({ id: "ps_qlim", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [560, 70, 60, 22], text: "qlim 80" }),
      num("fl_beat", 640, 70, [272, 124, 66, 20]),
      // ---- overall loudness ----
      box({ id: "peak", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [110, 130, 90, 22], text: "peakamp~ 80" }),
      sig("avg", "average~ 4410 rms", 210, 100), snap("snap", 210, 130),
      // dB readouts
      box({ id: "db_pk", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [480, 130, 200, 22], text: DB_EXPR }),
      box({ id: "db_rms", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [700, 130, 200, 22], text: DB_EXPR }),
      num("fl_pk", 480, 160, [272, 40, 66, 20]),
      num("fl_rms", 700, 160, [272, 82, 66, 20]),
      // ---- 4-band split (1-pole lop~/hip~). low <200, lowmid 200–800, mid 800–3k, high >3k ----
      sig("lo_lop", "lop~ 200", 110, 190), sig("lo_avg", "average~ 2048 rms", 110, 220), snap("lo_snap", 110, 250),
      sig("lm_hip", "hip~ 200", 210, 190), sig("lm_lop", "lop~ 800", 210, 220), sig("lm_avg", "average~ 2048 rms", 210, 250), snap("lm_snap", 210, 280),
      sig("md_hip", "hip~ 800", 310, 190), sig("md_lop", "lop~ 3000", 310, 220), sig("md_avg", "average~ 2048 rms", 310, 250), snap("md_snap", 310, 280),
      sig("hi_hip", "hip~ 3000", 410, 190), sig("hi_avg", "average~ 2048 rms", 410, 220), snap("hi_snap", 410, 250),
      // per-band meters (taps on the band average~ SIGNALS — parallel, no audio-path change)
      met("bm_lo", 510, 220, [100, 152, 160, 14]),
      met("bm_lm", 540, 220, [100, 172, 160, 14]),
      met("bm_md", 570, 220, [100, 192, 160, 14]),
      met("bm_hi", 600, 220, [100, 212, 160, 14]),
      // ---- pack: peak rms low lowmid mid high playing beats ----
      box({ id: "pak", maxclass: "newobj", numinlets: 8, numoutlets: 1, outlettype: [""], patching_rect: [110, 320, 300, 22], text: "pak 0. 0. 0. 0. 0. 0. 0. 0." }),
      box({ id: "pre", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [110, 350, 120, 22], text: "prepend metrics" }),
      box({ id: "qlim", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [110, 380, 70, 22], text: "qlim 80" }),
      box({ id: "node", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["", ""], patching_rect: [110, 410, 360, 22], text: "node.script " + sendJs + " @autostart 1 @watch 0" }),
      // ---- recorder: node "rec ..." -> route -> sfrecord~ (fed in parallel from plugin~) ----
      box({ id: "rrec", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["", ""], patching_rect: [110, 450, 70, 22], text: "route rec" }),
      box({ id: "sfrec", maxclass: "newobj", numinlets: 2, numoutlets: 1, outlettype: ["float"], patching_rect: [110, 480, 80, 22], text: "sfrecord~ 2" }),
      box({ id: "r10", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["", "", ""], patching_rect: [220, 480, 70, 22], text: "route 1 0" }),
      box({ id: "msg1", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [220, 510, 30, 22], text: "1" }),
      box({ id: "msg0", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [260, 510, 30, 22], text: "0" }),
      box({ id: "led", maxclass: "led", numinlets: 1, numoutlets: 1, outlettype: ["int"], parameter_enable: 0,
        oncolor: [0.9, 0.1, 0.1, 1.0], patching_rect: [220, 540, 24, 24], presentation: 1, presentation_rect: [272, 150, 20, 20] }),
      // ---- presentation labels ----
      cmt("c_lo", "LOW <200", 700, 200, [6, 152, 92, 14]),
      cmt("c_lm", "LO-MID 200-800", 700, 225, [6, 172, 92, 14]),
      cmt("c_md", "MID 800-3k", 700, 250, [6, 192, 92, 14]),
      cmt("c_hi", "HIGH >3k", 700, 275, [6, 212, 92, 14]),
      cmt("c_pk", "PEAK dB", 700, 300, [272, 24, 60, 14]),
      cmt("c_rms", "RMS dB", 700, 325, [272, 66, 60, 14]),
      cmt("c_beat", "beat", 700, 350, [272, 108, 60, 14]),
      cmt("c_rec", "REC", 700, 375, [296, 153, 40, 14]),
    ],
    lines: [
      // audio passthrough (untouched) + displays
      line("plugin", 0, "plugout", 0),
      line("plugin", 1, "plugout", 1),
      line("plugin", 0, "scope", 0),
      line("plugin", 0, "lmeter", 0),
      // overall
      line("plugin", 0, "peak", 0),
      line("plugin", 0, "avg", 0),
      line("avg", 0, "snap", 0),
      // dB readouts
      line("peak", 0, "db_pk", 0), line("db_pk", 0, "fl_pk", 0),
      line("snap", 0, "db_rms", 0), line("db_rms", 0, "fl_rms", 0),
      // low band
      line("plugin", 0, "lo_lop", 0),
      line("lo_lop", 0, "lo_avg", 0),
      line("lo_avg", 0, "lo_snap", 0),
      // low-mid band
      line("plugin", 0, "lm_hip", 0),
      line("lm_hip", 0, "lm_lop", 0),
      line("lm_lop", 0, "lm_avg", 0),
      line("lm_avg", 0, "lm_snap", 0),
      // mid band
      line("plugin", 0, "md_hip", 0),
      line("md_hip", 0, "md_lop", 0),
      line("md_lop", 0, "md_avg", 0),
      line("md_avg", 0, "md_snap", 0),
      // high band
      line("plugin", 0, "hi_hip", 0),
      line("hi_hip", 0, "hi_avg", 0),
      line("hi_avg", 0, "hi_snap", 0),
      // per-band meter taps
      line("lo_avg", 0, "bm_lo", 0),
      line("lm_avg", 0, "bm_lm", 0),
      line("md_avg", 0, "bm_md", 0),
      line("hi_avg", 0, "bm_hi", 0),
      // transport: running (de-duped) + beats (throttled) -> pak 6/7 + readout
      line("psync", 0, "ps_chg", 0), line("ps_chg", 0, "pak", 6),
      line("psync", 6, "ps_qlim", 0), line("ps_qlim", 0, "pak", 7), line("ps_qlim", 0, "fl_beat", 0),
      // pack -> prepend -> throttle -> node
      line("peak", 0, "pak", 0),
      line("snap", 0, "pak", 1),
      line("lo_snap", 0, "pak", 2),
      line("lm_snap", 0, "pak", 3),
      line("md_snap", 0, "pak", 4),
      line("hi_snap", 0, "pak", 5),
      line("pak", 0, "pre", 0),
      line("pre", 0, "qlim", 0),
      line("qlim", 0, "node", 0),
      line("tdev", 0, "mtrack", 0),
      line("mtrack", 0, "node", 0),
      // recorder: commands ("open <path>" / 1 / 0) + audio side-feed + REC led
      line("node", 0, "rrec", 0),
      line("rrec", 0, "sfrec", 0),
      line("plugin", 0, "sfrec", 0),
      line("plugin", 1, "sfrec", 1),
      line("rrec", 0, "r10", 0),
      line("r10", 0, "msg1", 0), line("r10", 1, "msg0", 0),
      line("msg1", 0, "led", 0), line("msg0", 0, "led", 0),
    ],
  },
};

const amxd = buildAmxd(patch, "audio-effect", "ClaudeMeter.amxd");
fs.writeFileSync(outPath, amxd);
const p = parseAmxd(fs.readFileSync(outPath));
console.log("baked " + outPath + " (" + amxd.length + " bytes) boxes=" + p.patch.patcher.boxes.length + " lines=" + p.patch.patcher.lines.length);
