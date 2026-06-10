#!/usr/bin/env node
// diagnose.js — ground truth. Talks DIRECTLY to the Claude_Copilot remote script
// socket (port 9001) inside Live, bypassing the whole Max-for-Live chain. Tells us
// exactly what works: is the loader running, can it see the browser, can it read a
// device's real parameters, can it load a reverb.
//
// Usage:
//   node scripts/diagnose.js            # read-only checks (safe, no changes to your set)
//   node scripts/diagnose.js --load 0   # also try loading a Reverb onto track 0
//
// Paste the whole output back and I'll know precisely what to fix.
const net = require("net");
const PORT = 9001;

function call(req, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "", settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} fn(v); };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i < 0) return; let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { return done(reject, e); } done(resolve, m); });
    sock.on("error", (e) => done(reject, e));
    setTimeout(() => done(reject, new Error("timeout after " + timeoutMs + "ms")), timeoutMs);
  });
}

function line(s) { process.stdout.write(s + "\n"); }
function ok(s) { line("  ✓ " + s); }
function bad(s) { line("  ✗ " + s); }

(async () => {
  line("════════════════════════════════════════════════════════");
  line(" Claude Copilot — loader diagnostic (talks to Live :9001)");
  line("════════════════════════════════════════════════════════");

  // 1. is the remote script even running?
  try {
    const r = await call({ op: "ping" }, 3000);
    if (r && r.ok) ok("remote script is RUNNING and reachable on port " + PORT + "  " + JSON.stringify(r));
    else { bad("ping returned an unexpected reply: " + JSON.stringify(r)); }
  } catch (e) {
    bad("CANNOT reach the remote script on port " + PORT + " — " + e.message);
    line("");
    line("  → This is the #1 reason loading fails. Fix it:");
    line("    1. Live ▸ Settings ▸ Link/Tempo/MIDI ▸ a free Control Surface slot ▸ pick 'Claude_Copilot'.");
    line("    2. Fully QUIT and reopen Live (it only scans Remote Scripts at startup).");
    line("    3. On first run macOS may pop 'Live wants to accept incoming connections' → Allow.");
    line("    4. Re-run this:  node scripts/diagnose.js");
    line("");
    line("  Check Live's log for our startup line:");
    line("    tail -50 ~/Library/Preferences/Ableton/Live*/Log.txt | grep -i claude");
    process.exit(1);
  }

  // 2. full diagnostic dump from inside Live
  let diag;
  try {
    diag = await call({ op: "diag" }, 12000);
  } catch (e) {
    bad("diag op failed (older remote script installed?) — re-run scripts/install.sh. " + e.message);
  }
  if (diag && diag.ok) {
    line("");
    line("── what Live exposes to the loader ──");
    ok("Live version: " + (diag.liveVersion || "?"));
    ok("browser categories visible: " + (diag.browserCategories || []).join(", "));
    if (diag.audioEffectsSample) ok("sample audio effects: " + diag.audioEffectsSample.join(", "));
    if (diag.instrumentsSample) ok("sample instruments: " + diag.instrumentsSample.join(", "));
    if (diag.reverbFound != null) (diag.reverbFound ? ok : bad)("can locate a loadable 'Reverb' in the browser: " + diag.reverbFound);
    line("");
    line("── tracks in your set ──");
    (diag.tracks || []).forEach((t) => {
      line("  track " + t.index + "  \"" + t.name + "\"  (" + t.type + ")  devices: [" + (t.devices || []).join(", ") + "]");
    });
    if (diag.firstDeviceParams) {
      line("");
      line("── REAL parameters of the first device found (proves param control works) ──");
      line("  device: " + diag.firstDeviceParams.device + "  on track " + diag.firstDeviceParams.track);
      (diag.firstDeviceParams.params || []).slice(0, 40).forEach((p) => {
        line("    [" + p.index + "] " + p.name + " = " + p.value + "  (" + p.min + "…" + p.max + ")");
      });
    }
  } else if (diag) {
    bad("diag returned: " + JSON.stringify(diag).slice(0, 400));
  }

  // 3. optional: actually load a reverb (mutates the set, so opt-in)
  const li = process.argv.indexOf("--load");
  if (li >= 0) {
    const track = parseInt(process.argv[li + 1] || "0", 10);
    line("");
    line("── LIVE TEST: loading a Reverb onto track " + track + " ──");
    try {
      const r = await call({ op: "load", kind: "audioEffect", name: "Reverb", track }, 20000);
      if (r && r.ok && r.added) ok("LOADED '" + r.loaded + "' — track now has " + r.deviceCount + " devices. Loading WORKS. 🎉");
      else if (r && r.ok && !r.added) bad("matched '" + r.loaded + "' but device count did not increase. alternatives: " + JSON.stringify(r.alternatives));
      else bad("load failed: " + JSON.stringify(r));
    } catch (e) { bad("load threw: " + e.message); }
  } else {
    line("");
    line("  (read-only run. To actually test loading:  node scripts/diagnose.js --load 0 )");
  }
  line("");
})();
