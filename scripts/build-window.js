#!/usr/bin/env node
// build-window.js — generate ClaudeCopilotWindow.amxd: a variant of the copilot where
// the chat lives in a BIG RESIZABLE FLOATING WINDOW (opens like a plugin editor),
// instead of the fixed-height device strip.
//
// KEY: there is only ONE jweb (one CEF web view) — it lives in the floating [p chat]
// subpatcher. The device strip itself is just a launcher BUTTON. A second simultaneous
// web view crashes Live (confirmed), so this design never creates one.
//
//   device strip:  [button "Open Claude"] --bang--> [open( --> [pcontrol] --> [p chat]
//   [live.thisdevice] --bang--> [v8 liveapi.js]
//   [node.script main.js] --> [route liveapi_call] -- liveapi_call --> [v8]
//                                                   \- rest (ui) ----> [s claude_ui]
//   [r claude_fromjweb] --> [node.script]            (jweb msgs come back via send/recv)
//   inside [p chat]:  [loadbang]->[url file://chat.html]->[jweb]  ; [r claude_ui]->[jweb]
//                     [jweb]->[s claude_fromjweb]
//
// usage: node build-window.js [deviceDir]

const fs = require("fs");
const path = require("path");
const { buildAmxd, parseAmxd } = require("../tools/amxd.js");

const deviceDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "device"));
const chatPath = path.join(deviceDir, "chat.html");
const mainPath = path.join(deviceDir, "node", "main.js");
const v8Path = path.join(deviceDir, "v8", "liveapi.js");
const resizePath = path.join(deviceDir, "v8", "winresize.js");
const outPath = path.join(deviceDir, "ClaudeCopilotWindow.amxd");

for (const [label, f] of [["chat.html", chatPath], ["main.js", mainPath], ["liveapi.js", v8Path], ["winresize.js", resizePath]]) {
  if (!fs.existsSync(f)) { console.error(`! missing ${label}: ${f}`); process.exit(1); }
}

const box = (b) => ({ box: b });
const W = 360, H = 130;          // small device-strip launcher
const BW = 440, BH = 600;        // small, plugin-style floating chat (user can drag/resize)

// ---- the floating chat window: ONE jweb, file:// + Max transport via send/recv ----
// PATCHING view on purpose (openinpresentation: 0): resizing presentation rects via
// scripting is flaky across Max builds, while Maxobj.rect in patching view is rock
// solid. All helper boxes are parked at the top-left UNDER the jweb — the jweb is
// the LAST box (top of the z-order) and covers the whole window; the resize
// follower keeps it exactly window-sized.
const chatWin = {
  fileversion: 1,
  appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
  classnamespace: "box",
  rect: [200, 160, BW, BH],
  openinpresentation: 0,
  toolbarvisible: 0,            // no Max toolbar — just the chat
  enablehscroll: 0, enablevscroll: 0,
  gridonopen: 0,
  title: "Claude Copilot",
  default_fontsize: 12.0, default_fontface: 0, default_fontname: "Ableton Sans Medium",
  boxes: [
    box({ id: "sub-inlet", maxclass: "inlet", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [4.0, 4.0, 20.0, 20.0] }),
    box({ id: "sub-load", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["bang", "bang"], patching_rect: [4.0, 28.0, 60.0, 22.0], text: "loadbang" }),
    box({ id: "sub-urlmsg", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [4.0, 54.0, 200.0, 22.0], text: "url file://" + chatPath }),
    box({ id: "sub-uirecv", maxclass: "newobj", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [4.0, 80.0, 90.0, 22.0], text: "r claude_ui" }),
    // float the window OVER Ableton like a plugin editor (always-on-top, resizable)
    box({ id: "sub-floattrig", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["bang", "bang"], patching_rect: [4.0, 106.0, 40.0, 22.0], text: "t b b" }),
    box({ id: "sub-flagsmsg", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [48.0, 106.0, 180.0, 22.0], text: "window flags float, grow, nomenu" }),
    box({ id: "sub-execmsg", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [4.0, 132.0, 90.0, 22.0], text: "window exec" }),
    box({ id: "sub-thispatcher", maxclass: "newobj", numinlets: 1, numoutlets: 4, outlettype: ["", "", "", ""], patching_rect: [98.0, 132.0, 80.0, 22.0], text: "thispatcher" }),
    // RESIZE FOLLOWER: polls the window size 4×/s and stretches the jweb to fill
    // (direct Maxobj.rect + script sendbox fallback) — see device/v8/winresize.js
    box({ id: "sub-resize", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""],
      patching_rect: [4.0, 158.0, 220.0, 22.0], text: "js " + resizePath }),
    box({ id: "sub-sendout", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [4.0, 184.0, 140.0, 22.0], text: "s claude_fromjweb" }),
    // the jweb is LAST = drawn on top, covering everything; starts exactly window-sized
    box({ id: "sub-jweb", maxclass: "jweb", numinlets: 1, numoutlets: 2, outlettype: ["", ""], varname: "chatweb",
      patching_rect: [0.0, 0.0, BW, BH], enablejavascript: 1 }),
  ],
  lines: [
    { patchline: { source: ["sub-load", 0], destination: ["sub-urlmsg", 0] } },
    { patchline: { source: ["sub-load", 1], destination: ["sub-floattrig", 0] } },
    // trigger fires right→left: flags first, then exec
    { patchline: { source: ["sub-floattrig", 1], destination: ["sub-flagsmsg", 0] } },
    { patchline: { source: ["sub-floattrig", 0], destination: ["sub-execmsg", 0] } },
    { patchline: { source: ["sub-flagsmsg", 0], destination: ["sub-thispatcher", 0] } },
    { patchline: { source: ["sub-execmsg", 0], destination: ["sub-thispatcher", 0] } },
    { patchline: { source: ["sub-urlmsg", 0], destination: ["sub-jweb", 0] } },
    { patchline: { source: ["sub-uirecv", 0], destination: ["sub-jweb", 0] } },
    { patchline: { source: ["sub-jweb", 0], destination: ["sub-sendout", 0] } },
    // start the resize follower once the window loads; its output drives thispatcher
    { patchline: { source: ["sub-load", 0], destination: ["sub-resize", 0] } },
    { patchline: { source: ["sub-resize", 0], destination: ["sub-thispatcher", 0] } },
  ],
};
// the launcher's pcontrol "open" arrives at sub-inlet — route it to nothing (the
// window opens by itself); the inlet only exists so pcontrol can target the patcher.

const patch = {
  patcher: {
    fileversion: 1,
    appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect: [60, 80, W + 60, H + 220],
    openinpresentation: 1,
    default_fontsize: 12.0, default_fontface: 0, default_fontname: "Ableton Sans Medium",
    gridonopen: 1, gridsize: [15.0, 15.0],
    boxes: [
      // device-strip launcher (presentation): a label + an Open button
      box({ id: "obj-title", maxclass: "comment", numinlets: 1, numoutlets: 0, patching_rect: [20.0, 20.0, 300.0, 20.0], presentation: 1, presentation_rect: [10.0, 8.0, 300.0, 20.0], text: "Claude Copilot", fontsize: 13.0 }),
      box({ id: "obj-btn", maxclass: "live.text", numinlets: 1, numoutlets: 1, outlettype: [""],
        patching_rect: [20.0, 48.0, 140.0, 30.0], presentation: 1, presentation_rect: [10.0, 34.0, 160.0, 34.0],
        text: "◳ Open Chat Window", parameter_enable: 0 }),
      box({ id: "obj-hint", maxclass: "comment", numinlets: 1, numoutlets: 0, patching_rect: [20.0, 84.0, 320.0, 20.0], presentation: 1, presentation_rect: [10.0, 74.0, 330.0, 34.0], text: "Opens a big resizable chat window (like a plugin).", fontsize: 10.0 }),

      box({ id: "obj-tdev", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["bang", "bang", ""],
        patching_rect: [20.0, 130.0, 110.0, 22.0], text: "live.thisdevice" }),
      box({ id: "obj-node", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["", ""],
        patching_rect: [200.0, 130.0, 460.0, 22.0], text: "node.script " + mainPath + " @autostart 1 @watch 0" }),
      box({ id: "obj-route", maxclass: "newobj", numinlets: 1, numoutlets: 2, outlettype: ["", ""],
        patching_rect: [200.0, 168.0, 150.0, 22.0], text: "route liveapi_call" }),
      box({ id: "obj-prepend", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""],
        patching_rect: [200.0, 200.0, 180.0, 22.0], text: "prepend liveapi_call" }),
      box({ id: "obj-v8", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""],
        patching_rect: [400.0, 200.0, 420.0, 22.0], text: "v8 " + v8Path }),
      box({ id: "obj-uisend", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [560.0, 168.0, 120.0, 22.0], text: "s claude_ui" }),
      box({ id: "obj-fromjweb", maxclass: "newobj", numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [560.0, 96.0, 150.0, 22.0], text: "r claude_fromjweb" }),

      box({ id: "obj-openmsg", maxclass: "message", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [20.0, 84.0, 50.0, 22.0], text: "open" }),
      box({ id: "obj-pcontrol", maxclass: "newobj", numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [90.0, 84.0, 60.0, 22.0], text: "pcontrol" }),
      box({ id: "obj-chat", maxclass: "newobj", numinlets: 1, numoutlets: 0, patching_rect: [20.0, 240.0, 120.0, 22.0], text: "p chat", patcher: chatWin }),

      box({ id: "obj-plugin", maxclass: "newobj", numinlets: 1, numoutlets: 3, outlettype: ["signal", "signal", ""], patching_rect: [700.0, 130.0, 60.0, 22.0], text: "plugin~" }),
      box({ id: "obj-plugout", maxclass: "newobj", numinlets: 2, numoutlets: 0, patching_rect: [700.0, 162.0, 60.0, 22.0], text: "plugout~" }),
    ],
    lines: [
      // launcher button -> open the floating window
      { patchline: { source: ["obj-btn", 0], destination: ["obj-openmsg", 0] } },
      { patchline: { source: ["obj-openmsg", 0], destination: ["obj-pcontrol", 0] } },
      { patchline: { source: ["obj-pcontrol", 0], destination: ["obj-chat", 0] } },
      // init v8
      { patchline: { source: ["obj-tdev", 0], destination: ["obj-v8", 0] } },
      // node -> route ; liveapi_call -> v8 ; ui -> window jweb (via send)
      { patchline: { source: ["obj-node", 0], destination: ["obj-route", 0] } },
      { patchline: { source: ["obj-route", 0], destination: ["obj-prepend", 0] } },
      { patchline: { source: ["obj-prepend", 0], destination: ["obj-v8", 0] } },
      { patchline: { source: ["obj-route", 1], destination: ["obj-uisend", 0] } },
      // window jweb -> node ; v8 replies -> node
      { patchline: { source: ["obj-fromjweb", 0], destination: ["obj-node", 0] } },
      { patchline: { source: ["obj-v8", 0], destination: ["obj-node", 0] } },
      // audio passthrough
      { patchline: { source: ["obj-plugin", 0], destination: ["obj-plugout", 0] } },
      { patchline: { source: ["obj-plugin", 1], destination: ["obj-plugout", 1] } },
    ],
  },
};

const amxd = buildAmxd(patch, "audio-effect", "ClaudeCopilotWindow.amxd");
fs.writeFileSync(outPath, amxd);
const p = parseAmxd(fs.readFileSync(outPath));
console.log(`baked ${outPath}`);
console.log(`  ${amxd.length} bytes · deviceCode=${p.deviceCode} · boxes=${p.patch.patcher.boxes.length} · lines=${p.patch.patcher.lines.length}`);
console.log(`  ONE jweb, in the floating [p chat] window. Device strip = launcher button.`);
