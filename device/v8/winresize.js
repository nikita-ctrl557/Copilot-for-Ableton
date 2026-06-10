// winresize.js — keeps the chat jweb glued to the floating window's size.
// Lives as a [js] inside the [p chat] floating window (PATCHING view — the window
// deliberately does NOT use presentation mode, because patching rects are the one
// thing every Max version resizes reliably). On loadbang it starts a 4 Hz poll of
// the window bounds; when the user resizes, it stretches the jweb to fill via BOTH
// supported paths: direct Maxobj.rect assignment AND thispatcher "script sendbox".
// The jweb box carries varname "chatweb" and sits last in the box order (on top),
// so it covers the helper objects parked at the top-left.
autowatch = 0;
inlets = 1;   // bang (from loadbang) starts the poll
outlets = 1;  // -> [thispatcher]

var poll = new Task(tick, this);
var lastW = -1, lastH = -1;

function bang() {
  lastW = -1; lastH = -1;
  poll.interval = 250;
  poll.repeat(); // forever — it only acts when the size actually changed
}

function tick() {
  try {
    var wnd = this.patcher.wind;
    if (!wnd) return;
    var s = wnd.size; // [width, height] of the window content area
    if (!s || s.length < 2) return;
    var w = Math.max(220, s[0]), h = Math.max(180, s[1]);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    // path 1: direct box-rect assignment (documented Maxobj API, patching view)
    try {
      var jb = this.patcher.getnamed("chatweb");
      if (jb) jb.rect = [0, 0, w, h];
    } catch (e) {}
    // path 2: thispatcher scripting — harmless duplicate, covers older builds
    outlet(0, "script", "sendbox", "chatweb", "patching_rect", 0, 0, w, h);
  } catch (e) { /* window not open yet — keep polling */ }
}
