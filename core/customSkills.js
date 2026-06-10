// customSkills.js — USER-AUTHORED skills: named text/markdown files the user
// imports, writes or edits in the settings panel (⚙ → Skills). House rules,
// reference notes ("my kick chain", "label X mix spec"), personal recipes.
// They live at ~/.claude-copilot/skills/<name>.md, their NAMES are injected into
// PROJECT STATE every turn, and the custom_skill tool reads them on demand.
// USER SKILLS OUTRANK BUILT-IN SKILLS when they conflict — they're the user's law.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".claude-copilot", "skills");

function ensure() { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} }
function safeName(n) {
  const s = String(n || "").replace(/\.(md|txt)$/i, "").replace(/[^a-zA-Z0-9 _-]+/g, "").trim().slice(0, 60);
  return s || null;
}
function fileFor(name) { return path.join(DIR, name + ".md"); }

function list() {
  ensure();
  try {
    return fs.readdirSync(DIR)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .map((f) => {
        const p = path.join(DIR, f);
        let st = null; try { st = fs.statSync(p); } catch {}
        return { name: f.replace(/\.(md|txt)$/i, ""), bytes: st ? st.size : 0, updated: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

function get(name) {
  const n = safeName(name);
  if (!n) return null;
  // exact, then case-insensitive / fuzzy contains
  for (const ext of [".md", ".txt"]) {
    try { return { name: n, content: fs.readFileSync(path.join(DIR, n + ext), "utf8") }; } catch {}
  }
  const q = n.toLowerCase();
  for (const s of list()) {
    if (s.name.toLowerCase() === q || s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) {
      try { return { name: s.name, content: fs.readFileSync(fileFor(s.name), "utf8") }; } catch {}
    }
  }
  return null;
}

function save(name, content) {
  const n = safeName(name);
  if (!n) return { ok: false, error: "bad skill name" };
  ensure();
  try {
    fs.writeFileSync(fileFor(n), String(content || ""), { mode: 0o600 });
    return { ok: true, name: n };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function remove(name) {
  const n = safeName(name);
  if (!n) return { ok: false, error: "bad skill name" };
  let removed = false;
  for (const ext of [".md", ".txt"]) {
    try { fs.unlinkSync(path.join(DIR, n + ext)); removed = true; } catch {}
  }
  return { ok: removed, name: n, ...(removed ? {} : { error: "no such skill" }) };
}

module.exports = { list, get, save, remove, DIR };
