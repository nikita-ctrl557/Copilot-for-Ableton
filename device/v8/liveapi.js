// liveapi.js — the [v8] LiveAPI executor. Runs on Live's main thread, gated by a
// [live.thisdevice] bang so no LiveAPI is created in global/high-priority context.
// Inbound : [liveapi_call <reqId> <kind> <jsonString>]   (json travels as one symbol)
// Outbound: [liveapi_reply <reqId> <1|0> <jsonString>]
//
// All Live Object Model calls here use the signatures verified during research:
//   clip.call('add_new_notes', {notes:[{pitch,start_time,duration,velocity,mute}]})
//   clip.call('remove_notes_extended', fromPitch, pitchSpan, fromTime, timeSpan)
//   mixer_device volume/panning/sends -> normalized DeviceParameter 'value' (0..1)
//   browser.call('load_item', itemId) loads onto the SELECTED track

autowatch = 0;
inlets = 1;
outlets = 1;

// Canonical two-arg form: new LiveAPI(callback, path). The no-op callback is never
// invoked for our one-shot get/set/call usage (no property is observed).
function api(path) { return new LiveAPI(function () {}, path); }
function byId(id) { return new LiveAPI(function () {}, "id " + id); }
function g(a, prop) { var v = a.get(prop); return (v instanceof Array && v.length === 1) ? v[0] : v; }
function num(x) { return (x instanceof Array) ? x[0] : x; }

function bang() { /* live.thisdevice ready — nothing to pre-build; objects are made lazily */ }

// ---- audio pitch tracking (for key detection from a vocal) ----------------
// Fed by sigmund~ on the device's audio input: "pitch <midi>" and "env <db>"
// messages arrive here and accumulate a 12-bin pitch-class histogram.
var pitchHist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
var pitchTotal = 0;
function pitch(v) { if (v >= 24 && v <= 108) { pitchHist[Math.round(v) % 12]++; pitchTotal++; } }
function env(v) { /* loudness available if finer gating is ever needed */ }

function liveapi_call(reqId, kind, jsonString) {
  var p = {};
  try { p = JSON.parse(jsonString); } catch (e) {}
  try { reply(reqId, 1, dispatch(String(kind), p)); }
  catch (e) { reply(reqId, 0, { message: String((e && e.message) || e) }); }
}

// Fallback: if the patch's [route liveapi_call] stripped the selector, the call
// arrives as  <reqId> <kind> <json>  and lands here (messagename = reqId). This
// makes the device work with BOTH the old and the fixed patch wiring.
function anything() {
  // Only handle a route-stripped liveapi_call (its selector is a req_ id). Ignore
  // any other stray message so nothing can flood the dispatcher / crash the device.
  if (String(messagename).indexOf("req_") !== 0) return;
  var a = arrayfromargs(arguments);
  liveapi_call(messagename, a[0], a[1]);
}
function reply(reqId, ok, obj) { outlet(0, "liveapi_reply", reqId, ok, JSON.stringify(obj)); }

// ---- helpers -------------------------------------------------------------

function trackCount() { return api("live_set").getcount("tracks"); }

function selectedTrackIndex() {
  var sel = api("live_set view").get("selected_track"); // ['id', n]
  var selId = (sel instanceof Array) ? sel[1] : sel;
  var n = trackCount();
  for (var i = 0; i < n; i++) { if (api("live_set tracks " + i).id == selId) return i; }
  return 0;
}

function trackType(t) {
  if (g(t, "has_midi_input") == 1) return "midi";
  return "audio";
}

function describeTrack(i) {
  var base = "live_set tracks " + i;
  var t = api(base);
  var mx = api(base + " mixer_device");
  return {
    index: i,
    name: String(g(t, "name")),
    type: trackType(t),
    volume: num(api(base + " mixer_device volume").get("value")),
    pan: num(api(base + " mixer_device panning").get("value")),
    isMuted: g(t, "mute") == 1,
    isSoloed: g(t, "solo") == 1,
    deviceCount: t.getcount("devices"),
  };
}

function listParams(track, device) {
  var d = "live_set tracks " + track + " devices " + device;
  var n = api(d).getcount("parameters");
  var out = [];
  for (var k = 0; k < n; k++) {
    var pr = api(d + " parameters " + k);
    out.push({ index: k, name: String(g(pr, "name")), value: num(pr.get("value")), min: num(pr.get("min")), max: num(pr.get("max")), isQuantized: g(pr, "is_quantized") == 1 });
  }
  return out;
}

// Resolve an object-reference property to a LiveAPI, tolerating every shape v8 may
// return: ["id", N] | [N] | N | "id N". Returns null if unresolved/invalid.
function getChild(obj, prop) {
  var v;
  try { v = obj.get(prop); } catch (e) { return null; }
  var id = null;
  if (v && typeof v.length === "number" && typeof v !== "string") {
    if (v.length >= 2 && (v[0] === "id" || v[0] === "id ")) id = v[1];
    else if (v.length >= 1) id = typeof v[0] === "number" ? v[0] : v[v.length - 1];
  } else if (typeof v === "number") id = v;
  else if (typeof v === "string") { var m = v.match(/\d+/); if (m) id = parseInt(m[0], 10); }
  if (id == null || id === 0) return null;
  var c = byId(id);
  return c && c.id != 0 ? c : null;
}

// flatten children: ["id",a,"id",b,...] OR a plain numeric id list -> [LiveAPI...]
function childItems(item) {
  var raw;
  try { raw = item.get("children"); } catch (e) { return []; }
  var out = [];
  if (!raw || typeof raw.length !== "number") return out;
  var sawId = false;
  for (var i = 0; i + 1 < raw.length; i += 2) { if (raw[i] === "id") { sawId = true; out.push(byId(raw[i + 1])); } }
  if (!sawId) for (var j = 0; j < raw.length; j++) { if (typeof raw[j] === "number" && raw[j] !== 0) out.push(byId(raw[j])); }
  return out;
}

// Obtain a bound Browser object. "live_app browser" (path) can return id 0; the
// browser is also reachable as a PROPERTY of the application: live_app .get('browser').
function getBrowser() {
  // Try every constructor form — the two-arg callback form may not resolve the
  // app/browser path even though single-arg / null-callback does (Live 11.1+).
  var forms = [
    function () { return new LiveAPI("live_app browser"); },
    function () { return new LiveAPI(null, "live_app browser"); },
    function () { return new LiveAPI(function () {}, "live_app browser"); },
    function () { return getChild(new LiveAPI("live_app"), "browser"); },
    function () { return getChild(api("live_app"), "browser"); },
  ];
  for (var i = 0; i < forms.length; i++) { try { var b = forms[i](); if (b && b.id != 0) return b; } catch (e) {} }
  return api("live_app browser");
}

// Browser category root. On Live 12 neither browser.get(category) nor the path
// "live_app browser instruments" reliably yields a navigable item, so try three
// ways: (A) enumerate the browser's OWN children and match by name, (B) path,
// (C) get(). Returns the first item that actually has children.
function browseRoot(category) {
  var browser = getBrowser();
  var want = category.replace(/_/g, " ").toLowerCase();
  // (A) the browser's children should be the category folders
  var kids = browseChildren(browser);
  for (var i = 0; i < kids.length; i++) {
    try { var nm = String(kids[i].get("name")).toLowerCase(); if (nm && (nm.indexOf(want) >= 0 || want.indexOf(nm) >= 0)) return kids[i]; } catch (e) {}
  }
  // (B) path
  var r = api("live_app browser " + category);
  if (r && r.id != 0) { try { if (r.getcount("children") > 0) return r; } catch (e) {} }
  // (C) get()
  var c = getChild(browser, category);
  if (c) { try { if (c.getcount("children") > 0) return c; } catch (e) {} }
  return r && r.id != 0 ? r : c;
}

// Children of a browser item via getcount + PATH indexing (get("children")
// returns a bogus number in v8). Falls back to the get()-list form.
function browseChildren(item) {
  var n = 0;
  try { n = item.getcount("children"); } catch (e) { n = 0; }
  if (n > 0) {
    var out = [], base = item.unquotedpath;
    for (var i = 0; i < n; i++) { try { var c = api(base + " children " + i); if (c && c.id != 0) out.push(c); } catch (e) {} }
    if (out.length) return out;
  }
  return childItems(item);
}

function scoreName(name, wantTokens) {
  var low = String(name).toLowerCase();
  var s = 0;
  for (var i = 0; i < wantTokens.length; i++) { if (low.indexOf(wantTokens[i]) >= 0) s += 1; }
  if (low === wantTokens.join(" ")) s += 3;
  return s;
}

// Count notes actually in a clip (Live 11/12 get_notes_extended -> JSON string).
// Returns the count, or -1 if it could not be read.
function countNotes(clip) {
  try {
    // arg order: (from_pitch, pitch_span, from_time, time_span). Returns a JSON STRING in v8/js.
    var r = clip.call("get_notes_extended", 0, 128, 0, 1000000);
    var s = (typeof r === "string") ? r : (r && r.join ? r.join("") : "");
    if (s) { var o = JSON.parse(s); if (o && o.notes) return o.notes.length; }
  } catch (e) {}
  return -1;
}

// Write notes to a clip and VERIFY by reading back. Tries the classic scalar-arg
// method first (no v8 dict-serialization pitfall), then add_new_notes. Throws if
// readback proves nothing was written — so the caller never reports a false success.
// notes: [{pitch, start, duration, velocity, mute}]
function writeNotesToClip(clip, notes) {
  // PRIMARY: add_new_notes with a PLAIN JS OBJECT (verified to work in v8). Field
  // names MUST be start_time and mute — wrong names are silently ignored. Do NOT
  // JSON.stringify or build a Dict.
  var modernErr = null;
  try {
    var dn = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      dn.push({ pitch: n.pitch, start_time: n.start, duration: n.duration, velocity: (n.velocity == null ? 100 : n.velocity), mute: (n.mute ? 1 : 0) });
    }
    clip.call("add_new_notes", { notes: dn });
  } catch (e) { modernErr = e; }
  var c1 = countNotes(clip);
  if (c1 > 0) return { wrote: c1, method: "add_new_notes", verified: true };

  // FALLBACK: classic set_notes / notes N / note(...)xN / done (scalar args).
  var classicErr = null;
  try {
    clip.call("set_notes");
    clip.call("notes", notes.length);
    for (var j = 0; j < notes.length; j++) {
      var m = notes[j];
      clip.call("note", m.pitch, m.start, m.duration, (m.velocity == null ? 100 : m.velocity), (m.mute ? 1 : 0));
    }
    clip.call("done");
  } catch (e) { classicErr = e; }
  var c2 = countNotes(clip);
  if (c2 > 0) return { wrote: c2, method: "set_notes", verified: true };
  if (c2 < 0 && (!modernErr || !classicErr)) return { wrote: notes.length, method: "unverified", verified: false };

  throw new Error("notes did NOT write — add_new_notes(" + (modernErr ? modernErr.message : "ok") + "), set_notes(" + (classicErr ? classicErr.message : "ok") + "), readback=" + c2);
}

// ---- dispatch ------------------------------------------------------------

function dispatch(kind, p) {
  if (kind === "session_info") {
    var ls = api("live_set");
    return {
      tempo: num(ls.get("tempo")),
      timeSignature: [num(ls.get("signature_numerator")), num(ls.get("signature_denominator"))],
      isPlaying: g(ls, "is_playing") == 1,
      trackCount: ls.getcount("tracks"),
      sceneCount: ls.getcount("scenes"),
      selectedTrack: selectedTrackIndex(),
    };
  }

  if (kind === "list_tracks") {
    var n = trackCount(), tracks = [];
    for (var i = 0; i < n; i++) tracks.push(describeTrack(i));
    return { tracks: tracks };
  }

  if (kind === "get_track") {
    var base = "live_set tracks " + p.track, t = api(base);
    var nd = t.getcount("devices"), devices = [];
    for (var k = 0; k < nd; k++) { var d = api(base + " devices " + k); devices.push({ index: k, name: String(g(d, "name")), className: String(g(d, "class_name")) }); }
    var ns = t.getcount("clip_slots"), slots = [];
    for (var j = 0; j < ns; j++) {
      var s = api(base + " clip_slots " + j), has = g(s, "has_clip") == 1, cn = null;
      if (has) cn = String(g(api(base + " clip_slots " + j + " clip"), "name"));
      slots.push({ index: j, hasClip: has, clipName: cn });
    }
    return { index: p.track, name: String(g(t, "name")), type: trackType(t), devices: devices, clipSlots: slots };
  }

  if (kind === "list_devices") {
    var tb = "live_set tracks " + p.track, tt = api(tb), m = tt.getcount("devices"), ds = [];
    for (var q = 0; q < m; q++) { var dd = api(tb + " devices " + q); ds.push({ index: q, name: String(g(dd, "name")), className: String(g(dd, "class_name")) }); }
    return { devices: ds };
  }

  if (kind === "list_params") return { params: listParams(p.track, p.device) };

  if (kind === "set_param") {
    var dbase = "live_set tracks " + p.track + " devices " + p.device;
    var pidx = p.param;
    if (typeof p.param === "string") {
      var cnt = api(dbase).getcount("parameters"), found = -1;
      for (var z = 0; z < cnt; z++) { if (String(g(api(dbase + " parameters " + z), "name")) === p.param) { found = z; break; } }
      if (found < 0) throw new Error("no parameter named '" + p.param + "'");
      pidx = found;
    }
    var par = api(dbase + " parameters " + pidx);
    var lo = num(par.get("min")), hi = num(par.get("max")), v = Math.max(lo, Math.min(hi, p.value));
    if (g(par, "is_quantized") == 1) v = Math.round(v);
    var before = num(par.get("value"));
    par.set("value", v);
    var after = num(par.get("value"));
    return { name: String(g(par, "name")), before: before, after: after, value: after, min: lo, max: hi, changed: before !== after };
  }

  if (kind === "set_mixer") {
    var b = "live_set tracks " + p.track + " mixer_device", t2 = api("live_set tracks " + p.track), warn = [];
    function trySet(fn) { try { fn(); } catch (e) { warn.push(String(e.message || e)); } }
    if (p.volume !== undefined) trySet(function () { api(b + " volume").set("value", p.volume); });
    if (p.pan !== undefined) trySet(function () { api(b + " panning").set("value", p.pan); });
    if (p.sends) for (var si = 0; si < p.sends.length; si++) (function (s) { trySet(function () { api(b + " sends " + s.returnIndex).set("value", s.amount); }); })(p.sends[si]);
    if (p.mute !== undefined) trySet(function () { t2.set("mute", p.mute ? 1 : 0); });
    if (p.solo !== undefined) trySet(function () { t2.set("solo", p.solo ? 1 : 0); });
    if (p.arm !== undefined) trySet(function () { t2.set("arm", p.arm ? 1 : 0); });
    return { ok: true, warnings: warn };
  }

  if (kind === "add_notes") {
    var sp = "live_set tracks " + p.track + " clip_slots " + p.slot;
    var slot = api(sp);
    if (!slot || slot.id == 0) throw new Error("clip slot " + p.track + "/" + p.slot + " not found");
    var tk = api("live_set tracks " + p.track);
    if (g(tk, "has_midi_input") != 1) throw new Error("track " + p.track + " is not a MIDI track — can't write a MIDI clip there");
    var lenBeats = p.lengthBeats || 4;
    var hasClip = (g(slot, "has_clip") == 1);
    // On overwrite, start from a FRESH clip of the right length. Reusing an existing
    // shorter clip leaves new notes past its loop end = off-screen (the regression).
    if (hasClip && p.overwrite) { try { slot.call("delete_clip"); } catch (e) {} hasClip = false; }
    if (!hasClip) slot.call("create_clip", lenBeats);
    var clip = api(sp + " clip"); // explicit path (don't rely on unquotedpath)
    if (!clip || clip.id == 0) throw new Error("clip slot " + p.track + "/" + p.slot + " has no clip after create_clip");
    // ensure the loop is long enough to DISPLAY every note
    try { if (num(clip.get("length")) < lenBeats) { clip.set("loop_end", lenBeats); clip.set("end_marker", lenBeats); } } catch (e) {}
    if (p.overwrite) { try { clip.call("remove_notes_extended", 0, 128, 0, 1000000); } catch (e) {} }
    var notes = [];
    for (var ni = 0; ni < p.notes.length; ni++) {
      var nn = p.notes[ni];
      notes.push({ pitch: nn.pitch, start: nn.start, duration: nn.duration, velocity: (nn.velocity == null ? 100 : nn.velocity), mute: (nn.mute ? 1 : 0) });
    }
    var w = writeNotesToClip(clip, notes); // writes + verifies by readback, throws if nothing landed
    if (p.name) try { clip.set("name", p.name); } catch (e) {}
    return { requested: notes.length, wrote: w.wrote, method: w.method, verified: w.verified, lengthBeats: lenBeats };
  }

  if (kind === "clear_notes") {
    var cs = api("live_set tracks " + p.track + " clip_slots " + p.slot);
    if (g(cs, "has_clip") == 1) api(cs.unquotedpath + " clip").call("remove_notes_extended", 0, 128, 0, 1000000);
    return { ok: true };
  }

  if (kind === "fire_clip") { api("live_set tracks " + p.track + " clip_slots " + p.slot).call("fire"); return { fired: true }; }

  if (kind === "create_track") {
    var ls2 = api("live_set");
    ls2.call(p.type === "audio" ? "create_audio_track" : "create_midi_track", (p.index == null ? -1 : p.index));
    var idx = ls2.getcount("tracks") - 1;
    if (p.name) try { api("live_set tracks " + idx).set("name", p.name); } catch (e) {}
    return { index: idx, name: String(g(api("live_set tracks " + idx), "name")), type: p.type };
  }

  if (kind === "set_transport") {
    var ls3 = api("live_set");
    if (p.tempo) ls3.set("tempo", p.tempo);
    if (p.play) ls3.call("start_playing");
    if (p.resume) ls3.call("continue_playing"); // resume from the stop point, not bar 1
    if (p.stop) ls3.call("stop_playing");
    return { isPlaying: g(ls3, "is_playing") == 1, tempo: num(ls3.get("tempo")) };
  }

  if (kind === "find_and_load") {
    var trackId = api("live_set tracks " + p.track).id;
    api("live_set view").set("selected_track", "id " + trackId); // load_item targets selected track
    var browser = getBrowser();

    // Search these categories in order. 'plugins' is where VST/AU (Serum, etc.) live;
    // 'max_for_live' holds .amxd instruments/effects.
    var cats = (p.kind === "audioEffect")
      ? ["audio_effects", "plugins", "max_for_live"]
      : ["instruments", "plugins", "drums", "sounds", "max_for_live"];

    var want = String(p.description || "").toLowerCase().split(/\s+/).filter(Boolean);
    var best = null, bestScore = 0, alts = [], visited = 0, rootsFound = 0, tried = [], diag = [];

    for (var ci = 0; ci < cats.length; ci++) {
      var rootItem = browseRoot(cats[ci]);
      tried.push(cats[ci] + (rootItem ? "" : "(x)"));
      if (!rootItem) continue;
      rootsFound++;
      var rk = browseChildren(rootItem);
      var d = cats[ci] + ":" + rk.length;
      if (rk.length === 0) { try { d += "(name=" + String(rootItem.get("name")) + " cnt=" + rootItem.getcount("children") + ")"; } catch (e) { d += "(err " + (e && e.message) + ")"; } }
      diag.push(d);

      var stack = [[rootItem, 0]];
      while (stack.length && visited < 6000) {
        var top = stack.pop(), it = top[0], depth = top[1];
        visited++;
        var name = "", loadable = 0;
        try { name = String(it.get("name")); loadable = (it.get("is_loadable") == 1) ? 1 : 0; } catch (e) { continue; }
        if (loadable) {
          var sc = scoreName(name, want);
          if (sc > bestScore) { bestScore = sc; best = it; }
          if (sc > 0 && alts.length < 8) alts.push(name);
        }
        if (depth < 8) { var kids = browseChildren(it); for (var k = 0; k < kids.length; k++) stack.push([kids[k], depth + 1]); }
      }
      if (best && bestScore >= want.length) break; // every word matched — stop early
    }
    // Dump the APPLICATION's real structure so a pasted failure shows exactly how to
    // reach the browser (its children + functions, what .get('browser') returns).
    var binfo = " ||";
    try {
      var ap = api("live_app"), apl = String(ap.info).split("\n"), apc = [], apf = [];
      for (var ax = 0; ax < apl.length; ax++) { var at = apl[ax].replace(/^\s+/, "").split(" "); if (at[0] === "children") apc.push(at[1]); else if (at[0] === "function") apf.push(at[1]); }
      var gb = ""; try { gb = String(JSON.stringify(ap.get("browser"))).slice(0, 40); } catch (e) { gb = "err"; }
      binfo += " live_app.id=" + ap.id + " children=[" + apc.join(",") + "] funcs=[" + apf.slice(0, 25).join(",") + "] app.get(browser)=" + gb;
    } catch (e) { binfo += " app-err:" + (e && e.message); }
    try { binfo += " | live_set.id=" + api("live_set").id + " getBrowser.id=" + getBrowser().id; } catch (e) {}
    throw new Error("MANUAL_LOAD: can't reach Live's browser to auto-load '" + p.description + "'. Drag it onto track " + p.track + " and I'll program it. [" + diag.join(" | ") + binfo + "]");
    var chosen = String(best.get("name"));
    var devBefore = api("live_set tracks " + p.track).getcount("devices");
    // load_item arg form: prefer the 3-repo-verified string "id N", fall back to raw id.
    try { browser.call("load_item", "id " + best.id); } catch (e) { try { browser.call("load_item", best.id); } catch (e2) {} }
    var devAfter = api("live_set tracks " + p.track).getcount("devices");
    if (devAfter <= devBefore) { try { browser.call("load_item", best.id); } catch (e) {} devAfter = api("live_set tracks " + p.track).getcount("devices"); }
    if (devAfter <= devBefore) throw new Error("matched '" + chosen + "' but it did not load onto track " + p.track + " (devices " + devBefore + "->" + devAfter + ")");
    return { loaded: { name: chosen }, deviceCount: devAfter, alternatives: alts, searched: visited };
  }

  if (kind === "list_browser") {
    // Enumerate loadable items in a browser category so Claude knows what's
    // installed (Live devices, the user's VST/AU plugins, M4L, packs).
    var category = p.category || "instruments";
    var root = browseRoot(category);
    if (!root || root.id == 0) throw new Error("browser category '" + category + "' not found (valid: instruments, audio_effects, midi_effects, plugins, drums, sounds, max_for_live, packs, user_library, samples)");
    var items = [], lvisited = 0, maxItems = p.limit || 300, maxDepth = (p.depth == null ? 3 : p.depth);
    var lstack = [[root, 0]];
    while (lstack.length && lvisited < 8000 && items.length < maxItems) {
      var lt = lstack.pop(), lit = lt[0], ld = lt[1];
      lvisited++;
      var lnm = "", lload = 0;
      try { lnm = String(lit.get("name")); lload = (lit.get("is_loadable") == 1) ? 1 : 0; } catch (e) { continue; }
      if (lload && lnm) items.push(lnm);
      if (ld < maxDepth) { var lk = browseChildren(lit); for (var lki = 0; lki < lk.length; lki++) lstack.push([lk[lki], ld + 1]); }
    }
    return { category: category, count: items.length, items: items, truncated: items.length >= maxItems };
  }

  // ---- extended mutations (verified LOM calls) ----------------------------
  if (kind === "device_onoff") { // 'Device On' is parameters[0].value (0/1)
    api("live_set tracks " + p.track + " devices " + p.device + " parameters 0").set("value", p.on ? 1 : 0);
    return { ok: true, on: !!p.on };
  }
  if (kind === "delete_device") { api("live_set tracks " + p.track).call("delete_device", p.device); return { ok: true }; }
  if (kind === "delete_track") { api("live_set").call("delete_track", p.track); return { ok: true }; }
  if (kind === "duplicate_track") { api("live_set").call("duplicate_track", p.track); return { ok: true, newIndex: p.track + 1 }; }
  if (kind === "create_return_track") { api("live_set").call("create_return_track"); return { ok: true }; }
  if (kind === "duplicate_clip") { api("live_set tracks " + p.track).call("duplicate_clip_slot", p.slot); return { ok: true }; }
  if (kind === "rename_track") { api("live_set tracks " + p.track).set("name", String(p.name)); return { name: String(p.name) }; }
  if (kind === "rename_clip") { api("live_set tracks " + p.track + " clip_slots " + p.slot + " clip").set("name", String(p.name)); return { name: String(p.name) }; }
  if (kind === "set_track_color") { api("live_set tracks " + p.track).set("color", p.color); return { ok: true }; }
  if (kind === "create_scene") { api("live_set").call("create_scene", (p.index == null ? -1 : p.index)); return { ok: true, sceneCount: api("live_set").getcount("scenes") }; }
  if (kind === "duplicate_scene") { api("live_set").call("duplicate_scene", p.scene); return { ok: true }; }
  if (kind === "fire_scene") { api("live_set scenes " + p.scene).call("fire"); return { fired: true }; }
  if (kind === "capture_midi") { var sc = api("live_set"); if (sc.get("can_capture_midi") == 1) { sc.call("capture_midi", p.destination == null ? 1 : p.destination); return { captured: true }; } return { captured: false, reason: "nothing to capture" }; }
  if (kind === "undo") { var su = api("live_set"); if (su.get("can_undo") == 1) { su.call("undo"); return { undone: true }; } return { undone: false }; }
  if (kind === "redo") { var sr = api("live_set"); if (sr.get("can_redo") == 1) { sr.call("redo"); return { redone: true }; } return { redone: false }; }
  if (kind === "quantize_clip") { api("live_set tracks " + p.track + " clip_slots " + p.slot + " clip").call("quantize", (p.grid == null ? 5 : p.grid), (p.amount == null ? 1.0 : p.amount)); return { ok: true }; }
  if (kind === "set_clip") {
    var cl = api("live_set tracks " + p.track + " clip_slots " + p.slot + " clip");
    if (!cl || cl.id == 0) throw new Error("no clip at " + p.track + "/" + p.slot);
    if (p.looping !== undefined) cl.set("looping", p.looping ? 1 : 0);
    if (p.loop_start !== undefined) cl.set("loop_start", p.loop_start);
    if (p.loop_end !== undefined) cl.set("loop_end", p.loop_end);
    if (p.name !== undefined) cl.set("name", String(p.name));
    return { ok: true };
  }
  if (kind === "set_master") { // master_track / return tracks mixer
    var base = (p.target === "master") ? "live_set master_track mixer_device"
      : (typeof p.target === "number") ? "live_set return_tracks " + p.target + " mixer_device"
      : "live_set master_track mixer_device";
    if (p.volume !== undefined) api(base + " volume").set("value", p.volume);
    if (p.pan !== undefined) try { api(base + " panning").set("value", p.pan); } catch (e) {}
    return { ok: true };
  }

  if (kind === "arrange_clip") {
    // Place a SESSION clip onto the Arrangement timeline at one or more beat times.
    var asp = "live_set tracks " + p.track + " clip_slots " + p.slot;
    if (g(api(asp), "has_clip") == 0) throw new Error("no session clip at track " + p.track + " slot " + p.slot + " to arrange — write it first");
    var aclipId = api(asp + " clip").id;
    var atrack = api("live_set tracks " + p.track);
    var times = (p.times && p.times.length) ? p.times : [p.time == null ? 0 : p.time];
    var placed = [];
    for (var ti = 0; ti < times.length; ti++) {
      try { atrack.call("duplicate_clip_to_arrangement", "id " + aclipId, times[ti]); }
      catch (e) { atrack.call("duplicate_clip_to_arrangement", aclipId, times[ti]); }
      placed.push(times[ti]);
    }
    return { placed: placed, count: placed.length, hint: "switch to Arrangement view (Tab) to see them" };
  }

  if (kind === "debug_browser") {
    // Use LiveAPI .info (the authoritative structure dump) to see exactly what the
    // browser object exposes, so browser loading can be fixed precisely.
    function probe(path) {
      var o = { path: path };
      try {
        var a = api(path); o.id = a.id;
        var lines = String(a.info).split("\n"), children = [], props = [], funcs = [];
        for (var i = 0; i < lines.length; i++) {
          var t = lines[i].replace(/^\s+/, "").split(" ");
          if (t[0] === "children") children.push(t[1]);
          else if (t[0] === "property") props.push(t[1]);
          else if (t[0] === "function") funcs.push(t[1]);
        }
        o.children = children; o.properties = props.slice(0, 50); o.functions = funcs.slice(0, 50);
      } catch (e) { o.error = String((e && e.message) || e); }
      return o;
    }
    var getInst = "";
    try { getInst = JSON.stringify(api("live_app browser").get("instruments")); } catch (e) { getInst = "err:" + e.message; }
    return { live_app: probe("live_app"), browser: probe("live_app browser"), browser_view: probe("live_set view"), get_instruments: getInst };
  }

  if (kind === "dump_device") {
    // Full picture of a device: its PROPERTIES (set via set_device_property),
    // FUNCTIONS, and automatable PARAMETERS (set via set_device_param). For synths
    // like Wavetable the sound-shaping controls (oscillator wavetable, effect mode,
    // filter routing) are PROPERTIES, not parameters — so dump both.
    var ddp = "live_set tracks " + p.track + " devices " + p.device;
    var ddev = api(ddp);
    if (!ddev || ddev.id == 0) throw new Error("no device at track " + p.track + " device " + p.device);
    var lines = String(ddev.info).split("\n"), props = [], funcs = [];
    for (var di = 0; di < lines.length; di++) { var dt = lines[di].replace(/^\s+/, "").split(" "); if (dt[0] === "property") props.push(dt[1]); else if (dt[0] === "function") funcs.push(dt[1]); }
    var dn = ddev.getcount("parameters"), params = [];
    for (var dk = 0; dk < dn; dk++) { var dpr = api(ddp + " parameters " + dk); params.push({ index: dk, name: String(g(dpr, "name")), value: num(dpr.get("value")), min: num(dpr.get("min")), max: num(dpr.get("max")) }); }
    return { className: String(g(ddev, "class_name")), name: String(g(ddev, "name")), properties: props, functions: funcs, parameters: params };
  }
  if (kind === "set_device_property") {
    var spd = "live_set tracks " + p.track + " devices " + p.device;
    var sdev = api(spd);
    if (!sdev || sdev.id == 0) throw new Error("no device at track " + p.track + " device " + p.device);
    var pre = sdev.get(p.property);
    try { sdev.set(p.property, p.value); } catch (e) { throw new Error("couldn't set '" + p.property + "': " + (e && e.message)); }
    var post = sdev.get(p.property);
    return { property: p.property, before: num(pre), after: num(post), changed: String(pre) !== String(post) };
  }
  if (kind === "get_device_property") {
    var gpd = "live_set tracks " + p.track + " devices " + p.device;
    return { property: p.property, value: num(api(gpd).get(p.property)) };
  }

  if (kind === "get_pitch_histogram") return { hist: pitchHist.slice(0), total: pitchTotal };
  if (kind === "reset_pitch_histogram") { for (var phi = 0; phi < 12; phi++) pitchHist[phi] = 0; pitchTotal = 0; return { ok: true }; }
  if (kind === "get_clip_pitches") {
    var gcs = api("live_set tracks " + p.track + " clip_slots " + p.slot);
    if (g(gcs, "has_clip") == 0) throw new Error("no clip at track " + p.track + " slot " + p.slot);
    var gclip = api("live_set tracks " + p.track + " clip_slots " + p.slot + " clip");
    var pitches = [];
    try {
      var gr = gclip.call("get_notes_extended", 0, 128, 0, 1000000);
      var gs = (typeof gr === "string") ? gr : (gr && gr.join ? gr.join("") : "");
      if (gs) { var go = JSON.parse(gs); if (go && go.notes) for (var gni = 0; gni < go.notes.length; gni++) pitches.push(go.notes[gni].pitch); }
    } catch (e) {}
    return { pitches: pitches };
  }

  throw new Error("unknown kind: " + kind);
}
