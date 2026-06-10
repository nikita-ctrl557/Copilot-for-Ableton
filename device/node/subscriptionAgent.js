// subscriptionAgent.js — drives Claude through the Claude Agent SDK, which
// authenticates with the user's Claude Code login (Pro/Max subscription) — NO API
// key. Our Ableton tools are registered as the SDK's in-process MCP tools, so each
// tool call runs right here and reaches Live via the maxBridge -> v8 executor.
//
// Requires: @anthropic-ai/claude-agent-sdk, zod  (installed in device/node).
// IMPORTANT: do not set ANTHROPIC_API_KEY — if present it overrides the
// subscription OAuth and silently bills the API instead.

const { query, tool, createSdkMcpServer } = require("@anthropic-ai/claude-agent-sdk");
const { z } = require("zod");
const { TOOLS, dispatch } = require("../../core/tools");
const { SYSTEM } = require("../../core/agent");
const { toZodShape } = require("../../core/jsonSchemaToZod");
const { live } = require("./maxBridge");

class SubscriptionAgent {
  constructor({ model, live: liveObj }) {
    this.model = model;
    this.live = liveObj || live;
    this.sessionId = null;
    this._cb = {};
    this.server = createSdkMcpServer({
      name: "ableton",
      version: "0.1.0",
      tools: TOOLS.map((t) => this._wrap(t)),
    });
  }

  setModel(m) { this.model = m; }
  reset() { this.sessionId = null; }

  // Wrap one catalog entry as an SDK tool whose handler calls our dispatch().
  _wrap(t) {
    const self = this;
    return tool(t.name, t.description, toZodShape(t.input_schema, z), async (args) => {
      const cb = self._cb;
      try { cb.onTool && cb.onTool({ name: t.name }); } catch {}
      try {
        const { result, label, detail } = await dispatch(t.name, args, { live: self.live });
        try { cb.onToolResult && cb.onToolResult({ name: t.name }, { label, detail, result }); } catch {}
        return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }] };
      } catch (e) {
        const msg = String((e && e.message) || e);
        try { cb.onToolResult && cb.onToolResult({ name: t.name }, { error: msg }); } catch {}
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    });
  }

  // Same callback contract as core/agent.js's Agent.run().
  async run(userText, cb = {}) {
    const { onText = () => {}, onError = () => {}, onDone = () => {} } = cb;
    this._cb = cb;
    const options = {
      mcpServers: { ableton: this.server },
      allowedTools: ["mcp__ableton__*"],
      permissionMode: "bypassPermissions",
      model: this.model,
      appendSystemPrompt: SYSTEM,
      includePartialMessages: true,
      tools: [], // remove built-in tools; Claude uses only our Ableton tools
    };
    if (this.sessionId) options.resume = this.sessionId;

    try {
      let streamedThisTurn = false;
      for await (const message of query({ prompt: userText, options })) {
        if (message.session_id) this.sessionId = message.session_id;
        if (message.type === "stream_event") {
          const ev = message.event;
          if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
            onText(ev.delta.text); streamedThisTurn = true;
          }
        } else if (message.type === "assistant") {
          // Fallback: if token streaming didn't fire, emit the full turn text.
          const content = (message.message && message.message.content) || [];
          if (!streamedThisTurn) for (const b of content) if (b.type === "text" && b.text) onText(b.text);
          streamedThisTurn = false;
        } else if (message.type === "result") {
          if (message.subtype && message.subtype !== "success") {
            onError(new Error(message.subtype === "error_max_turns" ? "stopped after too many steps" : (message.result || message.subtype)));
          }
          onDone(message);
          return;
        }
      }
      onDone();
    } catch (e) {
      // Auth not set up yet surfaces here — give a useful hint.
      const m = String((e && e.message) || e);
      if (/api key|unauthor|401|login|credit/i.test(m)) {
        onError(new Error("Subscription auth failed. Run `claude` once in a terminal to log in to your Pro/Max plan, then retry. (" + m + ")"));
      } else onError(e);
    }
  }
}

module.exports = { SubscriptionAgent };
