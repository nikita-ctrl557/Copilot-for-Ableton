// deviceSkills.js — per-device "skill" knowledge so Claude programs a device with
// understanding instead of blindly. Each skill explains what the parameters DO and
// gives sound recipes. At runtime Claude ALSO calls get_device_params to get the
// exact param names/indices/min/max on the user's version, then maps recipe -> real
// params. Returned by the device_skill tool.

const SKILLS = {
  wavetable: `WAVETABLE (Ableton synth, internal class_name "InstrumentVector"). "Editing the wave" = TWO moves you MUST actually do, not filter tweaks: (A) PICK which wavetable (category + table), then (B) MOVE the wavetable POSITION to morph the wave shape. The position is the fader you slide left/right of the waveform display ("slide through the wave"). It is an automatable PARAMETER (a knob), so you set it with set_device_param — that is the literal "edit the wave by sliding it" control. Choosing the table is a PROPERTY (set_device_property). Get both right or the user sees "nothing changed."
STEP 0 — ALWAYS run dump_device FIRST. It returns the real PARAMETERS (exact names + min/max on this Live version) AND a "selectors" block (oscillator_wavetable_categories, oscillator_1_wavetables, current osc settings). The Wt Pos parameter's NAME varies by version — do NOT guess it; FIND it in the dump (see step B).
STEP A — PICK THE WAVETABLE (PROPERTIES, set with set_device_property — these go through the Python loader, which CAN set them even though v8/LOM lists them observe-only). VALUES ARE INTEGER ENUM INDICES, not strings:
- oscillator_1_wavetable_category THEN oscillator_1_wavetable_index (and _2_): set CATEGORY FIRST, then index (index is relative to the chosen category, so order matters). Read the indices from dump_device's selectors.oscillator_wavetable_categories and selectors.oscillator_1_wavetables. e.g. to get a saw: find the category whose name fits (e.g. "Basics"/"Analog") and the table named like "Saw"/"Sawtooth", set category index then that table index. An out-of-range or string value is silently ignored (that's the usual "nothing changed").
- oscillator_1_effect_mode / oscillator_2_effect_mode: int (0=None,1=FM,2=Classic,3=Modern).
- unison_mode (int) + unison_voice_count (int): engage + widen unison. filter_routing: 0=Serial,1=Parallel,2=Split. mono_poly: 0=Mono (bass),1=Poly. poly_voices (int).
STEP B — MORPH THE WAVE = MOVE THE WAVETABLE POSITION (PARAMETER, set with set_device_param). THIS is what the user means by "edit the wave by sliding it":
- In dump_device's params, find the position knob by name — it is the param whose name contains "Pos" for that oscillator, typically "Osc 1 Wt Pos" / "Oscillator 1 Wavetable Position" / "Osc 1 Pos" (the exact string is version-dependent — match on "Pos"). There's a matching one for Osc 2.
- Read its min/max from the dump (commonly 0..1, sometimes 0..100). Set it with set_device_param to a value INSIDE that range: e.g. min = first/origin wave, mid (e.g. 0.5 or 50) = a wave halfway through the table, max = the last wave. To "slide through the wave" for a different timbre, just set a different position value — e.g. start 0.0, then try 0.25 / 0.5 / 0.75 and keep the one that sounds right. ALWAYS confirm the returned changed:true; if it didn't change you matched the wrong param (e.g. a macro or "Osc 1 On") — re-find the "Pos" param in the dump.
- For animated movement over time, raise an LFO/Env amount targeting the position in Wavetable's own mod matrix; but the direct timbre move the user is asking for is simply set_device_param on the Wt Pos parameter.
SHORTCUT FOR A SPECIFIC NAMED TIMBRE (supersaw, etc.): you may instead LOAD a matching preset (load_instrument "supersaw"/"saw lead"/"sub bass" pulls a real .adv) THEN fine-tune below — but if the user said "edit/morph the wave," still do STEP B and actually move the Wt Pos.
OTHER PARAMETERS (set_device_param — the knobs, these always work):
- Oscillators: "Osc 1 On", "Osc 1 Transpose" (semitones), "Osc 1 Detune", "Osc 1 Gain" (the Wt Pos is the morph knob from STEP B).
- Unison (this is what makes a SUPERSAW): set the oscillator effect to Unison, then raise the unison Amount/Detune and Voices. More detune + voices = wider, lusher saw.
- Filter: "Filter 1 Frequency" (cutoff, Hz — read min/max), "Filter 1 Resonance", "Filter 1 Type" (Lowpass/Highpass/Bandpass). High cutoff = bright; low = dark/sub. (Filter is TONE, NOT the wave shape — do not substitute a filter tweak for moving the Wt Pos.)
- Amp envelope: "Env Amp Attack/Decay/Sustain/Release" (sec). Filter envelope: "Filter 1 Env Attack/Decay/Sustain/Release" + "Filter 1 Freq < Env" (how far the envelope opens the filter).
- "Sub Level"/"Osc 2" for adding weight or width.
RECIPES (after dump_device: do STEP A pick-table + STEP B move-Wt-Pos, then set these via set_device_param):
- Supersaw / hypersaw lead: STEP A pick a Saw wavetable (category+index); STEP B set Osc 1 Wt Pos LOW (~0.0–0.2 of its range, the pure-saw end); Unison ON with high Detune + many Voices; Filter Lowpass, Frequency HIGH (~8–12 kHz), low Resonance; Amp Attack ~0, Sustain full, Release ~0.2–0.4 s; play octave 4–5. Add Osc 2 detuned ±5–12 ct. A little reverb/delay send.
- Deep sub bass: STEP A pick a Sine/Basic wavetable; STEP B set Osc 1 Wt Pos to the pure-sine end (min); Unison OFF (mono); Filter Lowpass Frequency LOW (~120–400 Hz), low reso; Amp Attack 0, short Decay/Release; octave 1. No movement.
- Reese bass: STEP A saw/basic wavetable; STEP B set Osc 1 Wt Pos to a MID value (~0.4–0.6) for the grittier morphed wave; two detuned oscillators, slight unison, Filter Lowpass with some Resonance and slow LFO/Env on cutoff; octave 1–2.
- "Morph/edit the wave" request (no other spec): dump_device, pick any table (STEP A), then SWEEP Osc 1 Wt Pos — set it to ~0.0, then ~0.5, then ~1.0 of its range, confirming changed:true each time, and report the values so the user hears the wave move.
- Pluck: Amp Attack 0, Decay ~0.15–0.3 s, Sustain 0, short Release; Filter Env Amount positive with Attack 0 so it snaps open then closes; moderate Resonance.
- Warm pad: Amp Attack ~0.4–1 s, Release ~1–2 s; mild Unison detune; Filter mid; reverb send high.`,

  operator: `OPERATOR (Ableton FM synth). get_device_params first. 4 operators A/B/C/D each with Coarse (ratio), Fine, Level, and an envelope; an Algorithm sets which operators modulate which.
- Algorithm: choose how ops stack (parallel = additive/organ-ish; series = FM brightness).
- Carrier vs modulator: the operator routed to output is the carrier; ones feeding it are modulators. Modulator Level = FM amount = brightness/edge.
- Coarse ratios: integer ratios (1,2,3) = harmonic/musical; non-integer = inharmonic/metallic.
RECIPES: e-piano = 2 ops, modulator ratio 1, moderate level, fast decay; bell = inharmonic ratios (e.g. 1 : 3.5) + long release; bass = single carrier + 1 modulator low level, fast env, low octave; FM lead = higher modulator level, bright.`,

  "eq eight": `EQ EIGHT (Ableton EQ), 8 bands. Params per band look like "<n> Frequency A", "<n> Gain A", "<n> Resonance A" (=Q), "<n> Filter Type A", "<n> Filter On A" (n = 1..8). get_device_params, find the band's names, then set. Use the set_eq_band convenience tool which does this for you (freq in Hz, gain in dB, q = resonance).
USES: high-pass everything non-bass ~30–120 Hz (low-cut filter type); cut mud 200–500 Hz; vocal presence +2–4 dB ~3–5 kHz (bell); de-harsh cut −3–6 dB ~4–7 kHz with Q ~6; air high-shelf +2–3 dB ~10 kHz.`,

  compressor: `COMPRESSOR (Ableton). Stock Compressor params are often NORMALIZED 0..1 (read min/max!); Glue Compressor are real units. Use the set_compressor convenience tool. Params: Threshold (dB, where it starts compressing), Ratio (amount), Attack (ms — fast catches transients, slow lets them through), Release (ms — auto is safe), Knee, Makeup/Output gain, Dry/Wet.
RECIPES: vocal level control = ratio 3–4:1, threshold so 3–6 dB reduction, medium attack ~10 ms, auto release; drum punch = fast-ish attack, quick release, ratio 4:1; bus glue (Glue) = ratio 2:1, slow attack (10–30 ms), auto release, ~1–3 dB reduction.`,

  reverb: `REVERB (Ableton). Params: "Decay Time" (ms/s — length of tail), "Dry/Wet" (blend), "Predelay" (ms — gap before reverb, keeps clarity), "Diffusion", "Room Size", "Lo/Hi shelf" for tone. Put on a RETURN track and use sends, not inline, for shared space.
RECIPES: vocal plate = decay ~1.5–2.5 s, predelay 20–40 ms, dry/wet 100% on the return; big space pad = long decay 4 s+; drum room = short decay 0.4–0.8 s.`,

  delay: `DELAY (Ableton). Params: "L/R Time" or beat-synced division, "Feedback" (repeats), "Dry/Wet", "Sync" on/off, filtering. On a return for sends.
RECIPES: 1/4 or 1/8 dotted synced delay, feedback ~30–45%, dry/wet to taste; ping-pong via L≠R; filter the repeats darker so they don't clutter.`,

  saturator: `SATURATOR (Ableton). Adds harmonics/warmth/drive. Params: "Drive" (amount), "Dry/Wet", waveshaper type, output. Gentle drive = analog warmth; high = aggressive. Great on bass for harmonics so it reads on small speakers, and as bus glue.`,

  utility: `UTILITY (Ableton). Gain (dB), width (stereo), mono bass, DC filter, mid/side. Use for clean level changes, narrowing the low end to mono, or width on pads.`,

  glue: `GLUE COMPRESSOR (Ableton, real units). Threshold dB, Ratio (2/4/10), Attack ms, Release ms (or Auto), Makeup, Dry/Wet, Range, Soft clip. Classic bus glue: ratio 2:1, slow attack 10–30 ms, Release Auto, threshold for 1–3 dB reduction.`,
};

// CHARACTER_RECIPES — translate a VIBE/ADJECTIVE the user says ("make it thick / warm
// / aggressive") into an ORDERED list of concrete parameter moves expressed in REAL
// Ableton param/property names. Values are researched defaults; at runtime ALSO read the
// device's actual min/max with get_device_params/dump_device and clamp to range, then
// set_device_param / set_device_property. Cutoff Hz assumes a Lowpass filter on a synth.
// Each recipe is a SHORT ordered list — do the moves top-to-bottom, confirm changed:true.
const CHARACTER_RECIPES = {
  thick: {
    aka: ["fat", "huge", "big", "wide", "phat", "beefy"],
    target: "bass/lead",
    why: "Thick = more energy across the spectrum + width: a low octave, several slightly-detuned voices, a sub/lower layer, and saturation harmonics — while the filter stays open enough to keep those harmonics audible. Width on the top, MONO on the bottom so the sub stays solid.",
    moves: [
      "Drop pitch: Osc 1 Transpose -12 (or play octave 1) so the fundamental is low.",
      "Engage unison: unison_mode Classic (property), unison_voice_count 4–6, then unison/Osc Detune ~12–20 cents (subtle — wide enough to thicken, not so wide it phases/loses mono).",
      "Add a lower layer: turn Osc 2 On, make it a Sine/Basic, Osc 2 Transpose -12 (one octave below Osc 1), Osc 2 Gain to taste — this is the sub weight. (Or raise 'Sub Level' if the synth has one.)",
      "Keep harmonics: Filter 1 Type Lowpass but Filter 1 Frequency fairly OPEN ~2–6 kHz (do NOT close it to a dull sub — thick still has midrange bite), Filter 1 Resonance low ~5–15%.",
      "Saturate for harmonics+glue: append a Saturator after the synth, Drive ~6–12 dB, gentle waveshaper (Soft Sine/Analog Clip), Dry/Wet 100% — this is what makes it read on small speakers.",
      "Lock the low end mono: add a Utility, set Width 0% below ~120 Hz (Utility 'Bass Mono'/'Mono Frequency' ~120 Hz) so the sub is centred and punchy.",
      "Amp env: Attack 0, Sustain high, short-to-medium Release ~0.2 s so notes are solid, not plucky."
    ]
  },
  warm: {
    aka: ["smooth", "vintage", "round", "mellow", "analog"],
    target: "any",
    why: "Warm = strong low-mids, rolled-off highs, gentle even-harmonic saturation, slight detune/drift. Subtractive, never harsh.",
    moves: [
      "Filter 1 Type Lowpass, Frequency ~1–3 kHz (roll off fizz), Resonance low (~0–10%).",
      "Slight movement off: little/no Filter Env amount; if there's drift/analog detune, add ~3–8 cents.",
      "Saturator Drive low ~3–6 dB, soft/tube curve, Dry/Wet ~50–80% for even harmonics.",
      "EQ Eight: high-shelf -2…-3 dB ~8–10 kHz; small low-mid bell +1.5–3 dB ~200–400 Hz for body.",
      "Amp env: a touch of Attack (~5–20 ms) and longer Release so notes are rounded, not clicky."
    ]
  },
  bright: {
    aka: ["crisp", "shiny", "sparkly", "airy", "open"],
    target: "any",
    why: "Bright = harmonics present and high-end lifted. Open the filter, add a positive filter envelope, add a high shelf / 'air'.",
    moves: [
      "Filter 1 Frequency HIGH ~8–14 kHz (or filter type Off) so harmonics pass.",
      "Positive Filter Env: Filter 1 Freq < Env up, Filter Env Attack 0 so it snaps open per note.",
      "Prefer Saw over Sine (set a Saw wavetable) — more harmonics to brighten.",
      "EQ Eight high-shelf +2–3 dB ~10–12 kHz (air); optional presence bell +2 dB ~3–5 kHz.",
      "If thin, keep some body with a low-mid; brightness should add, not hollow it out."
    ]
  },
  dark: {
    aka: ["muffled", "moody", "underwater", "dub", "subby", "closed"],
    target: "any",
    why: "Dark = remove high harmonics, emphasise lows. Close the filter, kill air, lean to sine.",
    moves: [
      "Filter 1 Type Lowpass, Frequency LOW ~300–800 Hz, Resonance low so there's no whistle.",
      "Filter Env amount near 0 (no bright snap).",
      "Prefer Sine/Triangle wavetable over Saw (fewer harmonics).",
      "EQ Eight high-shelf -3…-6 dB ~6 kHz; optional small high-cut ~8 kHz.",
      "Soft amp Attack (~10–30 ms) to take the edge off transients."
    ]
  },
  punchy: {
    aka: ["snappy", "tight", "hard-hitting", "transient", "knocky"],
    target: "bass/drum/lead",
    why: "Punch = a strong fast transient then a quick settle. Drive the front with envelopes + compression, keep the body short.",
    moves: [
      "Amp env: Attack 0, short Decay ~80–200 ms, moderate Sustain, short Release — accent the hit.",
      "Filter Env with Attack 0 + small positive Decay so the filter 'thwacks' open then closes.",
      "Compressor AFTER: ratio ~4:1, Attack ~10–30 ms (let the transient through), fast Release ~80–150 ms, 3–6 dB reduction.",
      "Optional Saturator Drive ~4–8 dB for harmonics that read the hit on small speakers.",
      "EQ Eight small bump +2–3 dB ~80–120 Hz (weight) and/or ~2–4 kHz (attack click)."
    ]
  },
  plucky: {
    aka: ["pluck", "stab", "short", "staccato", "percussive"],
    target: "lead/chord/bass",
    why: "Pluck = an instant snap that decays to silence with no sustain — driven by the FILTER envelope, not just amp.",
    moves: [
      "Amp env: Attack 0, Decay ~150–300 ms, Sustain 0, short Release ~50–150 ms.",
      "Filter 1 Lowpass with Resonance moderate ~20–35%; Filter Env Attack 0, Decay ~120–250 ms, Sustain 0, Freq < Env strongly positive so it snaps open then shuts.",
      "Base Filter Frequency fairly low so the env sweep is audible.",
      "A little reverb/delay SEND so the short notes have space (dry/wet on a return).",
      "Keep it monophonic-feeling: don't overlap notes."
    ]
  },
  reese: {
    aka: ["growl", "neuro", "dnb bass", "movement"],
    target: "bass",
    why: "Reese = two (or more) detuned saw oscillators beating against each other + slow filter movement. The classic Reese sound (named after Kevin Saunderson) is detuned saws.",
    moves: [
      "Two Saw oscillators: Osc 1 + Osc 2 On, both Saw. Octave 1–2.",
      "Detune them against each other: Osc 1 +0.10…+0.30 semitone, Osc 2 -0.10…-0.30 semitone (subtle ~5–10 ct beats; aggressive/neuro ~15–50 ct).",
      "unison_mode Classic, unison_voice_count ~4 + a little extra Detune for thickness.",
      "Filter 1 Lowpass, Frequency ~400–900 Hz, Resonance ~20–40% so movement is audible.",
      "Slow filter movement: LFO -> Filter 1 Frequency, LFO Rate slow (~1/2…1 bar or 0.2–1 Hz) — the 'wobble'.",
      "Keep sub solid: Utility mono below ~120 Hz; optional layered pure sine sub for low-end that survives detune."
    ]
  },
  hollow: {
    aka: ["woody", "nasal", "reedy", "pwm", "clarinet"],
    target: "any",
    why: "Hollow = odd-harmonic / narrow-pulse character (square/PWM, or remove even harmonics). Think clarinet / vintage square lead.",
    moves: [
      "Use a Square/Pulse wavetable (or Operator: single sine pair). Square = odd harmonics = hollow.",
      "If pulse width is available, set a narrow width and/or LFO -> pulse width ~slow for movement (PWM).",
      "Filter 1 Lowpass moderate ~1–2 kHz, low resonance.",
      "EQ Eight: small cut ~300–600 Hz can exaggerate the nasal/woody quality.",
      "Keep it mono and dry for that vintage square-lead tone."
    ]
  },
  aggressive: {
    aka: ["dirty", "gritty", "harsh", "distorted", "screaming", "edm"],
    target: "bass/lead",
    why: "Aggressive = lots of harmonics + heavy drive/distortion + resonance bite, often layered. Push everything that adds upper harmonics.",
    moves: [
      "Saw oscillators, unison_voice_count high (6–8) with Detune ~20–40 cents for a thick detuned wall.",
      "Filter 1 Frequency fairly open + Resonance moderate-high ~30–50% for a resonant edge.",
      "Heavy Saturator/Overdrive: Drive ~12–24 dB, harder waveshaper (Hard Clip), Dry/Wet 100%.",
      "Optional second distortion stage (Overdrive or Erosion) for extra grit; EQ Eight to tame any harsh ~3–5 kHz spike with a -3 dB bell, Q~6.",
      "Fast envelopes (Attack 0) so it bites immediately; a little Filter Env snap.",
      "Layer: stack a sub sine an octave down so the aggression doesn't lose low-end weight."
    ]
  },
};

// GENRE_PALETTES — a STYLE recipe: which synth/instrument per role, which wavetable/
// algorithm, filter, and an effects chain, with concrete starting values. These are
// starting points — combine with CHARACTER_RECIPES and confirm real param names first.
const GENRE_PALETTES = {
  "deep house": {
    tempo: "120–124 BPM",
    bass: "Operator or Analog, SINE/near-sine, mono, octave 1, Amp Attack 0 short Decay, Lowpass ~200–500 Hz — round 'organ' sub. Offbeat rhythm (write_bassline pick 'offbeat').",
    chords: "Wavetable or Operator electric-piano/organ stab: sine + a 5th, octave 3, short stab. 7th/9th colour chords. Reverb + slap delay sends + light Saturator.",
    lead: "Soft Rhodes/keys, sparse — accents, not every beat.",
    fx: "EQ Eight (HPF non-bass ~30 Hz, slight low-mid warmth) -> Glue Compressor 2:1 slow attack -> Reverb send (plate ~1.8 s) + 1/8-dotted Delay send. Subtle saturation everywhere.",
    feel: "Warm, rounded, lots of space. Use CHARACTER_RECIPES.warm. Sidechain pads/bass to kick."
  },
  "uk garage": {
    tempo: "130–135 BPM, shuffled/swung drums (this genre IS allowed swing)",
    bass: "Detuned 'reese'-ish SUB: Wavetable sine/saw, often 2–3 oscillators slightly detuned, octave 1; sometimes a SLOW filter or pitch ATTACK (Filter Env Attack ~30–80 ms) so it works with the shuffle. Keep sub mono.",
    chords: "Organ/Rhodes stabs, garage skippy rhythm, octave 3, 7th/9th colour.",
    lead: "Chopped vocal-style or simple bright stab.",
    fx: "EQ Eight -> light Saturator on bass -> Glue on drums. Sidechain bass to kick.",
    feel: "Skippy, swung, bouncy. Use CHARACTER_RECIPES.thick on the sub but keep it tight."
  },
  "2010 festival": {
    tempo: "126–130 BPM",
    lead: "SUPERSAW: Wavetable Saw table, unison_mode Classic, unison_voice_count 7, Detune ~15–25 cents (Illenium/Avicii style ~15% amount), Filter Lowpass OPEN ~8–12 kHz low reso, Amp Attack 0 Sustain full Release ~0.2–0.4 s, octave 4–5. Optionally Osc 2 +7 semitones for a shimmering 5th.",
    chords: "Same supersaw playing wide chord stabs, or a separate plucky layer.",
    bass: "Simple sine/saw sub, octave 1, sidechained HARD to the kick (pumping is the genre signature).",
    fx: "EQ Eight (HPF the saw ~120–200 Hz so it doesn't fight the sub) -> Reverb send (big, ~2.5–4 s) + 1/4 or 1/8-dotted Delay send -> Glue/limiter on master. Heavy sidechain pump.",
    feel: "Big, bright, euphoric, wide. Use CHARACTER_RECIPES.bright + .thick."
  },
  trap: {
    tempo: "130–150 BPM (half-time feel)",
    bass: "808: a sine-based sub with PITCH GLIDE — Operator/Wavetable sine, mono, Glide/Portamento ~80–120 ms, overlap notes for slides, octave 1. Add Saturator/Overdrive Drive low-to-moderate so it reads on phone speakers; longer Decay/Release for the booming tail.",
    drums: "Real Drum Rack 808/trap kit, rolling hats (triplet/32nd rolls), hard snare/clap on beat 3.",
    lead: "Dark bells/keys (Operator inharmonic-ish), pluck or muted.",
    fx: "On 808: EQ Eight (tame ~300 Hz mud) -> Saturator -> mono below ~120 Hz. Master limiter.",
    feel: "Dark, spacious, sub-heavy. Use CHARACTER_RECIPES.dark + .thick on the 808; glide is essential."
  },
  "lo-fi": {
    tempo: "70–90 BPM",
    keys: "Soft Rhodes/Juno-ish keys: Wavetable/Operator sine-ish, slight Detune ~5–10 cents, Lowpass ~1.5–3 kHz (roll off highs), gentle Attack. Jazzy 7th/9th chords, octave 3.",
    bass: "Round upright/sine bass, mono, octave 1–2, very dark Lowpass ~300–500 Hz.",
    fx: "Effects rack: Chorus-Ensemble (Vibrato on, slow) for tape WOW/FLUTTER -> Saturator (Soft/Hard curve, gentle) for grit -> EQ Eight high-cut ~6–8 kHz to dull it -> add vinyl crackle/noise sample. Optional Bitcrusher/Redux very subtle. Reverb send small + dark.",
    feel: "Warm, dusty, imperfect, mono-ish. Use CHARACTER_RECIPES.warm + .dark. Slight detune/pitch drift is the point."
  },
};

// Fuzzy-match a character word/genre to a recipe.
function getCharacter(name) {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return null;
  if (CHARACTER_RECIPES[n]) return { word: n, recipe: CHARACTER_RECIPES[n] };
  for (const key of Object.keys(CHARACTER_RECIPES)) {
    const r = CHARACTER_RECIPES[key];
    if (n.indexOf(key) >= 0 || (r.aka || []).some((a) => n.indexOf(a) >= 0 || a.indexOf(n) >= 0)) {
      return { word: key, recipe: r };
    }
  }
  return null;
}

function getGenre(name) {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return null;
  if (GENRE_PALETTES[n]) return { genre: n, palette: GENRE_PALETTES[n] };
  for (const key of Object.keys(GENRE_PALETTES)) {
    const stripped = key.replace(/[^a-z]/g, "");
    const nStripped = n.replace(/[^a-z]/g, "");
    if (n.indexOf(key) >= 0 || key.indexOf(n) >= 0) return { genre: key, palette: GENRE_PALETTES[key] };
    // letters-only compare, but only when both sides have letters (so "808" doesn't match "")
    if (nStripped && stripped && (nStripped.indexOf(stripped) >= 0 || stripped.indexOf(nStripped) >= 0)) {
      return { genre: key, palette: GENRE_PALETTES[key] };
    }
  }
  // common aliases
  const alias = { festival: "2010 festival", edm: "2010 festival", "big room": "2010 festival", ukg: "uk garage", garage: "uk garage", "deep-house": "deep house", house: "deep house", lofi: "lo-fi", "lo fi": "lo-fi", "chill hop": "lo-fi", "hip hop": "trap", "hip-hop": "trap", "808": "trap" };
  if (alias[n] && GENRE_PALETTES[alias[n]]) return { genre: alias[n], palette: GENRE_PALETTES[alias[n]] };
  return null;
}

// Fuzzy-match a device/skill name to a skill.
function getSkill(name) {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return null;
  if (SKILLS[n]) return { device: n, skill: SKILLS[n] };
  for (const key of Object.keys(SKILLS)) {
    if (n.indexOf(key) >= 0 || key.indexOf(n) >= 0 || key.split(" ")[0] === n.split(" ")[0]) return { device: key, skill: SKILLS[key] };
  }
  // aliases
  const alias = { wt: "wavetable", "eq8": "eq eight", "eq": "eq eight", comp: "compressor", glue2: "glue", verb: "reverb" };
  if (alias[n] && SKILLS[alias[n]]) return { device: alias[n], skill: SKILLS[alias[n]] };
  return null;
}

module.exports = {
  SKILLS,
  getSkill,
  list: () => Object.keys(SKILLS),
  CHARACTER_RECIPES,
  GENRE_PALETTES,
  getCharacter,
  getGenre,
  listCharacters: () => Object.keys(CHARACTER_RECIPES),
  listGenres: () => Object.keys(GENRE_PALETTES),
};
