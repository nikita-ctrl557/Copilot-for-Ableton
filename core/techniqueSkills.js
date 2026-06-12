// techniqueSkills.js — the PRODUCTION TECHNIQUES canon: the named moves every
// working producer reaches for, written as executable recipes against the
// copilot's actual tools (stock devices + set_device_param / set_modulation /
// write_automation / sends). technique_skill(name) fetches one; searching by
// what the user is trying to achieve works too ("wider", "pump", "glue"…).
// The learned layer (sound_recipe) sits on top for researched additions.

const T = (name, aka, when, recipe) => ({ name, aka, when, recipe });

const TECHNIQUES = [
  T("parallel compression", ["new york compression", "upward thickness"],
    "drums or bass feel thin when compressed hard but lifeless when not",
    ["duplicate signal path via a RETURN: send the drum bus to a return with a Compressor crushing 8–12dB GR, fast attack, fast release", "blend the return ~6–10dB under the dry bus — punch stays, body doubles", "stock shortcut: Compressor/Glue Dry/Wet at 40–60% on the bus itself"]),
  T("sidechain reverb", ["ducked space"],
    "you want huge reverb that never washes the groove",
    ["reverb on a RETURN, big decay 4–8s", "Compressor AFTER the reverb on that return, sidechained from the dry lead/vocal (or kick), 4–8dB duck, release ~150ms", "the space blooms only in the gaps — loud verb, dry groove"]),
  T("haas widening", ["stereo delay trick"],
    "an element needs width without losing punch (pads, chops, hats — never bass/kick)",
    ["duplicate or use a stereo Delay: one side delayed 10–25ms, no feedback, 100% wet on that side", "keep below ~30ms or it reads as an echo; CHECK MONO after (it can comb) — stock: Delay with L 0ms / R 15ms, link off"]),
  T("gated reverb", ["80s snare", "phil collins snare"],
    "a snare/clap should sound enormous but stop dead",
    ["big Reverb (2–4s) on the snare, 100% wet on a return or generous dry/wet", "Gate after it, threshold so the tail CUTS ~150–250ms after the hit, fast release", "tune gate hold to the groove gap"]),
  T("reverb pre-delay pocket", ["vocal clarity verb"],
    "vocals/leads need space but sit IN the reverb mud",
    ["set reverb Pre-delay 20–40ms so the dry transient lands BEFORE the wash", "high-pass the reverb return ~300Hz, low-pass ~8k", "the source stays in front, the tail behind"]),
  T("808 glide", ["tuned slides"],
    "trap/drill bass should slide between roots",
    ["overlap consecutive 808 notes slightly and enable Glide/portamento on the instrument (Operator/Drift: Glide on, ~60–120ms)", "slides land ON grid at the destination note", "keep the 808 TUNED (tuning check) — slides expose detune instantly"]),
  T("white noise riser", ["sweep up"],
    "every 8/16-bar transition needs lift",
    ["Wavetable/Operator noise (or load_sound 'noise sweep')", "write_automation: filter cutoff rising over the last 2–4 bars + volume swell", "add a crash ON the downbeat; cut the riser EXACTLY at the 1"]),
  T("tape stop", ["slowdown fx"],
    "a section should die dramatically into the next",
    ["lom: clip pitch automation down 12–24 st over the last half-bar, or a Delay's rate dive", "easiest stock: automate a device's Freq/pitch macro falling fast + volume fade in the same half-bar"]),
  T("dub delay throw", ["send echo throw"],
    "one word/stab should echo into space once, not constantly",
    ["synced Delay (3/16 or dotted 8th) on a RETURN, feedback 40–60%, high-pass the return", "AUTOMATE the send: 0 except a spike on the syllable/stab you want thrown", "classic on vocals, chord stabs, snare fills"]),
  T("mid-side master eq", ["m/s width sculpt"],
    "the master needs air and width without losing the center",
    ["EQ Eight in M/S mode: SIDE high-shelf +1–2dB above 8k (air gets wider)", "SIDE high-pass below 120Hz (lows stay mono)", "MID slight 2–4k presence if the lead is buried"]),
  T("pumping pads", ["sidechain everything"],
    "french-house / festival pump feel",
    ["Kickstart (or Auto Pan trick / volume automation pump) on pads+bass, rate 1/4", "depth: pads can duck HARD (6–10dB), bass moderate (3–5dB)", "release recovers fully before the next kick"]),
  T("formant vocal chop", ["vocal chops"],
    "modern house/future hooks from a vocal phrase",
    ["slice the vocal to a Drum Rack or Simpler (slice mode)", "play SHORT slices rhythmically (16th cells), transpose ±2–5 st for melody", "no warp-stretch artifacts? keep slices short; add delay throw + small room"]),
  T("low-pass intro", ["filter open"],
    "DJ-friendly intro that blooms into the drop",
    ["Auto Filter low-pass on the MASTER or drum bus, start ~400Hz", "write_automation: cutoff opens to full across the intro 8–16 bars", "remove/bypass at the drop — never leave a closed filter on the master"]),
  T("ghost kick rumble", ["sub rumble bed"],
    "techno/dark rooms: the kick needs a tail that fills the floor",
    ["duplicate the kick to its own track, BIG reverb 100% wet, low-pass at ~100Hz", "sidechain the rumble FROM the dry kick (duck on every hit)", "the gap between hits fills with tuned rumble"]),
  T("snare layering", ["composite snare"],
    "the snare lacks crack or body and one sample won't fix it",
    ["layer 2–3: one LOW body (150–250Hz), one CRACK (2–5k), one CLAP/texture", "align transients (nudge ms), high-pass the upper layers", "glue with a bus compressor 2–3dB; flip a layer's phase if hollow"]),
  T("call and response", ["arrangement dialogue"],
    "the loop feels static even with good elements",
    ["alternate: lead phrase bars 1–2, answer (different instrument/octave) bars 3–4", "mute the lead during the answer (rests are the trick)", "write_melody twice with different seeds/registers and interleave"]),
  T("drop everything but", ["mute drama"],
    "the cheapest powerful transition in dance music",
    ["last bar before the drop: mute EVERYTHING except vocal/one element (arrange gap)", "or kill the kick for 2 bars (breakdown defined by absence)", "silence > any riser when overused elsewhere"]),
  T("octave bass layer", ["sub + mid split"],
    "bass audible on phones AND heavy in the club",
    ["sub layer: sine/triangle octave 1, mono, clean", "mid layer: same notes +12, saturated (Roar/Saturator), character lives here", "high-pass the mid layer ~80Hz, sidechain both together"]),
  T("vinyl lo-fi bed", ["dust and noise"],
    "lo-fi/boom-bap texture instantly",
    ["load_sound 'vinyl crackle' on its own track at -25…-35dB", "low-pass the whole keys bus 6–10k, slight detune/wobble (chorus rate 0.1Hz)", "Roar/Redux a TOUCH on the drum bus — subtle is the rule"]),
  T("stutter fill", ["retrigger edit"],
    "the last beat before a section needs an edit, not a fill",
    ["duplicate the last 1/4 of the loop clip, slice it to 1/16 retriggers (write_notes repeating the same hit)", "pitch or filter rises across the stutters", "classic on vocals and snares"]),
  T("automated wobble rate", ["talking bass"],
    "dubstep/bass music movement that talks",
    ["LFO→filter via set_modulation, deep (0.5–0.8)", "AUTOMATE the LFO Rate per bar: 1/4 → 1/8 → 1/16 → 1/3 triplet", "rate changes ARE the riff — write them like a melody"]),
  T("texture pad under drop", ["glue noise"],
    "the drop feels empty between hits despite being loud",
    ["quiet (-30dB) noise/air pad sustaining under the whole drop", "sidechained with everything else — it breathes", "nobody hears it; everyone misses it when muted"]),
  T("pre-drop vocal tail", ["reverse swell"],
    "transition into the drop needs a human cue",
    ["reverse a vocal phrase (or sample), place the swell across the last 2 beats", "big reverb, rising send automation", "cut everything at the 1 — drop hits dry"]),
];

function norm(s) { return String(s || "").toLowerCase().trim(); }

function get(name) {
  const q = norm(name);
  if (!q) return null;
  const exact = TECHNIQUES.find((t) => norm(t.name) === q)
    || TECHNIQUES.find((t) => t.aka.some((a) => norm(a) === q))
    || TECHNIQUES.find((t) => norm(t.name).includes(q) || q.includes(norm(t.name)) || t.aka.some((a) => norm(a).includes(q) || q.includes(norm(a))))
    || TECHNIQUES.find((t) => norm(t.when).includes(q));
  if (exact) return exact;
  // problem-search: stem-tolerant token match ("wider" hits "width"/"widening") —
  // a query token matches when it shares a 4+ char prefix with any haystack word
  const qWords = q.split(/\s+/).filter((w) => w.length >= 4);
  if (!qWords.length) return null;
  let best = null, bestHits = 0;
  for (const t of TECHNIQUES) {
    const hay = (norm(t.name) + " " + t.aka.map(norm).join(" ") + " " + norm(t.when)).split(/[^a-z0-9]+/);
    const hits = qWords.filter((w) => hay.some((h) => h.length >= 4 && (h.startsWith(w.slice(0, 4)) || w.startsWith(h.slice(0, 4))))).length;
    if (hits > bestHits) { bestHits = hits; best = t; }
  }
  return bestHits ? best : null;
}

function list() { return TECHNIQUES.map((t) => ({ name: t.name, when: t.when })); }

module.exports = { TECHNIQUES, get, list };
