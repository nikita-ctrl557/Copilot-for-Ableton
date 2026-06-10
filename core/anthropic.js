// anthropic.js — streaming Messages API client with ZERO dependencies.
// Uses Node's built-in https (works on any Node version Max bundles; no fetch/
// ReadableStream requirement). Reconstructs content blocks (text + tool_use) and
// stop_reason from the SSE stream, calling onText for live token streaming.

const https = require("https");

// params: { apiKey, model, system, tools, messages, max_tokens }
// hooks:  { onText(delta), onToolStart(block) }
// returns: { content: [...blocks], stop_reason, usage }
function streamMessage(params, hooks = {}) {
  const { apiKey, model, system, tools, messages, max_tokens = 4096 } = params;
  const { onText = () => {}, onToolStart = () => {}, handle } = hooks;
  const body = JSON.stringify({ model, max_tokens, system, tools, messages, stream: true });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        if (res.statusCode !== 200) {
          let err = "";
          res.on("data", (d) => (err += d));
          res.on("end", () => reject(new Error(`Anthropic API ${res.statusCode}: ${err.slice(0, 600)}`)));
          return;
        }
        const blocks = [];
        const jsonBuf = {}; // block index -> partial input json
        let stopReason = null, usage = null, buf = "";

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
            handle(ev);
          }
        });
        // drop empty text blocks — the API rejects empty text content on history replay
        res.on("end", () => {
          // a stream that ends without a stop_reason was TRUNCATED (network drop) —
          // surfacing it as success would poison the conversation history
          if (!stopReason) return reject(new Error("stream ended unexpectedly (no stop_reason) — try again"));
          resolve({ content: blocks.filter((b) => b && !(b.type === "text" && !(b.text && b.text.trim()))), stop_reason: stopReason, usage });
        });
        res.on("aborted", () => reject(new Error("stream aborted")));
        res.on("error", reject);

        function handle(ev) {
          switch (ev.type) {
            case "content_block_start": {
              const b = ev.content_block;
              if (b.type === "tool_use" || b.type === "server_tool_use") {
                // server_tool_use = the model invoking a server-side tool (e.g. web_search)
                blocks[ev.index] = { ...b, input: b.input || {} };
                jsonBuf[ev.index] = "";
                if (b.type === "tool_use") onToolStart(blocks[ev.index]);
              } else if (b.type === "text") {
                blocks[ev.index] = { type: "text", text: b.text || "" };
              } else {
                // web_search_tool_result / thinking / etc. — keep the full block verbatim
                // so it can be replayed in history without corruption.
                blocks[ev.index] = b;
              }
              break;
            }
            case "content_block_delta": {
              const d = ev.delta;
              const blk = blocks[ev.index];
              if (d.type === "text_delta" && blk && blk.type === "text") { blk.text += d.text; onText(d.text); }
              else if (d.type === "input_json_delta") { jsonBuf[ev.index] = (jsonBuf[ev.index] || "") + d.partial_json; }
              break;
            }
            case "content_block_stop": {
              const b = blocks[ev.index];
              if (b && (b.type === "tool_use" || b.type === "server_tool_use")) {
                try { b.input = jsonBuf[ev.index] ? JSON.parse(jsonBuf[ev.index]) : (b.input || {}); } catch { b.input = b.input || {}; }
              }
              break;
            }
            case "error": { // mid-stream API error event — fail loudly, never resolve as success
              const em = (ev.error && ev.error.message) || "stream error";
              try { req.destroy(new Error("Anthropic stream error: " + em)); } catch {}
              return reject(new Error("Anthropic stream error: " + em));
            }
            case "message_delta": {
              if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
              if (ev.usage) usage = ev.usage;
              break;
            }
          }
        }
      }
    );
    req.on("error", reject);
    // expose a cancel hook so a user Stop can kill the in-flight stream immediately
    if (handle) handle.cancel = () => { try { req.destroy(new Error("stopped by user")); } catch {} };
    // hard timeout: a stalled socket must NEVER brick the panel (busy stays true forever)
    req.setTimeout(180000, () => { try { req.destroy(new Error("Anthropic request timed out (180s)")); } catch {} });
    req.write(body);
    req.end();
  });
}

module.exports = { streamMessage };
