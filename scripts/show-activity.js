#!/usr/bin/env node
// show-activity.js — print the agent's recent actions and their REAL results, so you can
// see exactly what it did under the hood (which params changed, what loaded, what was
// silent) instead of trusting its prose.
//   node scripts/show-activity.js        # last 40 actions
//   node scripts/show-activity.js 100    # last 100
const { read, FILE } = require("../core/activityLog");
const n = parseInt(process.argv[2], 10) || 40;
const lines = read(n);
console.log("════════════════════════════════════════════════════════════════");
console.log(" Claude Copilot — what the agent ACTUALLY did (" + FILE + ")");
console.log("════════════════════════════════════════════════════════════════");
if (!lines.length) { console.log(" (nothing logged yet — run a request in the Ableton chat first)"); process.exit(0); }
for (const l of lines) console.log(l);
console.log("");
console.log("Legend:  'NO CHANGE' = the param didn't move (wrong name / already there).");
console.log("         '⚠ SILENT' = the track made no sound.   '✗ ERROR' = the tool failed.");
