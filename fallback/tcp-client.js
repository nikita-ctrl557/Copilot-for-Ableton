// client.js — TCP bridge to the Ableton Remote Script (Claude_Copilot).
// Protocol: newline-delimited JSON.
//   request : {"id": <n>, "op": "<name>", "args": {...}}\n
//   response: {"id": <n>, "ok": true, "result": ...}\n  or  {"id","ok":false,"error":"..."}
// The Remote Script executes each op on Live's main thread and replies.

const net = require("net");
const { EventEmitter } = require("events");

class LiveClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 9000 } = {}) {
    super();
    this.host = host; this.port = port;
    this.sock = null; this.connected = false;
    this.buf = ""; this.nextId = 1; this.pending = new Map();
    this._retry = null;
  }

  connect() {
    if (this.sock) return;
    const sock = new net.Socket();
    this.sock = sock;
    sock.setEncoding("utf-8");
    sock.connect(this.port, this.host, () => {
      this.connected = true; this.emit("status", true);
    });
    sock.on("data", (chunk) => this._onData(chunk));
    sock.on("error", () => {}); // surfaced via 'close'
    sock.on("close", () => {
      this.connected = false; this.sock = null; this.emit("status", false);
      for (const [, p] of this.pending) p.reject(new Error("ableton disconnected"));
      this.pending.clear();
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    if (this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; this.connect(); }, 1500);
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) { if (msg.event) this.emit("event", msg); continue; }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "live error"));
    }
  }

  // Call a Remote Script op. Returns a Promise of its result.
  call(op, args = {}, { timeout = 8000 } = {}) {
    if (!this.connected) return Promise.reject(new Error("Ableton not connected (is Live open with the Claude Copilot control surface enabled?)"));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`live op '${op}' timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.write(payload);
    });
  }
}

module.exports = { LiveClient };
