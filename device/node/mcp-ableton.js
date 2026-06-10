#!/usr/bin/env node
// mcp-ableton.js — a stdio MCP server that exposes the Ableton tools to a spawned
// `claude` CLI. It does NOT touch Live directly (it runs as claude's child, outside
// Max). Each tool call is forwarded over a localhost TCP socket to the node.script
// process (cliAgent), which runs the real dispatch -> v8 -> Live. BRIDGE_PORT is
// injected via the MCP server env by cliAgent.
const net = require("net");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { TOOLS } = require("../../core/tools");
const { toZodShape } = require("../../core/jsonSchemaToZod");

const PORT = parseInt(process.env.BRIDGE_PORT, 10);
let seq = 0;

// One-shot request to the cliAgent tool bridge.
function callBridge(tool, input) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "";
    const done = (fn, v) => { try { sock.destroy(); } catch {} fn(v); };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, tool, input }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { return done(reject, e); }
      m.ok ? done(resolve, m.result) : done(reject, new Error(m.error || "tool error"));
    });
    sock.on("error", (e) => reject(e));
    setTimeout(() => done(reject, new Error("Ableton tool bridge timeout")), 15000);
  });
}

const server = new McpServer({ name: "ableton", version: "0.1.0" });
for (const t of TOOLS) {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: toZodShape(t.input_schema, z) },
    async (args) => {
      try {
        const result = await callBridge(t.name, args || {});
        return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true };
      }
    }
  );
}

(async () => {
  await server.connect(new StdioServerTransport());
})().catch((e) => { process.stderr.write("mcp-ableton fatal: " + (e && e.message) + "\n"); process.exit(1); });
