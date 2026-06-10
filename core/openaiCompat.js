// openaiCompat.js — streaming client for OpenAI-compatible LOCAL servers (Ollama,
// LM Studio, llama.cpp, Jan, GPT4All…) with ZERO dependencies. Same interface as
// core/anthropic.js streamMessage, so the Agent loop is transport-agnostic: takes
// Anthropic-shaped {system, tools, messages}, translates to /chat/completions,
// streams SSE chunks back, and returns Anthropic-shaped content blocks
// ({type:'text'} / {type:'tool_use'}) + stop_reason. BETA: local runtimes vary in
// how well their models handle tool calling — surface errors loudly, never guess.

const http = require("http");
const https = require("https");

const PROVIDERS = {
  ollama:    { label: "Ollama",                 baseUrl: "http://127.0.0.1:11434/v1" },
  lmstudio:  { label: "LM Studio",              baseUrl: "http://127.0.0.1:1234/v1" },
  llamacpp:  { label: "llama.cpp (llama-server)", baseUrl: "http://127.0.0.1:8080/v1" },
  jan:       { label: "Jan",                    baseUrl: "http://127.0.0.1:1337/v1" },
  gpt4all:   { label: "GPT4All",                baseUrl: "http://127.0.0.1:4891/v1" },
};

// ---- Anthropic -> OpenAI translation --------------------------------------

function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => (b && b.text) || "").filter(Boolean).join("\n\n");
}

function toOpenAITools(tools) {
  // only CUSTOM tools translate; server-side Anthropic tools (web_search_…) don't
  // exist locally. cache_control is Anthropic-only — never forward it.
  return (tools || [])
    .filter((t) => t && t.name && t.input_schema && !(t.type && /web_search/.test(String(t.type))))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema } }));
}

function toOpenAIMessages(system, messages) {
  const out = [];
  const sys = systemText(system);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages || []) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b, i) => ({
        id: b.id || "call_" + i, type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user turn: tool_result blocks become role:"tool" messages; plain text stays user
      const texts = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: c });
        } else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}

// ---- streaming request -----------------------------------------------------

// params: { baseUrl, apiKey?, model, system, tools, messages, max_tokens }
// hooks:  { onText(delta), handle } — same contract as anthropic.streamMessage
// returns: { content: [...Anthropic-shaped blocks], stop_reason, usage }
function streamMessage(params, hooks = {}) {
  const { baseUrl, apiKey, model, system, tools, messages, max_tokens = 4096 } = params;
  const { onText = () => {}, handle } = hooks;
  let u;
  try { u = new URL(String(baseUrl || "").replace(/\/+$/, "") + "/chat/completions"); }
  catch (e) { return Promise.reject(new Error("bad local LLM base URL: " + baseUrl)); }
  const body = JSON.stringify({
    model, max_tokens, stream: true,
    messages: toOpenAIMessages(system, messages),
    tools: toOpenAITools(tools),
  });

  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname, method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        if (res.statusCode !== 200) {
          let err = "";
          res.on("data", (d) => (err += d));
          res.on("end", () => reject(new Error(`local LLM ${res.statusCode}: ${err.slice(0, 600) || "(no body)"} — is the server running at ${baseUrl} and the model '${model}' loaded?`)));
          return;
        }
        let text = "";
        const toolCalls = []; // index -> {id, name, args}
        let finish = null, usage = null, buf = "", gotChunk = false;

        res.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let ev;
            try { ev = JSON.parse(data); } catch { continue; }
            gotChunk = true;
            if (ev.usage) usage = ev.usage;
            const ch = (ev.choices && ev.choices[0]) || {};
            const d = ch.delta || {};
            if (typeof d.content === "string" && d.content) { text += d.content; onText(d.content); }
            for (const tc of d.tool_calls || []) {
              // index is the spec'd accumulator key, but some local servers omit it:
              // fall back to matching by id, then to the LAST open accumulator —
              // never to a fresh slot, which would shred one call into fragments
              let i = tc.index;
              if (i == null) {
                if (tc.id) { i = toolCalls.findIndex((c) => c && c.id === tc.id); if (i < 0) i = toolCalls.length; }
                else i = Math.max(0, toolCalls.length - 1);
              }
              if (!toolCalls[i]) toolCalls[i] = { id: tc.id || "call_" + i, name: "", args: "" };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function && tc.function.name) toolCalls[i].name += tc.function.name;
              if (tc.function && tc.function.arguments) toolCalls[i].args += tc.function.arguments;
            }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
        });
        res.on("end", () => {
          if (!gotChunk) return reject(new Error("local LLM returned an empty stream — check the model supports streaming chat completions"));
          // a stream that ends WITHOUT a finish_reason was truncated (connection
          // drop) — resolving it as success would poison the history (same contract
          // as anthropic.js)
          if (!finish) return reject(new Error("local LLM stream ended unexpectedly (no finish_reason) — try again"));
          const content = [];
          if (text.trim()) content.push({ type: "text", text });
          for (const tc of toolCalls.filter(Boolean)) {
            let input = {};
            try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = {}; }
            content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          }
          // length wins over tool_use: a cut-off response may carry a HALF-emitted
          // tool call — report max_tokens so the agent's poisoning guard strips it
          // instead of executing a truncated call with empty input
          const stop_reason =
            finish === "length" ? "max_tokens"
            : toolCalls.filter(Boolean).length ? "tool_use"
            : "end_turn";
          resolve({ content, stop_reason, usage });
        });
        res.on("aborted", () => reject(new Error("local LLM stream aborted")));
        res.on("error", reject);
      }
    );
    req.on("error", (e) => reject(new Error("can't reach local LLM at " + baseUrl + " — " + (e.message || e) + ". Is the server running?")));
    if (handle) handle.cancel = () => { try { req.destroy(new Error("stopped by user")); } catch {} };
    // local models can be slow to first token, but a stalled socket must never brick the panel
    req.setTimeout(300000, () => { try { req.destroy(new Error("local LLM request timed out (300s)")); } catch {} });
    req.write(body);
    req.end();
  });
}

module.exports = { streamMessage, PROVIDERS, toOpenAIMessages, toOpenAITools };
