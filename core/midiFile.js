// midiFile.js — Standard MIDI File parser (format 0/1), pure Node. Turns a .mid
// into the same note shape the writing tools use ({pitch, start, duration,
// velocity} in BEATS), so the user can drop chord packs / MIDI folders into the
// copilot and have any file land in a clip. Handles variable-length quantities,
// running status, merged multi-track timing, tempo map (informational — note
// times are in beats, which is what Live clips want anyway).

function parseMidi(buf) {
  if (buf.length < 14 || buf.toString("ascii", 0, 4) !== "MThd") throw new Error("not a MIDI file");
  const format = buf.readUInt16BE(8);
  const nTracks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI not supported");
  const tpq = division || 480; // ticks per quarter note

  let p = 14;
  const tracks = [];
  for (let t = 0; t < nTracks && p + 8 <= buf.length; t++) {
    if (buf.toString("ascii", p, p + 4) !== "MTrk") { // skip unknown chunk
      p += 8 + buf.readUInt32BE(p + 4);
      t--;
      continue;
    }
    const len = buf.readUInt32BE(p + 4);
    tracks.push({ start: p + 8, end: p + 8 + len });
    p += 8 + len;
  }

  const notes = [];
  let tempoBpm = null, name = null, timeSig = null;
  for (const tr of tracks) {
    let q = tr.start, tick = 0, running = 0;
    const open = new Map(); // pitch -> {tick, velocity}
    const readVar = () => {
      let v = 0, b;
      do { b = buf[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && q <= tr.end);
      return v;
    };
    while (q < tr.end) {
      tick += readVar();
      let status = buf[q];
      if (status & 0x80) { q++; if (status < 0xf0) running = status; }
      else status = running; // running status reuses the previous status byte
      const type = status & 0xf0;
      if (type === 0x90 || type === 0x80) {
        const pitch = buf[q++], vel = buf[q++];
        if (type === 0x90 && vel > 0) {
          if (!open.has(pitch)) open.set(pitch, { tick, velocity: vel });
        } else {
          const o = open.get(pitch);
          if (o) {
            open.delete(pitch);
            notes.push({ pitch, start: o.tick / tpq, duration: Math.max(1 / 32, (tick - o.tick) / tpq), velocity: o.velocity });
          }
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) q += 2;
      else if (type === 0xc0 || type === 0xd0) q += 1;
      else if (status === 0xff) { // meta
        const meta = buf[q++], len = readVar(), at = q;
        if (meta === 0x51 && len === 3 && tempoBpm == null) tempoBpm = Math.round(60000000 / ((buf[at] << 16) | (buf[at + 1] << 8) | buf[at + 2]));
        else if (meta === 0x58 && len >= 2 && !timeSig) timeSig = [buf[at], Math.pow(2, buf[at + 1])];
        else if (meta === 0x03 && !name && len) name = buf.toString("utf8", at, at + Math.min(len, 60)).replace(/[^\x20-\x7e]/g, "");
        q = at + len;
      } else if (status === 0xf0 || status === 0xf7) { const len = readVar(); q += len; }
      else q++; // unknown — skid one byte rather than abort the whole file
    }
    // close any hanging notes at track end
    for (const [pitch, o] of open) notes.push({ pitch, start: o.tick / tpq, duration: 0.25, velocity: o.velocity });
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  return {
    notes, format, tpq,
    tempoBpm: tempoBpm || null, timeSig: timeSig || [4, 4], name: name || null,
    bars: Math.max(1, Math.ceil(lastEnd / 4)),
    pitchRange: notes.length ? [Math.min(...notes.map((n) => n.pitch)), Math.max(...notes.map((n) => n.pitch))] : null,
  };
}

module.exports = { parseMidi };
