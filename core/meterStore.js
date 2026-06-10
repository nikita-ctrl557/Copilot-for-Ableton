// meterStore.js — in-process store of the latest per-track audio metrics pushed by
// ClaudeMeter devices. webui.js writes (on POST /meter); tools.js reads (get_track_audio).
// Same node process, so a module singleton connects them with no round-trip into v8.
// Index encoding matches metertrack.js / the remote script: 0.. = regular tracks,
// -1 = MASTER, -2 - r = RETURN r. Anything <= -900 is the "unknown" sentinel.
//
// Beyond the LATEST snapshot it also keeps:
//   - a per-track ACTIVITY TIMELINE (which beats of the song the track is audible at,
//     from the meter's plugsync~ song position) → activity(track) = "plays bars 1–8, 17–24"
//   - a per-track COMMAND QUEUE (recording start/stop) drained by the meter device
//     through the POST /meter response body.
const byTrack = new Map();   // trackIndex -> { peak, rms, peakDb, rmsDb, ts, ... }
const timelines = new Map(); // trackIndex -> Map(halfBeatBucket -> maxPeakDb)
const cmdQueues = new Map(); // trackIndex -> [cmd, ...]

const lin2db = (x) => (x > 0.0000001 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);

// turn the 4 band amplitudes into a plain-language character read (what the agent uses
// to judge thick/thin/bright/dark/muddy from the live meter — no recording needed).
function bandCharacter(bands) {
  if (!bands) return null;
  const low = +bands.low || 0, lm = +bands.lowmid || 0, mid = +bands.mid || 0, high = +bands.high || 0;
  const total = low + lm + mid + high || 1e-9;
  const lowRatio = (low + lm) / total, midRatio = mid / total, highRatio = high / total;
  const labels = [];
  if (low + lm + mid + high < 0.0008) labels.push("silent/near-silent");
  else {
    if (lowRatio > 0.55) labels.push("thick/weighty (strong low end)");
    else if (lowRatio < 0.2) labels.push("thin (weak low end)");
    if (highRatio > 0.3) labels.push("bright");
    else if (highRatio < 0.05 && lowRatio > 0.4) labels.push("dark");
    if (midRatio > 0.5 && highRatio < 0.08) labels.push("muddy/boxy (mid build-up, no air)");
  }
  return {
    lowDb: lin2db(low), lowmidDb: lin2db(lm), midDb: lin2db(mid), highDb: lin2db(high),
    lowRatio: Math.round(lowRatio * 100) / 100, highRatio: Math.round(highRatio * 100) / 100,
    summary: labels.join(", ") || "balanced",
  };
}

const AUDIBLE_DB = -48;
const MAX_BUCKETS = 8192; // ~17 min of 4/4 at half-beat resolution — plenty, bounded

function set(track, m) {
  if (track == null || !Number.isFinite(+track) || +track <= -900) return; // sentinel/garbage only — master (-1) and returns (-2…) are welcome
  track = +track;
  const peakDb = m.peak != null ? lin2db(m.peak) : null;
  byTrack.set(track, {
    track,
    peak: m.peak, rms: m.rms,
    peakDb,
    rmsDb: m.rms != null ? lin2db(m.rms) : null,
    lufs: m.lufs != null ? m.lufs : null,
    bands: m.bands || null,
    character: bandCharacter(m.bands), // plain-language spectral read
    playing: m.playing != null ? !!m.playing : undefined,
    beat: m.beat != null ? Math.round(m.beat * 100) / 100 : undefined,
    ts: Date.now(),
  });
  // ACTIVITY TIMELINE: while the transport runs, remember how loud this track was at
  // this song position (half-beat buckets, max-held) — that's how the agent knows the
  // track "plays bars 1–8, 17–24" instead of only hearing the last few seconds.
  if (m.playing && m.beat != null && Number.isFinite(+m.beat) && +m.beat >= 0 && peakDb != null) {
    let tl = timelines.get(track);
    if (!tl) { tl = new Map(); timelines.set(track, tl); }
    const bucket = Math.round(+m.beat * 2) / 2;
    const prev = tl.get(bucket);
    if (prev == null || peakDb > prev) tl.set(bucket, peakDb);
    if (tl.size > MAX_BUCKETS) { const first = tl.keys().next().value; tl.delete(first); }
  }
}

// stale spectral data must never be graded as current — entries expire after 6s
const MAX_AGE_MS = 6000;
function fresh(e) { return e && (Date.now() - (e.ts || 0)) < MAX_AGE_MS ? e : null; }
function get(track) { return fresh(byTrack.get(track)); }
function all() { return Array.from(byTrack.values()).filter(fresh).sort((a, b) => a.track - b.track); }
function clear() { byTrack.clear(); }

// ---- activity: where in the song does this track actually play? ----
// Returns null if no timeline yet; else { bars: "1–8, 17–24", ranges:[{fromBeat,toBeat}],
// coveredBeats, observedBeats, observedUpToBar } (bars assume 4/4 — close enough for a
// readable map; beat values are exact).
function activity(track) {
  const tl = timelines.get(track);
  if (!tl || !tl.size) return null;
  const buckets = [...tl.entries()].sort((a, b) => a[0] - b[0]);
  const ranges = [];
  let cur = null, covered = 0;
  for (const [beat, peakDb] of buckets) {
    const audible = peakDb > AUDIBLE_DB;
    if (audible) {
      covered += 0.5;
      if (cur && beat - cur.toBeat <= 1.01) cur.toBeat = beat;
      else { cur = { fromBeat: beat, toBeat: beat }; ranges.push(cur); }
    }
  }
  const lastObserved = buckets[buckets.length - 1][0];
  const bar = (b) => Math.floor(b / 4) + 1;
  const bars = ranges.map((r) => (bar(r.fromBeat) === bar(r.toBeat) ? "bar " + bar(r.fromBeat) : "bars " + bar(r.fromBeat) + "–" + bar(r.toBeat))).join(", ");
  return {
    bars: bars || "(never audible so far)",
    ranges: ranges.map((r) => ({ fromBeat: r.fromBeat, toBeat: r.toBeat })),
    coveredBeats: covered,
    observedBeats: Math.round(buckets.length * 0.5),
    observedUpToBar: bar(lastObserved),
  };
}
function clearTimelines(track) {
  if (track != null) timelines.delete(+track);
  else timelines.clear();
}

// ---- recording command queue (drained via the POST /meter response) ----
function queueCmd(track, cmd) {
  track = +track;
  if (!cmdQueues.has(track)) cmdQueues.set(track, []);
  cmdQueues.get(track).push(cmd);
}
function popCmd(track) {
  const q = cmdQueues.get(+track);
  return q && q.length ? q.shift() : null;
}
// flush stale commands (a dead meter never drains its queue — without this, old
// rec open/start/stop triples replay whenever that meter comes back)
function clearCmds(track) {
  if (track != null) cmdQueues.delete(+track);
  else cmdQueues.clear();
}
function meteredTracks() { return [...byTrack.keys()].sort((a, b) => a - b); } // every track a meter has EVER reported for (not freshness-gated)

module.exports = { set, get, all, clear, activity, clearTimelines, queueCmd, popCmd, clearCmds, meteredTracks, AUDIBLE_DB };
