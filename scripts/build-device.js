#!/usr/bin/env node
// build-device.js — generate ClaudeCopilot.amxd.
//
// LAYOUT (single web view — two CEF views crashed Live, so the chat lives in ONE
// floating window and the device strip is a launcher):
//   • Device strip: "Open Chat ⤢" button (+ label). Click → the chat window pops out.
//   • The chat: a jweb inside [p chat], whose patcher window is FLOATING (always-on-top,
//     movable, resizable, no toolbar) — a plugin-style window over Ableton.
//   • Auto-opens ~0.7s after the device loads; reopen any time with the button or the
//     chat's own ⤢ (routes through node → "openbig").
//
// Messaging crosses the patcher boundary via [s]/[r]:
//   node "ui …" → route(rest) → [s claude_ui]   → [r claude_ui]   → jweb
//   jweb out    → [s claude_fromjweb]           → [r claude_fromjweb] → node
//   route liveapi_call → [prepend liveapi_call] → v8 → node   (LiveAPI round-trip)
//   route openbig → "open" → [pcontrol] → [p chat]             (pop the window)
//
// usage: node build-device.js [deviceDir]

const fs = require("fs");
const path = require("path");
const { buildAmxd, parseAmxd } = require("../tools/amxd.js");

const deviceDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "device"));
const chatPath = path.join(deviceDir, "chat.html");
const mainPath = path.join(deviceDir, "node", "main.js");
const v8Path = path.join(deviceDir, "v8", "liveapi.js");
const outPath = path.join(deviceDir, "ClaudeCopilot.amxd");

for (const [label, f] of [["chat.html", chatPath], ["main.js", mainPath], ["liveapi.js", v8Path]]) {
  if (!fs.existsSync(f)) { console.error(`! missing ${label}: ${f}`); process.exit(1); }
  if (f.includes(" ")) console.warn(`! WARNING: path contains a space, Max object args may break: ${f}`);
}

const box = (b) => ({ box: b });

// device strip size (Ableton fixes the height; keep it compact — it's just a launcher)
const W = 300, H = 64;
// the floating chat window (user can move/resize it freely)
const CW = 480, CH = 640;

// ---- [p chat]: the floating window holding the ONE jweb ----
const chatPatcher = {
  fileversion: 1,
  appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
  classnamespace: "box",
  rect: [220, 140, CW, CH],
  openinpresentation: 1,
  toolbarvisible: 0,
  enablehscroll: 0, enablevscroll: 0,
  title: "Claude Copilot",
  default_fontsize: 12.0, default_fontname: "Ableton Sans Medium",
  boxes: [
    box({ id: "c-inlet", maxclass: "inlet", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [16, 12, 24, 24] }),
    box({ id: "c-load", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: ["bang"], patching_rect: [16, 44, 64, 22], text: "loadbang" }),
    box({ id: "c-trig", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["bang", "bang", "bang"], patching_rect: [16, 74, 80, 22], text: "t b b b" }),
    box({ id: "c-flags", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [110, 74, 210, 22], text: "window flags float, grow, nomenu" }),
    box({ id: "c-exec", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [330, 74, 90, 22], text: "window exec" }),
    box({ id: "c-this", maxclass: "newobj", numinlets: 1, numoutlets: 4, outlettype: ["", "", "", ""], patching_rect: [110, 106, 80, 22], text: "thispatcher" }),
    box({ id: "c-url", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [16, 106, 420, 22], text: "url file://" + chatPath + "?v=" + Date.now() }),
    box({ id: "c-uirecv", maxclass: "newobj", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [16, 138, 100, 22], text: "r claude_ui" }),
    box({ id: "c-jweb", maxclass: "jweb", numinlets: 1, numoutlets: 2, outlettype: ["", ""],
      patching_rect: [16, 170, CW - 32, CH - 200], presentation: 1, presentation_rect: [0, 0, CW, CH], enablejavascript: 1 }),
    box({ id: "c-send", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [16, CH - 16, 150, 22], text: "s claude_fromjweb" }),
  ],
  lines: [
    { patchline: { source: ["c-load", 0], destination: ["c-trig", 0] } },
    // trigger fires right→left: flags, exec, then url
    { patchline: { source: ["c-trig", 2], destination: ["c-flags", 0] } },
    { patchline: { source: ["c-trig", 1], destination: ["c-exec", 0] } },
    { patchline: { source: ["c-trig", 0], destination: ["c-url", 0] } },
    { patchline: { source: ["c-flags", 0], destination: ["c-this", 0] } },
    { patchline: { source: ["c-exec", 0], destination: ["c-this", 0] } },
    { patchline: { source: ["c-url", 0], destination: ["c-jweb", 0] } },
    { patchline: { source: ["c-uirecv", 0], destination: ["c-jweb", 0] } },
    { patchline: { source: ["c-jweb", 0], destination: ["c-send", 0] } },
  ],
};

const patch = {
  patcher: {
    fileversion: 1,
    appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect: [60, 80, 760, 420],
    openinpresentation: 1,
    default_fontsize: 12.0, default_fontface: 0, default_fontname: "Ableton Sans Medium",
    gridonopen: 1, gridsize: [15.0, 15.0],
    boxes: [
      // --- device-strip UI (presentation) ---
      box({ id: "ui-label", maxclass: "comment", numinlets: 1, numoutlets: 0, patching_rect: [20, 20, 260, 18],
        presentation: 1, presentation_rect: [10, 6, 280, 18], fontsize: 11, text: "🎛 Claude Copilot — chat lives in its own window" }),
      box({ id: "ui-btn", maxclass: "textbutton", numinlets: 1, numoutlets: 3, outlettype: ["", "", "int"],
        patching_rect: [20, 44, 140, 30], presentation: 1, presentation_rect: [10, 28, 150, 28],
        text: "Open Chat  ⤢", fontsize: 13 }),
      // --- plumbing ---
      box({ id: "obj-tdev", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["bang", "bang", ""], patching_rect: [200, 20, 110, 22], text: "live.thisdevice" }),
      box({ id: "obj-del", maxclass: "newobj", numinlets: 2, numoutlets: 1, outlettype: ["bang"], patching_rect: [200, 50, 70, 22], text: "del 700" }),
      box({ id: "obj-open", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [200, 80, 50, 22], text: "open" }),
      box({ id: "obj-pctl", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [200, 110, 60, 22], text: "pcontrol" }),
      box({ id: "obj-chatwin", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [200, 142, 70, 22], text: "p chat", patcher: chatPatcher }),
      box({ id: "obj-node", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["", ""], patching_rect: [320, 20, 420, 22], text: "node.script " + mainPath + " @autostart 1 @watch 0" }),
      box({ id: "obj-fromjweb", maxclass: "newobj", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [320, 50, 140, 22], text: "r claude_fromjweb" }),
      box({ id: "obj-route", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["", "", ""], patching_rect: [320, 84, 220, 22], text: "route liveapi_call openbig" }),
      box({ id: "obj-prepend", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [320, 116, 180, 22], text: "prepend liveapi_call" }),
      box({ id: "obj-v8", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [320, 148, 400, 22], text: "v8 " + v8Path }),
      box({ id: "obj-uisend", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [560, 116, 110, 22], text: "s claude_ui" }),
      box({ id: "obj-plugin", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["signal", "signal", ""], patching_rect: [20, 200, 60, 22], text: "plugin~" }),
      box({ id: "obj-plugout", maxclass: "newobj", numinlets: 2, numoutlets: 0, patching_rect: [20, 232, 60, 22], text: "plugout~" }),
    ],
    lines: [
      // init: v8 + auto-open the chat window shortly after load
      { patchline: { source: ["obj-tdev", 0], destination: ["obj-v8", 0] } },
      { patchline: { source: ["obj-tdev", 0], destination: ["obj-del", 0] } },
      { patchline: { source: ["obj-del", 0], destination: ["obj-open", 0] } },
      // strip button → open the window
      { patchline: { source: ["ui-btn", 0], destination: ["obj-open", 0] } },
      { patchline: { source: ["obj-open", 0], destination: ["obj-pctl", 0] } },
      { patchline: { source: ["obj-pctl", 0], destination: ["obj-chatwin", 0] } },
      // chat → node
      { patchline: { source: ["obj-fromjweb", 0], destination: ["obj-node", 0] } },
      // node → route: liveapi_call → v8 ; openbig → open window ; rest (ui …) → chat
      { patchline: { source: ["obj-node", 0], destination: ["obj-route", 0] } },
      { patchline: { source: ["obj-route", 0], destination: ["obj-prepend", 0] } },
      { patchline: { source: ["obj-prepend", 0], destination: ["obj-v8", 0] } },
      { patchline: { source: ["obj-route", 1], destination: ["obj-open", 0] } },
      { patchline: { source: ["obj-route", 2], destination: ["obj-uisend", 0] } },
      // v8 replies → node
      { patchline: { source: ["obj-v8", 0], destination: ["obj-node", 0] } },
      // audio passthrough
      { patchline: { source: ["obj-plugin", 0], destination: ["obj-plugout", 0] } },
      { patchline: { source: ["obj-plugin", 1], destination: ["obj-plugout", 1] } },
    ],
  },
};

const amxd = buildAmxd(patch, "audio-effect", "ClaudeCopilot.amxd");
fs.writeFileSync(outPath, amxd);
const p = parseAmxd(fs.readFileSync(outPath));
console.log(`baked ${outPath}`);
console.log(`  ${amxd.length} bytes · deviceCode=${p.deviceCode} · boxes=${p.patch.patcher.boxes.length} · lines=${p.patch.patcher.lines.length}`);
console.log(`  strip = "Open Chat ⤢" button · chat = floating ${CW}x${CH} movable window (ONE jweb)`);
