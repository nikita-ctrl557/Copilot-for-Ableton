# ClaudeCopilot.py — the reliable Live-control backend. Runs INSIDE Live with the
# full, documented Live Object Model on the main thread — unlike Max-for-Live's v8
# LiveAPI, which on Live 12 can't even reach the browser and is flaky for device
# editing. The node backend connects to this socket and asks it to load devices/
# presets, read a device's REAL parameters, and set them (with read-back proof).
#
# Protocol: newline-delimited JSON over TCP on 127.0.0.1:9001.
#   {op:"ping"}                                   -> {ok, pong, liveVersion}
#   {op:"diag"}                                   -> rich snapshot (see _diag)
#   {op:"list", category, limit}                  -> {ok, items:[names]}
#   {op:"load", kind, name, track}                -> {ok, loaded, added, deviceCount}
#   {op:"get_params", track, device}             -> {ok, device, params:[{index,name,value,min,max,quantized}]}
#   {op:"set_param", track, device, param, value} -> {ok, name, before, after, changed}
# All Live API work runs on the MAIN thread (socket thread only enqueues; a recurring
# schedule_message drains the queue).
import socket
import threading
import json
import math
import time

import Live

try:
    import queue
except ImportError:  # very old pythons
    import Queue as queue

try:
    from ableton.v2.control_surface import ControlSurface
except Exception:
    from _Framework.ControlSurface import ControlSurface

HOST = "127.0.0.1"
PORT = 9001


class ClaudeCopilot(ControlSurface):
    def __init__(self, c_instance):
        try:
            ControlSurface.__init__(self, c_instance)
        except Exception:
            super(ClaudeCopilot, self).__init__(c_instance)
        self._running = True
        self._reqs = queue.Queue()
        self._sock = None
        self._stop_at = None          # arrangement beat to auto-stop a master recording
        self._capture_name = "Claude Capture"
        # ---- real-time awareness: LOM listeners push change EVENTS into this queue;
        # node drains them via the poll_changes op (precise triggers, not blind polling).
        self._events = []
        self._song_l = []             # song-level listeners (permanent)
        self._struct = []             # per-track/clip listeners (rebuilt on structure changes)
        self._relisten = False
        self._start_server()
        try:
            self._setup_song_listeners()
            self._setup_structure_listeners()
        except Exception:
            pass
        self.schedule_message(1, self._tick)
        try:
            self.log_message("Claude_Copilot loaded; control socket on %d" % PORT)
            self.show_message("Claude Copilot ready (port %d)" % PORT)
        except Exception:
            pass

    # ---- socket (background thread: enqueues only, never touches the Live API) ----
    def _start_server(self):
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._sock.bind((HOST, PORT))
            self._sock.listen(5)
            t = threading.Thread(target=self._accept_loop)
            t.daemon = True
            t.start()
        except Exception as e:
            try:
                self.log_message("Claude_Copilot socket error: " + str(e))
            except Exception:
                pass

    def _accept_loop(self):
        while self._running:
            try:
                conn, _ = self._sock.accept()
            except Exception:
                break
            try:
                conn.settimeout(30)
                buf = b""
                while b"\n" not in buf:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                line = buf.split(b"\n")[0].decode("utf-8", "ignore")
                req = json.loads(line)
                resp_q = queue.Queue()
                # deadline: if the client gives up before we run this, we must NOT run it
                # later anyway (a retried 'load' would otherwise execute twice)
                self._reqs.put((req, resp_q, time.time() + 24))
                try:
                    result = resp_q.get(timeout=28)
                except Exception:
                    result = {"ok": False, "error": "main-thread timeout"}
                conn.sendall((json.dumps(result) + "\n").encode("utf-8"))
            except Exception as e:
                try:
                    conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode("utf-8"))
                except Exception:
                    pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

    # ---- main thread: drain the queue, run the Live API ----
    def _tick(self):
        if not self._running:
            return
        # structure changed (tracks/clips added or removed) → re-register the per-track
        # listeners DEFERRED here on the main thread, never inside a listener callback.
        if self._relisten:
            self._relisten = False
            try:
                self._setup_structure_listeners()
            except Exception:
                pass
        # auto-stop a master recording once it has captured the requested length
        if self._stop_at is not None:
            try:
                if self._song().current_song_time >= self._stop_at:
                    self._do_stop_record()
            except Exception:
                self._stop_at = None
        try:
            while True:
                req, resp_q, deadline = self._reqs.get_nowait()
                # client already gave up → DO NOT execute (prevents duplicate side
                # effects when a timed-out 'load' is retried)
                if time.time() > deadline:
                    try:
                        resp_q.put({"ok": False, "error": "expired before execution"})
                    except Exception:
                        pass
                    continue
                try:
                    resp_q.put(self._handle(req))
                except Exception as e:
                    try:
                        resp_q.put({"ok": False, "error": str(e)})
                    except Exception:
                        pass
        except queue.Empty:
            pass
        except Exception:
            pass  # NOTHING may kill the tick chain — it would silently brick the loader
        self.schedule_message(1, self._tick)

    def _handle(self, req):
        op = req.get("op")
        if op == "ping":
            return {"ok": True, "pong": True, "liveVersion": self._live_version()}
        if op == "diag":
            return self._diag()
        if op == "load":
            return self._load(req.get("kind", "instrument"), req.get("name", ""), req.get("track"))
        if op == "list":
            return self._list(req.get("category", "instruments"), int(req.get("limit", 200)), req.get("filter"))
        if op == "get_params":
            return self._get_params(req.get("track"), req.get("device", 0))
        if op == "set_param":
            return self._set_param(req.get("track"), req.get("device", 0), req.get("param"), req.get("value"))
        if op == "automate":
            return self._automate(req.get("track"), req.get("device", 0), req.get("param"), req.get("slot", 0), req.get("ramp"), req.get("points"))
        if op == "automation_get":
            return self._automation_get(req.get("track"), req.get("device", 0), req.get("param"), req.get("slot", 0), int(req.get("points", 9)))
        if op == "automation_clear":
            return self._automation_clear(req.get("track"), req.get("device", 0), req.get("param"), req.get("slot", 0))
        if op == "set_property":
            return self._set_property(req.get("track"), req.get("device", 0), req.get("property"), req.get("value"))
        if op == "get_device":
            return self._get_device(req.get("track"), req.get("device", 0))
        if op == "session":
            return self._session()
        if op == "tracks":
            return self._tracks()
        if op == "track":
            return self._track(req.get("track"))
        if op == "meters":
            return self._meters()
        if op == "fix_meters":
            return self._fix_meters()
        if op == "poll_changes":
            evs = self._events
            self._events = []
            out = {"ok": True, "events": evs}
            try:
                song = self._song()
                out["tempo"] = round(song.tempo, 2)
                out["key"] = self._key_str()
                out["isPlaying"] = bool(song.is_playing)
            except Exception:
                pass
            return out
        if op == "lom_get":
            return self._lom_get(req.get("path"), req.get("prop"))
        if op == "lom_set":
            return self._lom_set(req.get("path"), req.get("prop"), req.get("value"))
        if op == "lom_call":
            return self._lom_call(req.get("path"), req.get("method"), req.get("args", []))
        if op == "load_sound":
            return self._load_sound(req.get("name", ""), req.get("track"))
        if op == "record_master":
            return self._record_master(int(req.get("bars", 4)))
        if op == "chains":
            return self._chains()
        if op == "pitches":
            return self._pitches()
        if op == "wt_mod":
            return self._wt_mod(req.get("track"), int(req.get("device", 0)), req.get("target"), req.get("source"), req.get("amount"))
        if op == "move_device":
            return self._move_device(req.get("track"), int(req.get("device")), int(req.get("to")))
        if op == "cleanup_captures":
            return self._cleanup_captures()
        if op == "stop_record":
            return self._stop_record()
        return {"ok": False, "error": "unknown op: " + str(op) + " — the Claude_Copilot loader running in Live is OUTDATED. Quit and reopen Live to load the updated script, then retry."}

    # ---- helpers ----
    def _live_version(self):
        try:
            a = Live.Application.get_application()
            return "%d.%d.%d" % (a.get_major_version(), a.get_minor_version(), a.get_bugfix_version())
        except Exception:
            return "?"

    def _song(self):
        # ableton.v2 exposes `song` as a PROPERTY; _Framework as a METHOD. Handle both.
        s = self.song
        return s() if callable(s) else s

    def _browser(self):
        return Live.Application.get_application().browser

    # ---- REAL-TIME AWARENESS: LOM listeners (verified API) -> event queue ----
    NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

    def _key_str(self):
        try:
            song = self._song()
            return "%s %s" % (self.NOTE_NAMES[int(song.root_note) % 12], str(song.scale_name))
        except Exception:
            return "?"

    def _emit(self, ev):
        # coalesce: keep only the newest event with the same signature
        sig = (ev.get("kind"), ev.get("track"), ev.get("slot"))
        self._events = [e for e in self._events if (e.get("kind"), e.get("track"), e.get("slot")) != sig]
        self._events.append(ev)
        if len(self._events) > 80:
            self._events = self._events[-80:]

    def _listen(self, obj, name, cb, bucket):
        try:
            getattr(obj, "add_%s_listener" % name)(cb)
            bucket.append((obj, name, cb))
        except Exception:
            pass

    def _unlisten(self, bucket):
        for obj, name, cb in bucket:
            try:
                getattr(obj, "remove_%s_listener" % name)(cb)
            except Exception:
                pass  # object may already be deleted — benign
        del bucket[:]

    def _setup_song_listeners(self):
        song = self._song()
        self._listen(song, "tempo", lambda: self._emit({"kind": "tempo", "value": round(self._song().tempo, 2)}), self._song_l)
        self._listen(song, "root_note", lambda: self._emit({"kind": "key", "key": self._key_str()}), self._song_l)
        self._listen(song, "scale_name", lambda: self._emit({"kind": "key", "key": self._key_str()}), self._song_l)
        self._listen(song, "signature_numerator", lambda: self._emit({"kind": "timesig"}), self._song_l)
        self._listen(song, "tracks", self._on_tracks_changed, self._song_l)

    def _on_tracks_changed(self):
        self._emit({"kind": "tracks"})
        self._relisten = True   # rebuild per-track listeners on the next tick (never inline)

    def _setup_structure_listeners(self):
        self._unlisten(self._struct)
        song = self._song()
        for i, t in enumerate(song.tracks[:24]):
            def make_dev_cb(i=i):
                def cb():
                    try:
                        nm = str(self._song().tracks[i].name)
                    except Exception:
                        nm = "track %d" % i
                    self._emit({"kind": "devices", "track": i, "name": nm})
                return cb
            def make_name_cb(i=i):
                return lambda: self._emit({"kind": "rename", "track": i})
            self._listen(t, "devices", make_dev_cb(), self._struct)
            self._listen(t, "name", make_name_cb(), self._struct)
            try:
                slots = t.clip_slots
            except Exception:
                continue
            for j in range(min(len(slots), 16)):
                cs = slots[j]
                def make_clip_cb(i=i, j=j):
                    def cb():
                        has = False
                        try:
                            has = bool(self._song().tracks[i].clip_slots[j].has_clip)
                        except Exception:
                            pass
                        self._emit({"kind": "clip", "track": i, "slot": j, "has": has})
                        self._relisten = True   # attach/detach the notes listener
                    return cb
                self._listen(cs, "has_clip", make_clip_cb(), self._struct)
                try:
                    if cs.has_clip and cs.clip.is_midi_clip:
                        def make_notes_cb(i=i, j=j):
                            return lambda: self._emit({"kind": "notes", "track": i, "slot": j})
                        self._listen(cs.clip, "notes", make_notes_cb(), self._struct)
                except Exception:
                    pass

    def _roots(self, kind):
        b = self._browser()
        if kind == "audioEffect":
            names = ["audio_effects", "plugins", "max_for_live"]
        elif kind == "sound":       # loops, one-shots, samples, clips (the "drag in a loop" case)
            names = ["sounds", "samples", "clips", "drums", "user_library", "packs"]
        else:
            names = ["instruments", "sounds", "drums", "plugins", "max_for_live"]
        out = []
        for n in names:
            r = getattr(b, n, None)
            if r is not None:
                out.append((n, r))
        return out

    def _iter_loadable(self, root, limit=6000):
        """Depth-first walk yielding (name, item) for every loadable leaf."""
        stack, visited = [root], 0
        while stack and visited < limit:
            it = stack.pop()
            visited += 1
            try:
                if getattr(it, "is_loadable", False) and it.name:
                    yield it.name, it
                for c in getattr(it, "children", []):
                    stack.append(c)
            except Exception:
                pass

    # words that mean "this is a drum kit / Drum Rack", not a melodic synth
    _DRUM_WORDS = ("kit", "kits", "drum", "drums", "drumrack", "909", "808", "707",
                   "606", "727", "breakbeat", "break", "breaks", "percussion", "perc")

    def _wants_drums(self, want):
        return any(w in self._DRUM_WORDS for w in want)

    def _roots_for(self, kind, want):
        roots = self._roots(kind)
        # when the request implies drums, search the 'drums' category FIRST
        if kind != "sound" and self._wants_drums(want):
            roots.sort(key=lambda nr: 0 if nr[0] == "drums" else 1)
        return roots

    def _search(self, kind, want_str):
        want = [w for w in want_str.lower().split() if w]
        want_drums = self._wants_drums(want) and kind != "sound"
        target = " ".join(want)
        WORD = 100
        best, best_score, best_words, alts = None, -1, 0, []
        budget = 4000          # total items scanned across ALL roots — keeps loads fast
        done = False
        for cat_name, root in self._roots_for(kind, want):
            if done or budget <= 0:
                break
            for nm, it in self._iter_loadable(root, limit=min(2000, budget)):
                budget -= 1
                low = nm.lower()
                words_hit = sum(1 for w in want if w in low)
                score = words_hit * WORD
                exact = (low == target)
                if exact:
                    score += 500
                try:
                    is_dev = (kind != "sound" and getattr(it, "is_device", False))
                    is_fold = getattr(it, "is_folder", False)
                except Exception:
                    is_dev = is_fold = False
                if is_dev:
                    score += 1
                if is_fold:
                    score -= 2
                if want_drums and cat_name == "drums" and words_hit > 0:
                    score += 40
                if score > best_score:
                    best_score, best, best_words = score, it, words_hit
                if words_hit > 0 and len(alts) < 10 and nm not in alts:
                    alts.append(nm)
                # FAST EXIT: an exact name match, or all query words hit on a real device,
                # is good enough — stop scanning immediately (this is the big speed-up).
                if exact or (best_words >= len(want) and is_dev):
                    done = True
                    break
                if budget <= 0:
                    break
            if best is not None and best_words >= 1 and best_words >= len(want):
                break
        # HARD GATE: a winner MUST contain at least one query word in its name.
        if best is None or best_words < 1:
            return None, 0, alts
        return best, best_score, alts

    def _track_obj(self, track):
        # ONE track-index space everywhere: 0..N-1 = regular tracks, -1 = MASTER,
        # -2 - r = RETURN track r (return A = -2, B = -3, …). This is what lets the
        # loader/meters/params reach returns + master, not just song.tracks.
        song = self._song()
        if track is None:
            raise Exception("track index required")
        if isinstance(track, str):
            if track.lower() in ("master", "-1"):
                return song.master_track
            track = int(track)
        track = int(track)
        if track == -1:
            return song.master_track
        if track <= -2:
            r = -2 - track
            rts = list(song.return_tracks)
            if r < 0 or r >= len(rts):
                raise Exception("return index out of range: %s (set has %d returns)" % (str(track), len(rts)))
            return rts[r]
        if 0 <= track < len(song.tracks):
            return song.tracks[track]
        raise Exception("track index out of range: %s" % str(track))

    def _device_at(self, track, device):
        t = self._track_obj(track)
        if device < 0 or device >= len(t.devices):
            raise Exception("device index out of range: %s (track has %d)" % (str(device), len(t.devices)))
        return t.devices[device]

    # ---- ops ----
    def _load(self, kind, name, track):
        best, score, alts = self._search(kind, name)
        if best is None:
            hint = None
            if self._wants_drums([w for w in name.lower().split() if w]):
                hint = "For drum kits, load a Drum Rack from the 'drums' library — list category 'drums' for real names like 'Kit-Core 909'."
            return {"ok": False, "error": "no browser match for '%s' (nothing in the library has those words in its name)" % name,
                    "alternatives": alts, "hint": hint}
        song = self._song()
        tobj = None
        before = -1
        if track is not None:
            # resolves regular tracks AND -1 = master, -2-r = return r — so meters/
            # effects load onto the WHOLE set, not just song.tracks
            try:
                tobj = self._track_obj(track)
            except Exception:
                tobj = None
        if tobj is not None:
            song.view.selected_track = tobj
            before = len(tobj.devices)
        loaded_name = best.name
        b = self._browser()
        # 0 = ADD AT END of the device chain (documented LOM Browser.insert_mode).
        # This is what makes the meter / any effect land LAST so it hears the final signal.
        try:
            b.insert_mode = 0
        except Exception:
            pass
        try:
            b.load_item(best)
        except Exception as e:
            return {"ok": False, "error": "load_item('%s') failed: %s" % (loaded_name, str(e)),
                    "loadable": bool(getattr(best, "is_loadable", False)),
                    "isFolder": bool(getattr(best, "is_folder", False)), "alternatives": alts}
        after = before
        last_name = None
        if tobj is not None:
            after = len(tobj.devices)
            try:
                last_name = tobj.devices[-1].name if len(tobj.devices) else None
                # belt & suspenders: if it somehow isn't last, move it (song.move_device is real LOM)
                if last_name is not None and last_name != loaded_name:
                    for i in range(len(tobj.devices) - 2, -1, -1):
                        if tobj.devices[i].name == loaded_name:
                            try:
                                song.move_device(tobj.devices[i], tobj, len(tobj.devices) - 1)
                                last_name = tobj.devices[-1].name
                            except Exception:
                                pass
                            break
            except Exception:
                pass
        added = (after > before) if before >= 0 else None
        # THE METER IS ALWAYS LAST — synchronously, in the same op. The async
        # fix_meters call from node raced against Live registering the new device
        # and could lose, leaving the meter mid-chain (deaf to the new effect).
        try:
            if tobj is not None:
                self._meter_last(tobj)
                last_name = tobj.devices[-1].name if len(tobj.devices) else last_name
        except Exception:
            pass
        return {"ok": True, "loaded": loaded_name, "score": score, "alternatives": alts,
                "added": added, "deviceCount": after, "lastInChain": last_name,
                "warn": (None if added is not False else "matched '%s' but no device appeared — it may be a folder/preview node; try a more exact name (alternatives: %s)" % (loaded_name, ", ".join(alts)))}

    def _meter_last(self, tobj):
        # move any ClaudeMeter on this track to the very end of its chain
        song = self._song()
        devs = list(tobj.devices)
        for i, dvc in enumerate(devs):
            try:
                nm = str(dvc.name).lower()
            except Exception:
                continue
            if "claude" in nm and "meter" in nm and i != len(devs) - 1:
                try:
                    song.move_device(dvc, tobj, len(devs) - 1)
                except Exception:
                    pass
                break

    def _list(self, category, limit, flt=None):
        root = getattr(self._browser(), category, None)
        if root is None:
            return {"ok": False, "error": "no category: " + category,
                    "valid": ["instruments", "sounds", "drums", "audio_effects", "midi_effects",
                              "plugins", "max_for_live", "packs", "samples", "user_library"]}
        want = str(flt).lower() if flt else None
        items = []
        for nm, _it in self._iter_loadable(root, limit=8000):
            if want and want not in nm.lower():
                continue
            if nm not in items:
                items.append(nm)
            if len(items) >= limit:
                break
        return {"ok": True, "category": category, "filter": flt or None, "items": items, "count": len(items)}

    def _param_dict(self, idx, p):
        d = {"index": idx, "name": p.name, "value": p.value, "min": p.min, "max": p.max}
        try:
            d["quantized"] = bool(p.is_quantized)
        except Exception:
            d["quantized"] = False
        try:
            # value_items exposes the labels for enum-style params (e.g. filter type)
            items = list(getattr(p, "value_items", []) or [])
            if items:
                d["options"] = [str(x) for x in items]
        except Exception:
            pass
        return d

    def _get_params(self, track, device):
        d = self._device_at(track, device)
        params = [self._param_dict(i, p) for i, p in enumerate(d.parameters)]
        out = {"ok": True, "device": d.name, "class": d.class_name, "track": track, "params": params}
        try:
            if str(d.class_name) in ("PluginDevice", "AuPluginDevice") and len(params) <= 1:
                out["configureNeeded"] = True
                out["configureHelp"] = self.CONFIGURE_HELP
        except Exception:
            pass
        return out

    def _set_param(self, track, device, param, value):
        d = self._device_at(track, device)
        target, idx = None, None
        if isinstance(param, (int, float)) and not isinstance(param, bool):
            idx = int(param)
            if idx < 0 or idx >= len(d.parameters):
                raise Exception("param index out of range: %d (device has %d)" % (idx, len(d.parameters)))
            target = d.parameters[idx]
        else:
            want = str(param).lower()
            # exact (case-insensitive), then substring
            for i, p in enumerate(d.parameters):
                if p.name.lower() == want:
                    target, idx = p, i
                    break
            if target is None:
                for i, p in enumerate(d.parameters):
                    if want in p.name.lower():
                        target, idx = p, i
                        break
            if target is None:
                names = [p.name for p in d.parameters]
                raise Exception("no parameter matching '%s'. available: %s" % (param, ", ".join(names)))
        before = target.value
        v = float(value)
        # clamp into range; quantized params want an int
        lo, hi = target.min, target.max
        if v < lo:
            v = lo
        if v > hi:
            v = hi
        try:
            if getattr(target, "is_quantized", False):
                v = round(v)
        except Exception:
            pass
        try:
            target.value = v
        except Exception as e:
            raise Exception("could not set '%s' (is it automatable/enabled?): %s" % (target.name, str(e)))
        after = target.value
        return {"ok": True, "device": d.name, "param": target.name, "index": idx,
                "before": before, "after": after, "min": lo, "max": hi,
                "changed": before != after}

    @staticmethod
    def _safe(v):
        if v is None or isinstance(v, (int, float, str, bool)):
            return v
        try:
            return [ClaudeCopilot._safe(x) for x in v]   # StringVector / list
        except Exception:
            return str(v)

    @staticmethod
    def _coerce(v):
        if isinstance(v, bool) or v is None:
            return v
        if isinstance(v, (int, float)):
            return int(v) if float(v).is_integer() else v
        if isinstance(v, str):
            try:
                f = float(v)
                return int(f) if f.is_integer() else f
            except Exception:
                return v
        return v

    # ---- draw PARAMETER AUTOMATION into a clip (filter sweep, level ride, etc.) ----
    def _find_param(self, dev, param):
        if isinstance(param, (int, float)) and not isinstance(param, bool):
            i = int(param)
            return dev.parameters[i] if 0 <= i < len(dev.parameters) else None
        want = str(param).lower()
        for p in dev.parameters:
            if p.name.lower() == want:
                return p
        for p in dev.parameters:
            if want in p.name.lower():
                return p
        return None

    def _automate(self, track, device, param, slot, ramp, points):
        song = self._song()
        if track is None or not (0 <= track < len(song.tracks)):
            return {"ok": False, "error": "track out of range"}
        t = song.tracks[track]
        # resolve the target parameter: a device param, or 'volume'/'pan' on the mixer
        target = None
        pname = str(param or "").lower()
        if pname in ("volume", "vol"):
            target = t.mixer_device.volume
        elif pname in ("pan", "panning"):
            target = t.mixer_device.panning
        else:
            try:
                target = self._find_param(t.devices[device], param)
            except Exception:
                target = None
        if target is None:
            return {"ok": False, "error": "no parameter '%s' on track %s" % (param, track)}
        if not (0 <= slot < len(t.clip_slots)) or not t.clip_slots[slot].has_clip:
            return {"ok": False, "error": "no clip in slot %s to automate" % slot}
        clip = t.clip_slots[slot].clip
        try:
            if clip.is_arrangement_clip:
                return {"ok": False, "error": "automation envelopes only work on Session clips"}
        except Exception:
            pass
        # clear any existing envelope for this param, then get-or-CREATE a fresh one.
        # (automation_envelope() returns None if absent — it does NOT create; you must
        #  call create_automation_envelope(). Confirmed against the Live LOM.)
        try:
            clip.clear_envelope(target)
        except Exception:
            pass
        try:
            env = clip.automation_envelope(target)
            if env is None:
                env = clip.create_automation_envelope(target)
        except Exception as e:
            return {"ok": False, "error": "couldn't create automation envelope: " + str(e)}
        if env is None:
            return {"ok": False, "error": "no envelope for that parameter"}
        length = clip.length
        lo, hi = target.min, target.max
        n = 0
        try:
            if ramp:
                v0 = float(ramp.get("from", lo)); v1 = float(ramp.get("to", hi))
                steps = 24
                for i in range(steps + 1):
                    tt = length * i / steps
                    vv = max(lo, min(hi, v0 + (v1 - v0) * i / steps))
                    env.insert_step(tt, 0.0, vv)
                    n += 1
            elif points:
                for pt in points:
                    env.insert_step(float(pt["time"]), float(pt.get("duration", 0.0)), max(lo, min(hi, float(pt["value"]))))
                    n += 1
        except Exception as e:
            return {"ok": False, "error": "insert failed (%s) — automation API may differ on this version" % str(e)}
        try:
            song.re_enable_automation()
        except Exception:
            pass
        # PROOF: read the envelope back at start/mid/end so success is verified, not assumed
        proof = []
        try:
            for frac in (0.0, 0.5, 1.0):
                tt = length * frac
                proof.append({"t": round(tt, 3), "v": round(env.value_at_time(tt), 4)})
        except Exception:
            pass
        return {"ok": True, "param": target.name, "points": n, "min": lo, "max": hi, "clipLength": length, "readback": proof}

    def _resolve_autom_target(self, track, device, param):
        song = self._song()
        if track is None or not (0 <= track < len(song.tracks)):
            return None, None, {"ok": False, "error": "track out of range"}
        t = song.tracks[track]
        pname = str(param or "").lower()
        if pname in ("volume", "vol"):
            target = t.mixer_device.volume
        elif pname in ("pan", "panning"):
            target = t.mixer_device.panning
        else:
            try:
                target = self._find_param(t.devices[device], param)
            except Exception:
                target = None
        if target is None:
            return None, None, {"ok": False, "error": "no parameter '%s' on track %s" % (param, track)}
        return t, target, None

    # READ an envelope back (sampled) so the agent can SEE + edit existing automation
    def _automation_get(self, track, device, param, slot, npts):
        t, target, err = self._resolve_autom_target(track, device, param)
        if err:
            return err
        if not (0 <= slot < len(t.clip_slots)) or not t.clip_slots[slot].has_clip:
            return {"ok": False, "error": "no clip in slot %s" % slot}
        clip = t.clip_slots[slot].clip
        env = None
        try:
            env = clip.automation_envelope(target)
        except Exception:
            pass
        if env is None:
            return {"ok": True, "exists": False, "param": target.name,
                    "note": "no automation on this parameter in this clip — write_automation to add one"}
        L = clip.length
        pts = []
        n = max(2, min(33, npts))
        for i in range(n):
            tt = L * i / (n - 1)
            try:
                pts.append({"t": round(tt, 3), "v": round(env.value_at_time(tt), 4)})
            except Exception:
                pass
        return {"ok": True, "exists": True, "param": target.name, "min": target.min, "max": target.max,
                "clipLength": L, "points": pts}

    def _automation_clear(self, track, device, param, slot):
        song = self._song()
        if track is None or not (0 <= track < len(song.tracks)):
            return {"ok": False, "error": "track out of range"}
        tr = song.tracks[track]
        if not (0 <= slot < len(tr.clip_slots)) or not tr.clip_slots[slot].has_clip:
            return {"ok": False, "error": "no clip in slot %s" % slot}
        clip = tr.clip_slots[slot].clip
        if not param:
            try:
                clip.clear_all_envelopes()
                return {"ok": True, "cleared": "all"}
            except Exception as e:
                return {"ok": False, "error": str(e)}
        t, target, err = self._resolve_autom_target(track, device, param)
        if err:
            return err
        try:
            clip.clear_envelope(target)
            return {"ok": True, "cleared": target.name}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---- set a device PROPERTY (Wavetable osc/wavetable/unison etc.). Python CAN set
    # these even though Max's v8 LiveAPI treats them as observe-only. ----
    def _set_property(self, track, device, prop, value):
        d = self._device_at(track, device)
        if not prop:
            return {"ok": False, "error": "no property given"}
        if not hasattr(d, prop):
            avail = [p for p in dir(d) if not p.startswith("_")
                     and any(k in p for k in ("oscillator", "filter", "unison", "mono", "poly", "wavetable"))]
            return {"ok": False, "class": d.class_name,
                    "error": "device '%s' (class %s) has no property '%s'" % (d.name, d.class_name, prop),
                    "hint": "settable selectors on this device: " + ", ".join(avail[:20])}
        try:
            before = self._safe(getattr(d, prop))
        except Exception:
            before = None
        val = self._coerce(value)
        try:
            setattr(d, prop, val)
        except Exception as e:
            return {"ok": False, "class": d.class_name,
                    "error": "couldn't set %s=%s: %s (category must be set BEFORE index; value must be a valid int enum)" % (prop, str(val), str(e))}
        try:
            after = self._safe(getattr(d, prop))
        except Exception:
            after = None
        return {"ok": True, "device": d.name, "class": d.class_name, "property": prop,
                "before": before, "after": after, "changed": before != after}

    # ---- full device picture: params + Wavetable selectors (categories/tables) ----
    def _get_device(self, track, device):
        d = self._device_at(track, device)
        params = [self._param_dict(i, p) for i, p in enumerate(d.parameters)]
        info = {"ok": True, "device": d.name, "class": d.class_name, "track": track, "params": params}
        try:
            if str(d.class_name) in ("PluginDevice", "AuPluginDevice") and len(params) <= 1:
                info["configureNeeded"] = True
                info["configureHelp"] = self.CONFIGURE_HELP
        except Exception:
            pass
        extras = {}
        for prop in ("oscillator_1_effect_mode", "oscillator_2_effect_mode",
                     "oscillator_1_wavetable_category", "oscillator_1_wavetable_index",
                     "oscillator_2_wavetable_category", "oscillator_2_wavetable_index",
                     "filter_routing", "mono_poly", "unison_mode", "unison_voice_count", "poly_voices",
                     "oscillator_wavetable_categories", "oscillator_1_wavetables", "oscillator_2_wavetables"):
            if hasattr(d, prop):
                try:
                    extras[prop] = self._safe(getattr(d, prop))
                except Exception:
                    pass
        if extras:
            info["selectors"] = extras
        return info

    # ---- GENERIC LOM bridge: future-proof. Lets the node side read/set/call ANY Live
    # Object Model member without adding a new op + restarting Live. Localhost only. ----
    def _resolve(self, path):
        toks = path if isinstance(path, list) else (str(path).split() if path else [])
        obj = self._song()
        if toks and toks[0] in ("song", "app", "application", "view", "master", "master_track"):
            head = toks[0]
            toks = toks[1:]
            if head in ("app", "application"):
                obj = Live.Application.get_application()
            elif head == "view":
                obj = self._song().view
            elif head in ("master", "master_track"):
                obj = self._song().master_track
        for tok in toks:
            if isinstance(tok, int) or (isinstance(tok, str) and tok.lstrip("-").isdigit()):
                obj = obj[int(tok)]
            else:
                obj = getattr(obj, tok)
        return obj

    def _lom_get(self, path, prop):
        obj = self._resolve(path)
        val = getattr(obj, prop) if prop else obj
        return {"ok": True, "value": self._safe(val)}

    def _lom_set(self, path, prop, value):
        obj = self._resolve(path)
        before = self._safe(getattr(obj, prop))
        setattr(obj, prop, self._coerce(value))
        after = self._safe(getattr(obj, prop))
        return {"ok": True, "before": before, "after": after, "changed": before != after}

    def _lom_call(self, path, method, args):
        obj = self._resolve(path)
        fn = getattr(obj, method)
        res = fn(*(args or []))
        return {"ok": True, "result": self._safe(res)}

    # ---- keep every ClaudeMeter LAST in its chain: new devices load at the end, which
    # pushes the meter mid-chain — then the agent hears PRE-fx audio and judges wrong.
    def _fix_meters(self):
        song = self._song()
        moved = 0
        tracks = list(song.tracks) + list(song.return_tracks) + [song.master_track]
        for t in tracks:
            try:
                devs = list(t.devices)
                for i, d in enumerate(devs):
                    nm = ""
                    try:
                        nm = str(d.name).lower()
                    except Exception:
                        pass
                    if "claude" in nm and "meter" in nm and i != len(devs) - 1:
                        try:
                            song.move_device(d, t, len(devs) - 1)
                            moved += 1
                        except Exception:
                            pass
                        break  # indexes shifted — one meter per track is the contract
            except Exception:
                pass
        return {"ok": True, "moved": moved}

    # ---- ALL MIDI pitches in the set → 12-bin pitch-class histogram. This is what
    # the ACTUAL key of the song is detected from (Live's scale chooser is just a
    # setting the user may never have touched). Drum-rack tracks are skipped — drum
    # pads are kit slots, not harmony, and they wreck key detection. ----
    def _pitches(self):
        song = self._song()
        hist = [0.0] * 12
        total = 0
        for t in song.tracks:
            try:
                if any(str(d.class_name) == "DrumGroupDevice" for d in t.devices):
                    continue  # drums are not harmony
            except Exception:
                pass
            try:
                slots = list(t.clip_slots)
            except Exception:
                continue
            for cs in slots:
                try:
                    if not cs.has_clip or not cs.clip.is_midi_clip:
                        continue
                    cl = cs.clip
                except Exception:
                    continue
                notes = []
                try:
                    ns = cl.get_notes_extended(0, 128, 0.0, 100000.0)  # Live 11+
                    notes = [(int(n.pitch), float(n.duration)) for n in ns]
                except Exception:
                    try:
                        ns = cl.get_notes(0.0, 0, 100000.0, 128)  # legacy tuples (pitch, time, dur, vel, mute)
                        notes = [(int(n[0]), float(n[2])) for n in ns]
                    except Exception:
                        notes = []
                for p, dur in notes:
                    # weight by duration (capped) so held chords count more than blips
                    hist[p % 12] += max(0.25, min(4.0, dur))
                    total += 1
                if total > 6000:
                    break
            if total > 6000:
                break
        return {"ok": True, "hist": hist, "total": total, "liveScale": self._key_str()}

    # ---- Wavetable MOD MATRIX: the routing the sound-design engine never touched.
    # WavetableDevice (class_name 'InstrumentVector') exposes the matrix via
    # visible_modulation_target_names + get/set_modulation_value(target_i, source_i,
    # amount -1..1). Env/LFO SHAPES are normal parameters; THIS wires them somewhere. ----
    WT_MOD_SOURCES = ["Amp Env", "Env 2", "Env 3", "LFO 1", "LFO 2",
                      "MIDI Velocity", "MIDI Note", "MIDI Pitch Bend", "MIDI Aftertouch",
                      "MIDI Mod Wheel", "MIDI Random"]

    def _wt_mod(self, track, device, target, source, amount):
        d = self._device_at(track, device)
        cls = str(d.class_name)
        if not hasattr(d, "visible_modulation_target_names") or not hasattr(d, "set_modulation_value"):
            return {"ok": False, "class": cls,
                    "error": "this device has no modulation matrix API (only Wavetable/'InstrumentVector' does)",
                    "available": [a for a in dir(d) if "modul" in a.lower()]}
        try:
            targets = [str(x) for x in d.visible_modulation_target_names]
        except Exception as e:
            return {"ok": False, "class": cls, "error": "couldn't read modulation targets: " + str(e)}
        # no target → discovery mode: hand back the whole matrix surface
        if target is None or target == "":
            return {"ok": True, "class": cls, "targets": targets, "sources": self.WT_MOD_SOURCES,
                    "note": "set_modulation with target+source+amount (-1..1) wires the matrix; envelope/LFO shapes are normal parameters"}
        # resolve target: int index or case-insensitive (sub)string
        ti = None
        if isinstance(target, (int, float)) and not isinstance(target, bool):
            ti = int(target)
        else:
            tq = str(target).lower()
            for i, name in enumerate(targets):
                if name.lower() == tq:
                    ti = i
                    break
            if ti is None:
                for i, name in enumerate(targets):
                    if tq in name.lower():
                        ti = i
                        break
        if ti is None or ti < 0 or ti >= len(targets):
            return {"ok": False, "error": "no modulation target matching '%s'" % str(target), "targets": targets}
        # resolve source: int index or name from the fixed source list
        si = None
        if isinstance(source, (int, float)) and not isinstance(source, bool):
            si = int(source)
        elif source is not None:
            sq = str(source).lower().replace("envelope", "env")
            for i, name in enumerate(self.WT_MOD_SOURCES):
                if sq == name.lower() or sq in name.lower():
                    si = i
                    break
        if si is None:
            return {"ok": False, "error": "no modulation source matching '%s'" % str(source), "sources": self.WT_MOD_SOURCES}
        before = None
        try:
            before = float(d.get_modulation_value(ti, si))
        except Exception:
            pass
        if amount is None:  # read mode
            return {"ok": True, "target": targets[ti], "source": self.WT_MOD_SOURCES[si], "value": before}
        try:
            d.set_modulation_value(ti, si, max(-1.0, min(1.0, float(amount))))
        except Exception as e:
            return {"ok": False, "error": "set_modulation_value failed: " + str(e),
                    "hint": "amount is -1..1; some targets need the section enabled (e.g. the filter on)"}
        after = None
        try:
            after = float(d.get_modulation_value(ti, si))
        except Exception:
            pass
        return {"ok": True, "target": targets[ti], "source": self.WT_MOD_SOURCES[si],
                "before": before, "after": after, "changed": before != after}

    # ---- device CHAINS: every track/return/master with per-device controllability ----
    # VST/AU plugins only expose the parameters the user has CONFIGURED in Live (the
    # green Configure flow) — paramCount <= 1 means just 'Device On', i.e. Claude can
    # see the plugin but can't turn any of its knobs yet.
    CONFIGURE_HELP = ("This is a VST/AU plug-in - Live only exposes the controls you CONFIGURE: "
                      "1) click the wrench/expand icon on the plug-in's title bar in Live so its panel shows; "
                      "2) press the 'Configure' button (it turns green); "
                      "3) open the plug-in's own editor window and touch/move every knob you want Claude to control - "
                      "each touched control appears as a green parameter cell in the panel; "
                      "4) press Configure again to finish, then ask Claude to re-read the device.")

    def _chain_of(self, idx, t):
        devs = []
        try:
            devices = list(t.devices)
        except Exception:
            devices = []
        for di, d in enumerate(devices):
            # per-device guard: ONE odd device must not hide the rest of the chain
            # (a truncated chain would make review_mix miss a limiter or a plugin)
            try:
                cls = ""
                try:
                    cls = str(d.class_name)
                except Exception:
                    pass
                is_plugin = cls in ("PluginDevice", "AuPluginDevice")
                pc = 0
                try:
                    pc = len(d.parameters)
                except Exception:
                    pass
                row = {"index": di, "name": str(d.name), "class": cls, "paramCount": pc, "plugin": is_plugin}
                if is_plugin:
                    row["configuredParams"] = max(0, pc - 1)  # 'Device On' is always there
                    row["controllable"] = pc > 1
                else:
                    row["controllable"] = True
                devs.append(row)
            except Exception:
                devs.append({"index": di, "name": "?", "class": "?", "paramCount": 0, "plugin": False, "controllable": False, "error": True})
        try:
            nm = str(t.name)
        except Exception:
            nm = "?"
        return {"track": idx, "name": nm, "devices": devs}

    def _chains(self):
        song = self._song()
        rows = [self._chain_of(i, t) for i, t in enumerate(song.tracks)]
        rows += [self._chain_of(-2 - i, t) for i, t in enumerate(song.return_tracks)]
        master = self._chain_of(-1, song.master_track)
        need = []
        for r in rows + [master]:
            for d in r["devices"]:
                if d.get("plugin") and not d.get("controllable"):
                    need.append({"track": r["track"], "trackName": r["name"], "device": d["name"]})
        return {"ok": True, "tracks": rows, "master": master,
                "configureNeeded": need,
                "configureHelp": (self.CONFIGURE_HELP if need else None)}

    def _move_device(self, track, device, to):
        # reorder a device chain (e.g. EQ before compressor, limiter LAST) — real LOM
        song = self._song()
        t = self._track_obj(track)
        if device < 0 or device >= len(t.devices):
            return {"ok": False, "error": "device index out of range: %d (track has %d)" % (device, len(t.devices))}
        d = t.devices[device]
        to = max(0, min(int(to), len(t.devices) - 1))
        before = [str(x.name) for x in t.devices]
        try:
            song.move_device(d, t, to)
        except Exception as e:
            return {"ok": False, "error": "move_device failed: " + str(e)}
        # any reorder can bury the ClaudeMeter mid-chain — keep it last, synchronously
        try:
            self._meter_last(t)
        except Exception:
            pass
        after = [str(x.name) for x in t.devices]
        return {"ok": True, "moved": str(d.name), "to": to, "chainBefore": before, "chainAfter": after,
                "changed": before != after}

    def _cleanup_captures(self):
        # delete the 'Claude Capture' resampling track(s) + their clips — leave no mess
        song = self._song()
        removed = 0
        try:
            for i in range(len(song.tracks) - 1, -1, -1):
                if str(song.tracks[i].name) == self._capture_name:
                    try:
                        song.delete_track(i)
                        removed += 1
                    except Exception:
                        pass
        except Exception:
            pass
        return {"ok": True, "removed": removed}

    # ---- HEAR the mix: read Live's own output meters (per track + master). No meter
    # device needed. Meaningful while audio is playing; sample a few times for a peak. ----
    @staticmethod
    def _db(lin):
        if lin is None or lin <= 0.00003:
            return -90.0
        return round(max(-90.0, 20.0 * math.log10(lin)), 1)

    def _meters(self):
        song = self._song()
        out = []
        for i, t in enumerate(song.tracks):
            try:
                l = float(t.output_meter_left)
                r = float(t.output_meter_right)
            except Exception:
                l = r = 0.0
            out.append({"track": i, "name": t.name, "L": l, "R": r,
                        "peakDb": self._db(max(l, r)), "rmsDb": self._db((l + r) / 2.0)})
        # RETURN tracks (FX busses) — same row shape, encoded index -2 - r, so the
        # mix review hears the reverb/delay busses too, not just the source tracks
        for i, t in enumerate(song.return_tracks):
            try:
                l = float(t.output_meter_left)
                r = float(t.output_meter_right)
            except Exception:
                l = r = 0.0
            out.append({"track": -2 - i, "name": t.name, "isReturn": True, "L": l, "R": r,
                        "peakDb": self._db(max(l, r)), "rmsDb": self._db((l + r) / 2.0)})
        master = {}
        try:
            m = song.master_track
            ml = float(m.output_meter_left)
            mr = float(m.output_meter_right)
            master = {"track": -1, "L": ml, "R": mr, "peakDb": self._db(max(ml, mr)), "rmsDb": self._db((ml + mr) / 2.0)}
            try:
                master["devices"] = [str(d.name) for d in m.devices]
            except Exception:
                pass
        except Exception:
            pass
        return {"ok": True, "tracks": out, "master": master, "isPlaying": bool(song.is_playing)}

    # ---- reliable read path (session / tracks / track) so the agent never depends on the flaky M4L bridge ----
    def _track_dict(self, i, t):
        try:
            ttype = "midi" if t.has_midi_input else "audio"
        except Exception:
            ttype = "?"
        devs = []
        try:
            for d in t.devices:
                devs.append(d.name)
        except Exception:
            pass
        out = {"index": i, "name": t.name, "type": ttype, "devices": devs, "deviceCount": len(devs)}
        # hasMeter must work for returns/master too (they have no clip_slots), so it
        # lives OUTSIDE the clips try below — devs is already collected above.
        out["hasMeter"] = any("claude" in str(d).lower() and "meter" in str(d).lower() for d in devs)
        # CLIPS that already exist on this track — so the agent KNOWS the loop is there
        # and builds on it instead of guessing/overwriting.
        try:
            clips = []
            for si, cs in enumerate(t.clip_slots):
                if cs.has_clip:
                    cl = cs.clip
                    info = {"slot": si, "name": cl.name}
                    try:
                        info["midi"] = bool(cl.is_midi_clip)
                        info["bars"] = round(cl.length / 4.0, 2)
                    except Exception:
                        pass
                    clips.append(info)
            out["clips"] = clips
        except Exception:
            pass
        try:
            mx = t.mixer_device
            out["volume"] = mx.volume.value
            out["pan"] = mx.panning.value
        except Exception:
            pass
        try:
            out["muted"] = bool(t.mute)
            out["soloed"] = bool(t.solo)
        except Exception:
            pass
        return out

    def _session(self):
        song = self._song()
        sel = 0
        try:
            st = song.view.selected_track
            for i, t in enumerate(song.tracks):
                if t == st:
                    sel = i
                    break
        except Exception:
            pass
        # how far the ARRANGEMENT runs (beats) — first-contact listening must cover
        # the WHOLE timeline, not a taste of it
        arr_beats = 0.0
        try:
            for t in song.tracks:
                for c in t.arrangement_clips:
                    e = float(c.end_time)
                    if e > arr_beats:
                        arr_beats = e
        except Exception:
            pass
        return {"ok": True, "tempo": song.tempo,
                "timeSignature": [song.signature_numerator, song.signature_denominator],
                "isPlaying": bool(song.is_playing),
                "trackCount": len(song.tracks), "sceneCount": len(song.scenes),
                "arrangementBeats": arr_beats,
                "selectedTrack": sel, "key": self._key_str()}

    def _tracks(self):
        song = self._song()
        res = {"ok": True, "tracks": [self._track_dict(i, t) for i, t in enumerate(song.tracks)]}
        # RETURNS + MASTER ride along (separate keys so nothing index-based breaks):
        # index encoding matches _track_obj — return r = -2 - r, master = -1.
        try:
            rets = []
            for i, t in enumerate(song.return_tracks):
                d = self._track_dict(-2 - i, t)
                d["type"] = "return"
                rets.append(d)
            res["returns"] = rets
        except Exception:
            res["returns"] = []
        try:
            m = self._track_dict(-1, song.master_track)
            m["type"] = "master"
            res["master"] = m
        except Exception:
            res["master"] = None
        return res

    def _track(self, index):
        song = self._song()
        if index is not None and index < 0:
            # master (-1) / returns (-2-r) — no clip slots, but devices/meter info works
            try:
                t = self._track_obj(index)
            except Exception as e:
                return {"ok": False, "error": str(e)}
            d = self._track_dict(index, t)
            d["type"] = "master" if index == -1 else "return"
            d["clipSlots"] = []
            d["ok"] = True
            return d
        if index is None or index >= len(song.tracks):
            return {"ok": False, "error": "track index out of range: %s" % str(index)}
        t = song.tracks[index]
        d = self._track_dict(index, t)
        slots = []
        try:
            for si, cs in enumerate(t.clip_slots):
                has = bool(cs.has_clip)
                slots.append({"index": si, "hasClip": has, "clipName": (cs.clip.name if has else None)})
        except Exception:
            pass
        d["clipSlots"] = slots
        d["ok"] = True
        return d

    # ---- drag in a loop / sound / sample onto a track ----
    def _load_sound(self, name, track):
        best, score, alts = self._search("sound", name)
        if best is None:
            return {"ok": False, "error": "no loop/sound match for '%s'" % name, "alternatives": alts}
        song = self._song()
        if track is not None and 0 <= track < len(song.tracks):
            t = song.tracks[track]
            song.view.selected_track = t
            # aim at the first EMPTY clip slot so we don't overwrite an existing clip
            try:
                target_scene = None
                for si, cs in enumerate(t.clip_slots):
                    if not cs.has_clip:
                        target_scene = si
                        break
                if target_scene is None:
                    song.create_scene(-1)
                    target_scene = len(song.scenes) - 1
                song.view.selected_scene = song.scenes[target_scene]
            except Exception:
                pass
        loaded_name = best.name
        self._browser().load_item(best)
        return {"ok": True, "loaded": loaded_name, "score": score, "alternatives": alts,
                "note": "dropped onto track %s — fire its clip to hear it" % str(track)}

    # ---- record the master (or any signal) to an audio clip so the AI can capture the mix ----
    def _capture_track(self):
        song = self._song()
        for t in song.tracks:
            if t.name == self._capture_name:
                return t
        song.create_audio_track(-1)
        t = song.tracks[len(song.tracks) - 1]
        try:
            t.name = self._capture_name
        except Exception:
            pass
        return t

    def _set_resampling(self, track):
        try:
            for rt in track.available_input_routing_types:
                if "resampl" in str(rt.display_name).lower():
                    track.input_routing_type = rt
                    return True
        except Exception:
            pass
        return False

    def _record_master(self, bars):
        song = self._song()
        cap = self._capture_track()
        routed = self._set_resampling(cap)   # capture the MASTER bus (everything you hear)
        try:
            cap.arm = True
        except Exception as e:
            return {"ok": False, "error": "couldn't arm capture track: " + str(e)}
        try:
            song.record_mode = 1             # arrangement record
        except Exception:
            pass
        try:
            if not song.is_playing:
                song.start_playing()
        except Exception:
            pass
        try:
            beats_per_bar = song.signature_numerator or 4
        except Exception:
            beats_per_bar = 4
        try:
            self._stop_at = song.current_song_time + bars * beats_per_bar
        except Exception:
            self._stop_at = None
        return {"ok": True, "recording": True, "track": cap.name, "bars": bars,
                "resampling": routed, "willAutoStop": self._stop_at is not None,
                "note": "recording the master into the '%s' track%s" % (
                    cap.name, " — will stop automatically" if self._stop_at is not None else " — call stop_record when done")}

    def _do_stop_record(self):
        self._stop_at = None
        song = self._song()
        info = {"ok": True, "stopped": True}
        try:
            song.record_mode = 0
        except Exception:
            pass
        try:
            song.stop_playing()
        except Exception:
            pass
        try:
            cap = None
            for t in song.tracks:
                if t.name == self._capture_name:
                    cap = t
                    break
            if cap is not None:
                cap.arm = False
                # report the captured arrangement clip + its audio file if we can find it
                try:
                    clips = []
                    for ck in cap.arrangement_clips:
                        fp = getattr(ck, "file_path", None)
                        clips.append({"name": ck.name, "file": fp, "length": ck.length})
                    info["captured"] = clips
                except Exception:
                    pass
        except Exception:
            pass
        return info

    def _stop_record(self):
        return self._do_stop_record()

    def _diag(self):
        out = {"ok": True, "liveVersion": self._live_version()}
        b = self._browser()
        cats = ["instruments", "sounds", "drums", "audio_effects", "midi_effects",
                "plugins", "max_for_live", "packs", "samples", "user_library"]
        out["browserCategories"] = [c for c in cats if getattr(b, c, None) is not None]

        def sample(catname, n=8):
            root = getattr(b, catname, None)
            if root is None:
                return []
            names = []
            for nm, _it in self._iter_loadable(root, limit=2000):
                if nm not in names:
                    names.append(nm)
                if len(names) >= n:
                    break
            return names

        out["audioEffectsSample"] = sample("audio_effects")
        out["instrumentsSample"] = sample("instruments")
        rb, _s, _a = self._search("audioEffect", "Reverb")
        out["reverbFound"] = (rb.name if rb is not None else False)

        song = self._song()
        tracks = []
        first_params = None
        for i, t in enumerate(song.tracks):
            devnames = []
            for dvc in t.devices:
                devnames.append(dvc.name)
            try:
                ttype = "midi" if t.has_midi_input else "audio"
            except Exception:
                ttype = "?"
            tracks.append({"index": i, "name": t.name, "type": ttype, "devices": devnames})
            if first_params is None and len(t.devices) > 0:
                dv = t.devices[0]
                first_params = {"track": i, "device": dv.name,
                                "params": [self._param_dict(k, p) for k, p in enumerate(dv.parameters)]}
        out["tracks"] = tracks
        out["firstDeviceParams"] = first_params
        return out

    def disconnect(self):
        self._running = False
        try:
            self._unlisten(self._struct)
            self._unlisten(self._song_l)
        except Exception:
            pass
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        try:
            ControlSurface.disconnect(self)
        except Exception:
            pass
