// test-cli-live.js — full subscription path: real `claude` CLI (clean env) + MCP
// tools bridge + MOCK Ableton. Proves tool calls round-trip and Claude answers.
//   run: node scripts/test-cli-live.js
const { CliAgent } = require("../device/node/cliAgent");

const live = {
  async call(kind) {
    if (kind === "session_info") return { tempo: 120, timeSignature: [4, 4], isPlaying: false, trackCount: 3, sceneCount: 8, selectedTrack: 0 };
    if (kind === "list_tracks") return { tracks: [
      { index: 0, name: "Drums", type: "midi", volume: 0.85, pan: 0, isMuted: false, deviceCount: 2 },
      { index: 1, name: "Reese Bass", type: "midi", volume: 0.8, pan: 0, isMuted: false, deviceCount: 1 },
      { index: 2, name: "Rhodes Keys", type: "midi", volume: 0.78, pan: -0.1, isMuted: false, deviceCount: 1 },
    ] };
    return { ok: true };
  },
};

const agent = new CliAgent({ model: "claude-opus-4-8", live });
const tools = [];
setTimeout(() => {
  console.log("bridge port:", agent.port, "— spawning claude (clean env, subscription)…\n");
  agent.run("What's on each track? One short line per track.", {
    onText: (t) => process.stdout.write(t),
    onTool: (tu) => { tools.push(tu.name); console.log("\n[tool ▶]", tu.name); },
    onToolResult: (tu, info) => console.log("[tool ✓]", tu.name, info.error ? "ERROR " + info.error : (info.label || "")),
    onError: (e) => console.log("\n[ERROR]", e.message),
    onDone: () => {
      console.log("\n\n[done] tools called:", tools.join(", ") || "(none)");
      console.log(tools.includes("list_tracks") ? "✓ PASS — Claude used list_tracks via the subscription + MCP bridge" : "✗ FAIL — Claude did not call list_tracks");
      process.exit(0);
    },
  });
}, 600);
