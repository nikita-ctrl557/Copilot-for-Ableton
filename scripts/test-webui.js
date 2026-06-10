// test-webui.js — verify the browser pop-out server: serves chat.html, accepts
// POST /chat, and streams broadcasts back over SSE. run: node scripts/test-webui.js
const http = require("http");
const path = require("path");
const { startWebUI } = require("../device/node/webui");

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("FAIL  " + n)));
const done = () => { console.log("\n" + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0); };

const web = startWebUI({
  chatHtmlPath: path.join(__dirname, "..", "device", "chat.html"),
  onChat: (t) => { web.broadcast({ type: "delta", text: "echo:" + t }); web.broadcast({ type: "done" }); },
  onConfig: () => {},
  getStatus: () => ({ type: "status", ready: true, authMode: "subscription", model: "claude-opus-4-8" }),
  onReady: (port) => runTests(port),
});

function runTests(port) {
  console.log("web port:", port);
  http.get("http://127.0.0.1:" + port + "/", (res) => {
  let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => {
    ok("GET / serves chat.html", res.statusCode === 200 && b.includes("Claude Copilot") && b.includes("EventSource"));

    // open SSE, then POST /chat, expect the echo to arrive over SSE
    let sse = "", gotStatus = false, gotEcho = false;
    const ev = http.get("http://127.0.0.1:" + port + "/events", (r2) => {
      r2.on("data", (d) => {
        sse += d;
        if (!gotStatus && sse.includes('"status"')) { gotStatus = true; ok("SSE sends initial status on connect", true); }
        if (!gotEcho && sse.includes("echo:hello")) { gotEcho = true; ok("SSE delivers broadcast after POST /chat", true); ev.destroy(); done(); }
      });
    });
    setTimeout(() => {
      const data = JSON.stringify({ text: "hello" });
      const req = http.request("http://127.0.0.1:" + port + "/chat",
        { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
        (r) => r.resume());
      req.write(data); req.end();
    }, 300);
  });
  });
}

setTimeout(() => { console.log("timeout"); done(); }, 5000);
