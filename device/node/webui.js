// webui.js — a tiny HTTP + Server-Sent-Events server hosted inside node.script so
// the chat can also be opened in a real, resizable browser window (escaping
// Ableton's fixed-height device strip). Same chat.html is served; in the browser it
// detects there's no window.max and falls back to SSE (server->page) + fetch POST
// (page->server). No external deps — Node core http only.
//
// Also the hub for the ClaudeMeter fleet: meters POST /meter at ~12 Hz and the
// RESPONSE body carries queued recording commands back to that meter (start/stop a
// per-track wav capture). /upload receives audio files attached in the chat;
// /state feeds the expandable project-info panel.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const meterStore = require("../../core/meterStore");

// hooks: { chatHtmlPath, onChat(text), onConfig(obj), onVoice(action), onStop(),
//          getStatus(), getState() -> Promise<obj> }
function startWebUI(hooks) {
  const { chatHtmlPath, onChat, onConfig, onVoice, onStop, getStatus, getState } = hooks;
  const clients = new Set();
  const UPLOAD_DIR = path.join(os.homedir(), ".claude-copilot", "uploads");

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    // the in-Ableton jweb loads chat.html from file:// — CORS must allow it to fetch
    // /upload and /state on this server (and the browser pop-out is same-origin anyway)
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-filename");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      fs.readFile(chatHtmlPath, (e, buf) => {
        if (e) { res.writeHead(500); res.end("chat.html not found"); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(buf);
      });
      return;
    }

    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      try { if (getStatus) res.write("data: " + JSON.stringify(getStatus()) + "\n\n"); } catch {}
      return;
    }

    // ClaudeMeter devices POST their per-track metrics here at ~12 Hz. Keep it fast.
    // The response body is the meter's command channel: one queued command per POST
    // (recording open/start/stop) — no extra connection needed.
    if (req.method === "POST" && url === "/meter") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let cmd = null;
        try { const m = JSON.parse(body || "{}"); meterStore.set(m.track, m); cmd = meterStore.popCmd(m.track); } catch {}
        if (cmd) { const out = JSON.stringify(cmd); res.writeHead(200, { "content-type": "application/json" }); res.end(out); }
        else { res.writeHead(204); res.end(); }
      });
      return;
    }

    // audio files attached in the chat — raw bytes + x-filename header, saved under
    // ~/.claude-copilot/uploads/ so the analyze_audio_file tool can dissect them
    if (req.method === "POST" && url === "/upload") {
      const chunks = [];
      let size = 0;
      req.on("data", (d) => { size += d.length; if (size > 200 * 1024 * 1024) { try { req.destroy(); } catch {} } else chunks.push(d); });
      req.on("end", () => {
        try {
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          // the client URI-encodes the name (fetch header values must be ISO-8859-1 —
          // accented/CJK filenames would reject the whole request otherwise)
          let raw = String(req.headers["x-filename"] || "audio.wav");
          try { raw = decodeURIComponent(raw); } catch {}
          const safe = raw.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(-80) || "audio.wav";
          const file = path.join(UPLOAD_DIR, Date.now() + "-" + safe);
          fs.writeFileSync(file, Buffer.concat(chunks));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, path: file, bytes: size }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    // USER SKILLS — the settings panel's Skills section: list/read on GET,
    // save {name, content} or delete {name, delete:true} on POST
    if (url === "/skills") {
      const customSkills = require("../../core/customSkills");
      if (req.method === "GET") {
        const skills = customSkills.list().map((s) => ({ ...s, content: (customSkills.get(s.name) || {}).content || "" }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, skills }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          let msg = {}; try { msg = JSON.parse(body || "{}"); } catch {}
          const r = msg.delete ? customSkills.remove(msg.name) : customSkills.save(msg.name, msg.content);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
        });
        return;
      }
    }

    // project + per-track info for the expandable panel in the chat UI
    if (req.method === "GET" && url === "/state") {
      Promise.resolve(getState ? getState() : null).then((st) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(st || { ok: false }));
      }).catch((e) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      });
      return;
    }

    if (req.method === "POST" && (url === "/chat" || url === "/config" || url === "/voice" || url === "/stop")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let msg = {}; try { msg = JSON.parse(body || "{}"); } catch {}
        try {
          if (url === "/chat") onChat && onChat(String(msg.text || ""));
          else if (url === "/config") onConfig && onConfig(msg);
          else if (url === "/voice") onVoice && onVoice(String(msg.action || ""));
          else if (url === "/stop") onStop && onStop();
        } catch {}
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  // Fixed port so the in-Ableton floating window (and browser pop-out) can use a
  // stable URL. Falls back upward a few ports if it's taken.
  var basePort = (hooks && hooks.port) || 8723;
  var attempt = 0;
  server.on("error", (e) => { if (e && e.code === "EADDRINUSE" && attempt < 8) { attempt++; try { server.listen(basePort + attempt, "127.0.0.1"); } catch {} } });
  server.listen(basePort, "127.0.0.1", () => { if (hooks.onReady) try { hooks.onReady(server.address().port); } catch {} });

  return {
    broadcast(obj) {
      const line = "data: " + JSON.stringify(obj) + "\n\n";
      for (const c of clients) { try { c.write(line); } catch {} }
    },
    port() { const a = server.address(); return a && a.port; },
    server,
  };
}

module.exports = { startWebUI };
