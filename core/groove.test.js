// run: node core/groove.test.js
const G = require("./groove");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));

const PROG = ["i", "VI", "III", "VII"];
const sig = (ns) => ns.map((n) => n.start + ":" + n.pitch).join(",");
const stddev = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); };
const isOff16 = (start) => Math.abs((start % 0.5) - 0.25) < 1e-9;
// longest silent stretch inside [b0, b1)
const maxGapInBar = (ns, b0, b1) => {
  const iv = ns.filter((n) => n.start < b1 && n.start + n.duration > b0)
    .map((n) => [Math.max(b0, n.start), Math.min(b1, n.start + n.duration)])
    .sort((a, b) => a[0] - b[0]);
  let cur = b0, gap = 0;
  for (const [s, e] of iv) { gap = Math.max(gap, s - cur); cur = Math.max(cur, e); }
  return Math.max(gap, b1 - cur);
};
const firstInWindow = (ns, w, bpc = 4) => ns.filter((n) => n.start >= w * bpc - 1e-9 && n.start < (w + 1) * bpc).sort((a, b) => a.start - b.start)[0];

// --- existing exports unchanged --------------------------------------------
ok("applySwing exported", typeof G.applySwing === "function");
ok("MELODY_RHYTHMS unchanged", JSON.stringify(G.MELODY_RHYTHMS.eighths) === "[0.5,0.5,0.5,0.5]"
  && JSON.stringify(G.MELODY_RHYTHMS.house) === "[0.5,0.5,1,0.5,0.5,1]"
  && Object.keys(G.MELODY_RHYTHMS).length === 7);
ok("swungStart/snapToGrid still exported", typeof G.swungStart === "function" && typeof G.snapToGrid === "function");

// --- determinism ------------------------------------------------------------
const d1 = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: 5, swing: 0 });
const d2 = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: 5, swing: 0 });
ok("same seed → byte-identical output", JSON.stringify(d1) === JSON.stringify(d2));

const sigs = new Set();
for (let s = 0; s < 8; s++) sigs.add(sig(G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: s, swing: 0 })));
ok("seeds 0..7 → at least 6 distinct tech-house patterns (" + sigs.size + "/8)", sigs.size >= 6);

const r1 = sig(G.writeBassline("A", "minor", PROG, { style: "tech-house", swing: 0 }));
const r2 = sig(G.writeBassline("A", "minor", PROG, { style: "tech-house", swing: 0 }));
ok("no seed → rotates to a different pattern per call", r1 !== r2);

// --- tech-house anti-degeneracy (the complaint) ------------------------------
const ROOT_PCS = [9, 5, 0, 7]; // A F C G in A minor i-VI-III-VII
let thPitch = true, thOff = true, thGap = true, thVel = true, thLock = true, thTrap = true;
for (let s = 0; s < 8; s++) {
  const ns = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: s, swing: 0 });
  const pitches = new Set(ns.map((n) => n.pitch));
  if (pitches.size < 3) thPitch = false;
  if (ns.filter((n) => isOff16(n.start)).length < 2) thOff = false;
  for (let b = 0; b < 4; b++) if (maxGapInBar(ns, b * 4, b * 4 + 4) < 0.5 - 1e-9) thGap = false;
  if (stddev(ns.map((n) => n.velocity)) <= 8) thVel = false;
  for (let w = 0; w < 4; w++) {
    const first = firstInWindow(ns, w);
    if (!first || ((first.pitch % 12) + 12) % 12 !== ROOT_PCS[w]) thLock = false;
  }
  if (pitches.size === 1 && ns.every((n) => Math.abs(n.start % 0.5) < 1e-9)) thTrap = false;
}
ok("tech-house: >= 3 distinct pitches per 4-chord progression (seeds 0..7)", thPitch);
ok("tech-house: syncopated — >= 2 notes on .25/.75 offsets per 4 bars", thOff);
ok("tech-house: every bar has a rest gap >= 0.5 beat", thGap);
ok("tech-house: velocity stddev > 8 (groove, not flat)", thVel);
ok("tech-house: first note of each chord window is the chord root", thLock);
ok("tech-house: NEVER all-8ths-one-pitch", thTrap);

// ghosts ~60-75% and accents above base
ok("tech-house: has ghost notes (<= 75% of base velocity)", d1.some((n) => n.velocity <= Math.round(105 * 0.75)));
ok("tech-house: has accents (> base velocity)", d1.some((n) => n.velocity > 105));

// --- chord lock: i-VI-III-VII in A minor → windows start on A/F/C/G ----------
{
  const ns = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: 2, swing: 0 });
  const startPcs = [0, 1, 2, 3].map((w) => firstInWindow(ns, w).pitch % 12);
  ok("chord lock: window starts on A/F/C/G", JSON.stringify(startPcs) === JSON.stringify(ROOT_PCS));
  ok("chord lock: window starts are root or root+12 in range", [0, 1, 2, 3].every((w) => {
    const p = firstInWindow(ns, w).pitch;
    return p >= 28 && p <= 51 && (p % 12 === ROOT_PCS[w]);
  }));
}

// --- all styles: range / durations / overlaps / velocity groove --------------
// precise register bound: [octave*12+16, octave*12+39] (octave 1 → MIDI 28..51)
const STYLES = ["tech-house", "acid", "offbeat", "rolling", "octave", "garage", "reese", "sub", "pluck"];
for (const st of STYLES) {
  let inRange = true, durs = true, overlap = false, velVar = true, locked = true;
  for (let s = 0; s < 4; s++) {
    const ns = G.writeBassline("C", "minor", PROG, { style: st, seed: s, swing: 0 });
    if (!ns.length) durs = false;
    if (!ns.every((n) => n.pitch >= 28 && n.pitch <= 51)) inRange = false;
    if (!ns.every((n) => n.duration > 0)) durs = false;
    if (!ns.every((n) => n.velocity >= 1 && n.velocity <= 127)) velVar = false;
    if (new Set(ns.map((n) => n.velocity)).size < 2) velVar = false;
    const sorted = [...ns].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].start + sorted[i].duration - 1e-9; j++)
        if (sorted[j].pitch === sorted[i].pitch) overlap = true;
    // every chord window anchors on the root (C=0, Ab=8, Eb=3, Bb=10)
    const pcs = [0, 8, 3, 10];
    for (let w = 0; w < 4; w++) {
      const first = firstInWindow(ns, w);
      if (!first || (first.pitch % 12 !== pcs[w] && first.pitch % 12 !== (pcs[w] + 12) % 12)) locked = false;
    }
  }
  ok(`style '${st}': in-range [28..51], durations > 0, no same-pitch overlap, velocity groove, root-locked`,
    inRange && durs && !overlap && velVar && locked);
}

// --- style signatures ---------------------------------------------------------
// offbeat keeps the & of EVERY beat (its signature)
{
  const ns = G.writeBassline("C", "minor", PROG, { style: "offbeat", seed: 2, swing: 0 });
  let ands = true;
  for (let b = 0; b < 16; b++) if (!ns.some((n) => Math.abs(n.start - (b + 0.5)) < 1e-9)) ands = false;
  ok("offbeat: a note on the & of every beat", ands);
}
// octave style bounces root and root+12
{
  const ns = G.writeBassline("C", "minor", ["i"], { style: "octave", seed: 1, swing: 0 });
  ok("octave: bounces between root (36) and octave (48)", ns.some((n) => n.pitch === 36) && ns.some((n) => n.pitch === 48));
}
// sub stays sparse and on chord roots only (single pitch per window allowed)
{
  const ns = G.writeBassline("C", "minor", PROG, { style: "sub", seed: 0, swing: 0 });
  ok("sub: sparse long roots only", ns.length <= 12 && ns.every((n) => [0, 8, 3, 10].includes(n.pitch % 12)) && ns.some((n) => n.duration >= 2));
}
// acid produces slide-style overlaps (different pitch) across seeds
{
  let slides = 0;
  for (let s = 0; s < 8; s++) {
    const ns = G.writeBassline("C", "minor", PROG, { style: "acid", seed: s, swing: 0 }).sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < ns.length; i++)
      if (ns[i + 1].pitch !== ns[i].pitch && ns[i + 1].start < ns[i].start + ns[i].duration - 1e-9) slides++;
  }
  ok("acid: seeded slide overlaps onto different pitches (" + slides + " across 8 seeds)", slides >= 1);
}
// rolling is busier than sub
{
  const roll = G.writeBassline("C", "minor", ["i"], { style: "rolling", seed: 0, swing: 0 });
  const sub = G.writeBassline("C", "minor", ["i"], { style: "sub", seed: 0, swing: 0 });
  ok("rolling is busier than sub", roll.length > sub.length);
}

// --- swing still works via applySwing ----------------------------------------
{
  const step = G.BASS_GRAMMAR["tech-house"].swingStep;
  const dry = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: 3, swing: 0 });
  const wet = G.writeBassline("A", "minor", PROG, { style: "tech-house", seed: 3, swing: 0.5 });
  ok("tech-house swing == applySwing(dry, 0.5, swingStep)", JSON.stringify(wet) === JSON.stringify(G.applySwing(dry, 0.5, step)));
  ok("tech-house swing shifts off-16ths later", wet.some((n, i) => n.start > dry[i].start));
}
{
  const dry = G.writeBassline("C", "minor", PROG, { style: "offbeat", seed: 2, swing: 0 });
  const wet = G.writeBassline("C", "minor", PROG, { style: "offbeat", seed: 2, swing: 0.5 });
  ok("offbeat swing == applySwing(dry, 0.5, 1)", JSON.stringify(wet) === JSON.stringify(G.applySwing(dry, 0.5, 1)));
  ok("swing delays the offbeat 8ths", wet[0].start > 0.5);
}

// --- options keep working -----------------------------------------------------
{
  const ns = G.writeBassline("C", "minor", ["i", "VI"], { style: "tech-house", seed: 1, beatsPerChord: 2, swing: 0 });
  ok("beatsPerChord=2: notes fit inside 4 beats", ns.every((n) => n.start < 4 && n.start + n.duration <= 4 + 1e-9));
  const w2 = ns.filter((n) => n.start >= 2).sort((a, b) => a.start - b.start)[0];
  ok("beatsPerChord=2: second window locks to Ab root", w2 && w2.pitch % 12 === 8);
}
{
  const ns = G.writeBassline("C", "minor", PROG, { style: "tech-house", seed: 0, octave: 2, swing: 0 });
  ok("octave=2 register: pitches in [40..63]", ns.every((n) => n.pitch >= 40 && n.pitch <= 63));
}
{
  const lo = G.writeBassline("C", "minor", PROG, { style: "tech-house", seed: 4, velocity: 70, swing: 0 });
  const hi = G.writeBassline("C", "minor", PROG, { style: "tech-house", seed: 4, velocity: 120, swing: 0 });
  const avg = (ns) => ns.reduce((s, n) => s + n.velocity, 0) / ns.length;
  ok("velocity option scales the groove", avg(hi) > avg(lo));
}
// style aliases resolve (the producer types "tech house", "techhouse", ...)
ok("style aliases resolve to tech-house", G.resolveStyle("tech house") === "tech-house" && G.resolveStyle("techhouse") === "tech-house" && G.resolveStyle("TECH-HOUSE") === "tech-house");
// unknown style falls back instead of crashing
ok("unknown style falls back gracefully", Array.isArray(G.writeBassline("C", "minor", ["i"], { style: "wat", seed: 0, swing: 0 })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
