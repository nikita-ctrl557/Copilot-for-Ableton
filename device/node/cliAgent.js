// cliAgent.js — subscription mode via the `claude` CLI (uses the Pro/Max OAuth in
// ~/.claude, NO API key). The key fix: spawn claude with a SCRUBBED environment so
// inherited vars (esp. ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY) can't hijack auth and
// cause "401 Invalid authentication credentials".
//
// Ableton tools are given to claude as an MCP server (mcp-ableton.js), whose calls
// come back to this process over a localhost TCP bridge and run the real dispatch
// against Live (via the injected `live` -> v8). Same callback contract as Agent.
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { dispatch } = require("../../core/tools");
const { SYSTEM } = require("../../core/agent");
const projectMemory = require("../../core/projectMemory");

class CliAgent {
  constructor({ model, live, effort }) {
    this.model = model;
    this.live = live;
    this.effort = ["quick", "standard", "meticulous"].includes(effort) ? effort : "standard";
    this.sessionId = null;
    this._cb = {};
    this.port = null;
    this._startBridge();
  }

  setModel(m) { this.model = m; }
  setEffort(e) { if (["quick", "standard", "meticulous"].includes(e)) this.effort = e; }
  _effortLine() {
    return this.effort === "quick"
      ? "EFFORT MODE: QUICK — do the literal ask efficiently; one listen pass; skip the full checklist and extras unless asked."
      : this.effort === "meticulous"
      ? "EFFORT MODE: METICULOUS — go all the way: research references, full production checklist, recursive listening until clean, extra polish."
      : "EFFORT MODE: STANDARD — complete, verified work with the normal listen-and-fix loop.";
  }
  reset() { this.sessionId = null; projectMemory.resetKey(); }
  stop() { this._stopped = true; try { if (this._child) this._child.kill("SIGKILL"); } catch {} }

  // TCP server: mcp-ableton.js connects here per tool call.
  _startBridge() {
    this.server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", async (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let req; try { req = JSON.parse(line); } catch { continue; }
          const cb = this._cb;
          try { cb.onTool && cb.onTool({ name: req.tool }); } catch {}
          try {
            const { result, label, detail } = await dispatch(req.tool, req.input || {}, { live: this.live });
            try { cb.onToolResult && cb.onToolResult({ name: req.tool }, { label, detail, result }); } catch {}
            sock.write(JSON.stringify({ id: req.id, ok: true, result: result ?? { ok: true } }) + "\n");
          } catch (e) {
            const msg = String((e && e.message) || e);
            try { cb.onToolResult && cb.onToolResult({ name: req.tool }, { error: msg }); } catch {}
            sock.write(JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
          }
        }
      });
    });
    this.server.on("error", () => {});
    this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; });
  }

  _cleanEnv() {
    // STRICT WHITELIST. The inherited env (e.g. when launched under another agent)
    // can carry vars that hijack auth and cause 401s; only HOME (for ~/.claude),
    // a fixed PATH, and LANG are passed. Verified: this authenticates the plan.
    const HOME = process.env.HOME || "";
    return {
      HOME,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + HOME + "/.local/bin",
      LANG: "en_US.UTF-8",
    };
  }

  async run(userText, cb = {}) {
    this._cb = cb;
    const { onText = () => {}, onError = () => {}, onDone = () => {}, onStage = () => {} } = cb;
    if (!this.port) { onError(new Error("tool bridge not ready yet — try again")); onDone(); return; }

    // Fresh PROJECT STATE for THIS turn (live snapshot + saved memory). Appended to the
    // system prompt AND prepended to the user text so the CLI sees it even across --resume.
    onStage("Reading your project…");
    let projectState = "";
    try { const s = await projectMemory.buildState(); projectState = s.text || ""; } catch {}
    onStage("Starting Claude…");
    const stateWithEffort = this._effortLine() + (projectState ? "\n" + projectState : "");
    const systemPrompt = SYSTEM + "\n\n" + stateWithEffort;
    const promptText = stateWithEffort + "\n\n---\n" + userText;

    // find the claude CLI wherever THIS machine has it — every user installs it
    // differently (native installer, homebrew, npm). Hardcoding one path broke
    // sign-in for everyone but the original author.
    const fsx = require("fs");
    const HOME = process.env.HOME || "";
    const candidates = [
      path.join(HOME, ".local/bin/claude"),
      "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude",
      path.join(HOME, ".npm-global/bin/claude"), path.join(HOME, "bin/claude"),
    ];
    const claudeBin = candidates.find((p) => { try { return fsx.existsSync(p); } catch { return false; } });
    if (!claudeBin) {
      onError(new Error("Claude Code CLI not found — subscription mode needs it. Install it (https://claude.com/claude-code), run `claude` once in Terminal and log in with YOUR account, then try again. (Or switch to an API key in ⚙ Settings.)"));
      onDone(); return;
    }
    const mcpPath = path.join(__dirname, "mcp-ableton.js");
    const mcpConfig = JSON.stringify({
      mcpServers: { ableton: { command: process.execPath, args: [mcpPath], env: { BRIDGE_PORT: String(this.port) } } },
    });
    const args = [
      "-p", promptText,
      "--output-format", "json",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      // Ableton MCP tools PLUS the CLI's built-in web research (WebSearch/WebFetch) so the
      // agent can look up sound-design technique before programming a device.
      // (--strict-mcp-config only gates MCP servers, not built-in tools.)
      "--allowedTools", "mcp__ableton__* WebSearch WebFetch",
      "--permission-mode", "bypassPermissions",
      "--max-turns", String(this.effort === "quick" ? 16 : this.effort === "meticulous" ? 48 : 30), // effort scales the iteration budget
      "--append-system-prompt", systemPrompt,
      "--model", this.model,
    ];
    if (this.sessionId) args.push("--resume", this.sessionId);

    let child;
    // stdio: close stdin so claude doesn't wait on it; capture stdout/stderr.
    try { child = spawn(claudeBin, args, { env: this._cleanEnv(), cwd: process.env.HOME, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { onError(new Error("could not start claude CLI: " + e.message)); onDone(); return; }
    this._child = child; this._stopped = false;
    onStage("Claude is working… (tool actions will show as they happen)");

    // AWAIT the whole CLI lifecycle. Returning right after spawn (the old behaviour)
    // made the caller's finally fire instantly: 'busy' cleared, the status bar vanished,
    // and the panel looked dead while Claude was still running — and a second message
    // could start a SECOND overlapping run.
    await new Promise((resolveRun) => {
      let settled = false;
      const settle = () => { if (settled) return true; settled = true; resolveRun(); return false; };
      let out = "", err = "";
      // watchdog: if the CLI produces nothing for 10 minutes, kill it and report
      const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 600000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => { clearTimeout(watchdog); onError(new Error("claude CLI error: " + e.message + " (is it installed at " + claudeBin + "?)")); onDone(); settle(); });
      child.on("close", (code) => {
        clearTimeout(watchdog);
        if (settled) return;
        if (this._stopped) { onError(new Error("⏹ stopped")); onDone({}); settle(); return; }
        let res = null; try { res = JSON.parse(out); } catch {}
        if (res) {
          if (res.session_id) this.sessionId = res.session_id;
          if (res.is_error) {
            const msg = String(res.result || ("claude error " + (res.api_error_status || code)));
            let hint = "";
            if (/organization|subscription|disabled|API key|invalid_request|403/i.test(msg)) hint = "  →  Open ⚙ Settings in this panel, switch 'Sign in with' to API key, paste an sk-ant- key, Save.";
            else if (res.api_error_status === 401 || /not logged in|login|credential|oauth/i.test(msg)) hint = "  →  this machine isn't signed in: open Terminal, run `claude`, and log in with YOUR Claude account (Pro/Max). Then try again — or switch to API key in ⚙ Settings.";
            else if (/model|not found|unknown/i.test(msg)) hint = "  →  this model may not be available on your plan — pick another model in ⚙ Settings.";
            onError(new Error(msg + hint));
          } else {
            onText(String(res.result || ""));
          }
        } else {
          onError(new Error("no response from claude" + (err ? ": " + err.slice(0, 300) : " (exit " + code + ")")));
        }
        onDone(res || {});
        settle();
      });
    });
  }
}

module.exports = { CliAgent };
