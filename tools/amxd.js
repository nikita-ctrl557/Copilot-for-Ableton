// amxd.js — pack/unpack Max for Live .amxd devices.
// Container: ampf(LE32 ver, devcode) | meta(LE32 size, LE32 val) | ptch(LE32 size, payload)
// ptch payload: "mx@c" + BE32(16) + BE32(0) + BE32(mxVal) | JSON | \n\0 | dlst(...)
// Format reverse-engineered from Ableton maxdevtools; cross-checked byte-for-byte
// against a real device (Max PeakLimiter_.amxd) and ktamas77/js2max.

const DEVICE_TYPE_CODES = {
  "audio-effect": "aaaa",
  "midi-effect": "mmmm",
  instrument: "iiii",
};

const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };

function tlv(tag, data) {
  return Buffer.concat([Buffer.from(tag, "ascii"), be32(8 + data.length), data]);
}
const tlvU32 = (tag, val) => tlv(tag, be32(val));
function tlvStr(tag, s) {
  const enc = Buffer.from(s, "ascii");
  const pad = (4 - (enc.length % 4)) % 4;
  return tlv(tag, Buffer.concat([enc, Buffer.alloc(pad)]));
}

function makeDlst(filename, jsonByteSize) {
  const dire = tlv("dire", Buffer.concat([
    tlvStr("type", "JSON"),
    tlvStr("fnam", filename),
    tlvU32("sz32", jsonByteSize + 2), // json + \n\0
    tlvU32("of32", 16),               // mx@c header size
    tlvU32("vers", 0),
    tlvU32("flag", 0x11),             // 17, matches working files
    tlvU32("mdat", 0),                // modification stamp; 0 loads fine
  ]));
  return tlv("dlst", dire);
}

// patch: a JS object (the .maxpat). deviceType: audio-effect|midi-effect|instrument.
function buildAmxd(patch, deviceType = "audio-effect", filename = "device.amxd", metaVal = 4) {
  const jsonBytes = Buffer.from(JSON.stringify(patch, null, "\t"), "utf-8");
  const separator = Buffer.from([0x0a, 0x00]); // \n\0
  const mxVal = jsonBytes.length + separator.length + 16;
  const mxHeader = Buffer.concat([Buffer.from("mx@c", "ascii"), be32(16), be32(0), be32(mxVal)]);
  const ptch = Buffer.concat([mxHeader, jsonBytes, separator, makeDlst(filename, jsonBytes.length)]);

  return Buffer.concat([
    Buffer.from("ampf", "ascii"), le32(4), Buffer.from(DEVICE_TYPE_CODES[deviceType], "ascii"),
    Buffer.from("meta", "ascii"), le32(4), le32(metaVal),
    Buffer.from("ptch", "ascii"), le32(ptch.length), ptch,
  ]);
}

// Parse an .amxd back into { version, deviceCode, metaVal, mxVal, patch, filename }.
function parseAmxd(buf) {
  let o = 0;
  const tag = (n = 4) => buf.toString("ascii", o, (o += n));
  const u32le = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  if (tag() !== "ampf") throw new Error("not an amxd (no ampf)");
  const version = u32le();
  const deviceCode = tag();
  if (tag() !== "meta") throw new Error("no meta chunk");
  const metaSize = u32le();
  const metaVal = u32le();
  if (tag() !== "ptch") throw new Error("no ptch chunk");
  const ptchSize = u32le();
  const ptchStart = o;
  if (buf.toString("ascii", o, o + 4) !== "mx@c") throw new Error("no mx@c header");
  const jsonStart = ptchStart + 16; // mx@c + 3 BE32
  // JSON runs until the \n\0 separator that precedes "dlst"
  const dlstIdx = buf.indexOf("dlst", jsonStart, "ascii");
  const jsonEnd = dlstIdx >= 0 ? dlstIdx - 2 : ptchStart + ptchSize;
  const json = buf.toString("utf-8", jsonStart, jsonEnd);
  return { version, deviceCode, metaSize, metaVal, ptchSize, patch: JSON.parse(json), rawJson: json };
}

module.exports = { buildAmxd, parseAmxd, DEVICE_TYPE_CODES };

// CLI: node amxd.js validate <real.amxd>   |   node amxd.js info <file.amxd>
if (require.main === module) {
  const fs = require("fs");
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "info" || cmd === "validate") {
    const buf = fs.readFileSync(file);
    const p = parseAmxd(buf);
    console.log(`deviceCode=${p.deviceCode} version=${p.version} metaVal=${p.metaVal} ptchSize=${p.ptchSize} jsonBytes=${p.rawJson.length}`);
    console.log(`patcher boxes: ${p.patch?.patcher?.boxes?.length ?? "?"}`);
    if (cmd === "validate") {
      // Re-pack the parsed patch and confirm our framing reproduces a parseable file
      const rebuilt = buildAmxd(p.patch, { aaaa: "audio-effect", mmmm: "midi-effect", iiii: "instrument" }[p.deviceCode], file.split("/").pop(), p.metaVal);
      const rp = parseAmxd(rebuilt);
      const jsonMatch = JSON.stringify(rp.patch) === JSON.stringify(p.patch);
      console.log(`re-pack parses: ${!!rp.patch}  json round-trips: ${jsonMatch}  rebuilt size: ${rebuilt.length}`);
    }
  } else {
    console.log("usage: node amxd.js info|validate <file.amxd>");
  }
}
