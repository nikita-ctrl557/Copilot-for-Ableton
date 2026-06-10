// metertrack.js — track-index reader for ClaudeMeter (a [v8] object).
// Fired by [live.thisdevice] at load, then SELF-REFRESHES every 5 seconds: track
// indexes SHIFT when the user (or the agent) adds/deletes/reorders tracks, and a
// stale index would attribute this meter's data — and its recording commands — to
// the wrong track. One path read every 5s is negligible (no audio-rate work).
// Outputs "trackindex N" to the meter's node sender, only when the value changes.
// Index encoding (must match the remote script's _track_obj):
//   "live_set tracks N …"        → N            (regular track)
//   "live_set return_tracks R …" → -2 - R       (return A = -2, B = -3, …)
//   "live_set master_track …"    → -1           (master)
//   unknown                      → -999 sentinel (sender drops it)
autowatch = 0;
inlets = 1;
outlets = 1;

var last = -1000; // never-sent marker (distinct from the -999 sentinel)
var poll = new Task(readIndex, this);

function readIndex() {
  var idx = -999;
  try {
    var d = new LiveAPI("this_device");
    var path = String(d.unquotedpath || d.path || "");
    var r = path.match(/return_tracks (\d+)/); // check FIRST: "return_tracks 0" also contains "tracks 0"
    if (r) idx = -2 - parseInt(r[1], 10);
    else if (/master_track/.test(path)) idx = -1;
    else {
      var m = path.match(/(?:^|\s)tracks (\d+)/);
      if (m) idx = parseInt(m[1], 10);
    }
  } catch (e) { idx = -999; }
  if (idx !== last) { last = idx; outlet(0, "trackindex", idx); }
}

function bang() {
  readIndex();
  poll.interval = 5000;
  poll.repeat(); // keep following track moves for the device's lifetime
}
