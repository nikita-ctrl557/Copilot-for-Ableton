#!/usr/bin/env node
// test-voice.js — run the EXACT voice pipeline (ffmpeg record → whisper transcribe)
// outside Live, with full verbosity. Pinpoints WHICH stage fails:
//   - device listing        (ffmpeg avfoundation)
//   - 3s capture            (mic permission for your TERMINAL — note: inside Live the
//                            permission belongs to Ableton Live instead)
//   - transcription         (whisper CLI + model)
// usage: node scripts/test-voice.js [micIndex]   (omit index = auto-pick)
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");

const WAV = os.tmpdir() + "/copilot-voice-test.wav";
const JSONOUT = os.tmpdir() + "/copilot-voice-test.json";
function bin(name) { for (const d of ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"]) if (fs.existsSync(d + name)) return d + name; return null; }

(async () => {
  console.log("══════════════════════════════════════════════");
  console.log(" Claude Copilot — voice pipeline test");
  console.log("══════════════════════════════════════════════");
  const ff = bin("ffmpeg"), wh = bin("whisper");
  console.log("ffmpeg :", ff || "✗ NOT FOUND → brew install ffmpeg");
  console.log("whisper:", wh || "✗ NOT FOUND → brew install openai-whisper");
  if (!ff || !wh) process.exit(1);

  // 1. devices
  const devs = await new Promise((res) => execFile(ff, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], (e, so, se) => {
    const part = (String(se || "") + String(so || "")).split(/AVFoundation audio devices/i)[1] || "";
    res([...part.matchAll(/\[(\d+)\]\s+([^\n\[]+)/g)].map((m) => ({ index: +m[1], name: m[2].trim() })));
  }));
  console.log("\ninput devices:");
  devs.forEach((d) => console.log("  [" + d.index + "] " + d.name));
  let mic = process.argv[2] != null ? Number(process.argv[2])
    : (devs.find((d) => /microphone|built-in|mic\b/i.test(d.name)) || devs[0] || {}).index;
  if (mic == null) { console.log("✗ no input devices at all"); process.exit(1); }
  console.log("\nusing mic [" + mic + "] — SPEAK NOW (recording 3 seconds)…");

  // 2. capture 3s
  try { fs.unlinkSync(WAV); } catch {}
  let stderr = "";
  const code = await new Promise((res) => {
    const p = spawn(ff, ["-y", "-f", "avfoundation", "-i", ":" + mic, "-t", "3", "-ar", "16000", "-ac", "1", WAV], { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-3000)));
    p.on("close", res); p.on("error", () => res(-1));
  });
  const size = (() => { try { return fs.statSync(WAV).size; } catch { return 0; } })();
  console.log("capture: exit " + code + ", " + Math.round(size / 1024) + "KB");
  if (size < 1000) {
    console.log("✗ CAPTURE FAILED. ffmpeg said:\n  " + stderr.split("\n").filter(Boolean).slice(-4).join("\n  "));
    console.log("\n→ If it says 'not permitted': grant Microphone permission to your TERMINAL app");
    console.log("  (System Settings ▸ Privacy & Security ▸ Microphone). Inside Ableton, the same");
    console.log("  permission must be granted to ABLETON LIVE instead.");
    process.exit(1);
  }
  console.log("✓ capture OK");

  // 3. transcribe
  console.log("\ntranscribing (first run may download the model)…");
  try { fs.unlinkSync(JSONOUT); } catch {}
  await new Promise((res) => execFile(wh, [WAV, "--model", "base.en", "--language", "en", "--fp16", "False", "--output_format", "json", "--output_dir", os.tmpdir()], { timeout: 300000, maxBuffer: 16 * 1024 * 1024 }, (e, so, se) => {
    if (e) console.log("✗ whisper failed:\n  " + String(se || e.message).split("\n").filter(Boolean).slice(-4).join("\n  "));
    res();
  }));
  try {
    const text = (JSON.parse(fs.readFileSync(JSONOUT.replace(".json", "") + ".json", "utf8")).text || "").trim();
    console.log(text ? "✓ TRANSCRIPT: \"" + text + "\"\n\n→ the pipeline WORKS. If voice still fails inside Ableton, it's Live's mic permission." : "✗ empty transcript (was there audio?)");
  } catch (e) { console.log("✗ no transcript JSON found: " + e.message); }
})();
