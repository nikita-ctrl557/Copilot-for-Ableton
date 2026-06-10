// elementSkills.js — per-ELEMENT production skills (kick, bass, lead…): what a
// finished element must satisfy (checklist), how to MEASURE each point with the
// agent's listening tools, and the concrete FIXES for every common failure.
// This is the "select the right skill for the task" layer the user asked for:
// run the production checklist → listen to the element → critique it against its
// skill → apply the documented fix → re-listen. deviceSkills covers DEVICES
// (what Wavetable's knobs do); this covers the MUSICAL ROLE on top.
//
// Conventions the fixes rely on:
// - tuning info comes from analyze_clip / analyze_audio_file / analyze_recordings
//   ({tuning: {nearestNote, centsOff, inTune, semitonesToRoot, fix}} vs the DETECTED key)
// - Drum Rack pads host a Simpler per pad: retune via its 'Transpose' (semitones)
//   and 'Detune' (cents) parameters (find the pad's chain device with dump_device).

const ELEMENTS = {
  kick: {
    role: "the foundation — its tuning and length decide whether the whole low end works",
    checklist: [
      "IN TUNE with the song key: the kick's fundamental must sit on the ROOT of the key (or the fifth), within ±30 cents. MEASURE: record_tracks → analyze_recordings (the kick row's `tuning`), or analyze_clip on a kick audio clip. A kick 40 cents off in G minor reads as 'something feels wrong' even when nobody can name it.",
      "LENGTH fits the tempo: the tail must end before the next hit needs space — club/techno ≈ 250–400ms decay, faster genres shorter; a 4-on-the-floor kick that rings into the next kick smears the groove.",
      "PUNCH intact: the first 5–15ms transient must survive — no compressor with a fast attack flattening it.",
      "OWNS 40–90Hz ALONE: the bass is sidechained or carved there; two elements both full-level at 50Hz = mud, not power.",
      "LEVEL: typically the loudest single element — peaks around -8…-6 dBFS while the mix has headroom.",
      "MONO low end: no stereo width below ~120Hz on the kick.",
    ],
    diagnose: {
      "out of tune (tuning.inTune false / centsOff beyond ±30)": [
        "RETUNE in place: the kick pad's Simpler → set_device_param 'Transpose' by tuning.semitonesToRoot semitones, then 'Detune' to kill the remaining cents — re-record/analyze to confirm inTune:true",
        "or REPLACE: list_browser category:'drums' and pick a kick sampled in/near the key, or a kick with a cleaner fundamental, then re-check tuning",
        "or REBUILD: synthesize one (Operator sine pitch-enveloped down to the root note's frequency) when no sample fits",
      ],
      "too short / no body": [
        "lengthen the amp envelope Decay/Release on the pad's Simpler (or the kick synth)",
        "layer a tuned sine sub (root note, ~100–250ms) under the transient, glued with light saturation",
      ],
      "too long / boomy tail": [
        "shorten Decay; high-pass the kick's own rumble below ~30Hz",
        "check it's the kick and not the room of the sample — a tighter sample beats surgery",
      ],
      "no punch / soft attack": [
        "compressor attack 10–30ms (lets the transient pass) or bypass the squashing device (device_onoff)",
        "add a click layer (short high-passed transient sample) at low level",
      ],
      "doesn't sit / fights the bass": [
        "sidechain the bass to the kick (compressor on bass, sidechain from kick, 2–4dB duck, fast attack, release timed to the gap)",
        "decide the split: kick owns 40–60Hz and bass starts above (high-pass bass ~60–80Hz), or the reverse — never both full-range",
      ],
    },
  },

  bass: {
    role: "harmonic + rhythmic engine of the low end — locks to the kick and the chords",
    checklist: [
      "IN KEY: every note in the song's key; root movement follows the chord progression (write_bassline guarantees this — hand-placed lines must be checked against the chords).",
      "LAYER REGISTERS — the DEFAULT for layered bass (not a law): SUB layer = octave 1 (clean sine/triangle, roots only); MAIN/character layer = ONE OCTAVE UP (octave 2, same notes +12), carrying the saturation/movement while the sub stays clean and mono. Both layers piled into the same low octave is the classic muddy 'too low' bass — but REFERENCES OVERRIDE THIS: some styles deliberately stack lower or wider (a named artist/track? research their actual approach and match it). What's non-negotiable is that you AUDITION the layered result and judge it, not where each layer sits. Single-layer bass: octave 1–2 (MIDI ~28–47); above that it's a melody.",
      "TUNED SUB: if there's a separate sub layer, its fundamental sits on the root (tuning check, same as the kick).",
      "PROCESSED BY DEFAULT — a raw synth into the mixer is unfinished: EQ (high-pass the rumble <30Hz, cut mud 200–400Hz if present) → COMPRESSION (2–4dB GR, medium attack, evens the line out) → SATURATION/DRIVE (Saturator, or Roar for multi-stage drive + its subtle NOISE injection — a touch of dirt/noise/soft clip is the analog vibe). Every bass you design ships with this chain dialed in.",
      "KICK RELATIONSHIP: sidechained to the kick or rhythmically interlocked (offbeat bass never collides with a 4-floor kick).",
      "MONO below ~120Hz; width only in the upper harmonics.",
      "AUDIBLE ON SMALL SPEAKERS: saturation/harmonics so the line reads even where the sub doesn't reproduce.",
    ],
    diagnose: {
      "whole bass sits too low / one muddy lump": ["raise the MAIN/character layer one octave (+12 on its clip or 'Transpose' on the synth) — the sub stays at octave 1; this is the #1 layered-bass mistake", "then audition: a main bass peaks ≈ -8…-12dB in the mix"],
      "clashes with the kick": ["sidechain (2–4dB duck) or move the line to the offbeats ('offbeat'/'rolling' styles)", "carve: high-pass the bass at the kick's fundamental, or dip the bass 2–3dB at that exact Hz"],
      "out of key / wrong notes": ["rewrite with write_bassline passing the SAME chords/key as the chord track — it locks to the roots", "if it's audio, retune (Simpler Transpose) or re-record"],
      "weak / thin": ["unison + slight detune on the mids, sine sub layer an octave down, Saturator drive 6–12dB with dry/wet", "open the low-pass — a choked filter is the #1 thin-bass cause"],
      "muddy": ["cut 200–400Hz 2–4dB", "shorten note releases so tails don't overlap", "mono the lows (Utility 'Bass Mono')"],
      "inaudible on laptop speakers": ["add saturation/overdrive for harmonics at 700Hz–2kHz", "layer a mid 'growl' an octave up at low level"],
    },
  },

  snare_clap: {
    role: "the backbeat — defines the groove's snap on 2 and 4 (or the genre's variant)",
    checklist: [
      "PLACEMENT: on the genre's grid (house clap on 2/4; trap snare on 3; dnb 2&4 backbeat).",
      "CRACK: clear transient at 150–250Hz (body) + 2–5kHz (snap).",
      "TAIL: short enough not to wash the hats; reverb on a send, pre-delay so the crack stays dry.",
      "LAYERING: if layered (clap+snare), transients aligned to the sample, no comb-filtering (nudge or flip polarity if hollow).",
      "LEVEL: just under the kick, clearly above percussion.",
    ],
    diagnose: {
      "weak / no crack": ["transient shaper or comp with slow attack; +2–3dB shelf at 3–5kHz", "layer a clap over it, transients aligned"],
      "boxy": ["cut 400–700Hz a few dB", "shorten the sample decay"],
      "washes the mix": ["reverb to a send, lower send amount, pre-delay 20–40ms, decay under 1.2s", "gate the tail"],
      "hollow when layered": ["nudge one layer a few ms or flip its phase; re-check", "pick layers with different centers (one low crack, one high snap)"],
    },
  },

  hats_percussion: {
    role: "motion and air — the groove's subdivision lives here",
    checklist: [
      "DENSITY fits the genre (house offbeat 8ths; trap rolls; techno 16ths with accents).",
      "VELOCITY DYNAMICS: accented vs ghost hits — flat-velocity hats sound mechanical (write_drums does this; check hand-made patterns).",
      "NO HARSHNESS: energy above 8kHz present but not piercing (de-ess/low-pass if fatiguing).",
      "PANNING: percussion spread L/R for width, hats slightly off-center are fine; kick/snare stay center.",
      "LEVEL: hats sit UNDER the snare — loud hats are the most common amateur tell.",
    ],
    diagnose: {
      "mechanical / no groove": ["re-write with velocity dynamics (write_drums), or add velocity humanize", "swing ONLY if the user asked"],
      "harsh / fatiguing": ["EQ dip 3–6dB around 8–10kHz or a gentle low-pass at 14–16kHz", "swap the sample for a softer hat"],
      "cluttered": ["thin the pattern (remove every other ghost note)", "shorten open-hat decay so it closes before the next hit"],
    },
  },

  chords_pads: {
    role: "the harmony bed — colour and emotion, never mud",
    checklist: [
      "IN KEY and voice-led (write_chords handles this; check imported/hand chords).",
      "REGISTER: octave 3 center; no colour tones below ~MIDI 52 (low-interval mud).",
      "RHYTHM matches genre: offbeat stabs for house/garage, held pads only for ambient/trance.",
      "CARVED: high-passed below ~150–200Hz (the bass owns that), 2–4dB dip where the lead lives if they fight.",
      "SPACE: reverb/delay on sends; width OK here (pads can be wide, lows stay mono).",
    ],
    diagnose: {
      "muddy": ["high-pass at 150–200Hz", "drop colour tones below MIDI 52 (rewrite with write_chords — it enforces this)", "cut 250–400Hz a few dB"],
      "boring / static": ["add movement: slow filter LFO or write_automation on cutoff", "re-voice with richer extensions (enrich level 2) or a new progression preset"],
      "fights the lead": ["dip the pad 2–3dB in the lead's register (dynamic EQ if available)", "shorten stabs / lower pad level while the lead plays"],
      "wrong feel for the genre": ["re-write with the right rhythm: 'offbeat' stabs for house/tech-house/garage; 'held' only for ambient washes"],
    },
  },

  melody_lead: {
    role: "the hook — what a listener hums back",
    checklist: [
      "TONAL and IN KEY: clear pitches on a real scale (write_melody guarantees in-key, motif-based phrasing).",
      "MOTIF LOGIC: a repeating 1–2 bar idea with development (A A' B A''), not a random walk.",
      "REGISTER: octave 4–5, separated from chords (oct 3) and bass (oct 1).",
      "SPACE: rests between phrases; the lead breathes.",
      "LEVEL + PRESENCE: sits at -8…-14dB, presence 2–6kHz open, light delay/reverb send for size.",
      "MOVEMENT: vibrato/filter/automation somewhere — a totally static lead is dead.",
    ],
    diagnose: {
      "not memorable / rambling": ["regenerate with write_melody over the SAME chords (it builds motif-based hooks); try a few seeds and keep the best", "thin it: fewer notes, more rests, repeat the strongest bar"],
      "buried": ["raise 1–2dB, open presence (small shelf at 3kHz)", "dip the pads in the lead register", "double an octave up at low level"],
      "out of key notes": ["rewrite in the DETECTED key (LIVE NOW shows it)", "quantize stray pitches to the scale"],
      "static / lifeless": ["write_automation: filter or volume movement across phrases", "add subtle pitch vibrato (LFO→pitch, tiny amount) or a delay throw on phrase ends"],
    },
  },

  vocal: {
    role: "the human focal point — intelligibility first",
    checklist: [
      "IN KEY: detect_key on the vocal, confirm it matches the song's key (or retune/transpose the song decision).",
      "CLEAN: high-passed ~80–100Hz, de-essed 5–8kHz, resonances cut narrow.",
      "LEVEL-RIDDEN: compressed 3–6dB GR (or two gentle stages) so every word reads.",
      "SPACE without wash: pre-delayed reverb on a send + a tempo-synced delay; dry/wet kept low.",
      "SITS ON TOP: everything else dips slightly where the vocal lives (2–5kHz) when it plays.",
    ],
    diagnose: {
      "harsh": ["de-ess at the measured sibilant band; dip 3–6kHz 2–3dB with a wide Q"],
      "muddy / boomy": ["high-pass higher (100–120Hz); cut 200–350Hz"],
      "buried": ["more compression + 1dB up; carve the pads/lead at 2–5kHz", "automate a 1–2dB rise in busy sections"],
      "key mismatch with the track": ["detect_key from:'audio' on the vocal, compare with the song key, transpose the INSTRUMENTS or retune the vocal"],
    },
  },

  fx_transitions: {
    role: "glue between sections — risers, impacts, sweeps, ear candy",
    checklist: [
      "EVERY 8/16-bar boundary has SOMETHING: a riser into it, an impact on it, or a filter move through it.",
      "RISERS land ON the downbeat (end exactly at the section start).",
      "IMPACTS are high-passed enough not to fight the kick.",
      "REVERSE/sweep tails don't mask the lead.",
    ],
    diagnose: {
      "sections feel abrupt": ["add a riser the last 1–2 bars (load a sweep from the library, or automate a noise/filter rise) + an impact on the '1'"],
      "transitions cluttered": ["fewer elements: ONE riser + ONE impact beats five sweeps", "high-pass the FX layers"],
    },
  },

  sidechain: {
    role: "the pump — rhythmic ducking that makes the kick own the front and everything else breathe with it. A TECHNIQUE skill: decide WHERE it belongs, then pick the method you can actually execute.",
    checklist: [
      "WHEN TO USE — decide per element, don't blanket it: BASS→KICK is near-mandatory in any 4-on-the-floor genre (house/tech house/techno) — both live in the lows and the kick must win its 80ms. PADS/CHORDS→KICK when you want the classic pump feel (French house, big EDM) or when sustained chords mask the kick. REVERB/DELAY RETURNS→LEAD/VOCAL so the space ducks while the words play and blooms after. FX/ATMOS→KICK to keep wash out of the groove. DO NOT sidechain: the lead melody (rhythm gets seasick), hats/percussion (they occupy different spectrum), or anything in a genre that doesn't pump (most hip-hop, organic styles — there, duck only the bass slightly).",
      "HOW MUCH: glue = 2–4dB of duck (felt, not heard); pump-as-effect = 6–10dB (audibly breathing). Release sets the groove: time it to end just before the NEXT kick (at 124 BPM a quarter note is ~484ms → release ≈ 150–250ms for a tight pump).",
      "VERIFY by listening: audition the bass WITH the kick playing — the kick transient must be clearly in front; review_mix master character shouldn't read muddy in the lows anymore.",
    ],
    diagnose: {
      "method 0 — Kickstart (PREFERRED when installed, esp. for a bumpy/pumping track)": [
        "check for it: list_browser category:'plugins' filter:'Kickstart' (Kickstart 2 or 1 — either works)",
        "load it on the TARGET track (bass/pads — never the kick); its MIX/amount knob IS the pump depth (50–80% bumpy, 20–40% subtle), rate 1/4 — one knob, perfectly timed curves",
        "it's a VST: if no knobs are exposed, relay the Configure steps once, then set MIX via set_device_param",
      ],
      "method 1 — real compressor sidechain (best when you need keyed precision, needs one user click if routing fails)": [
        "load_audio_effect 'Compressor' on the TARGET track (the bass/pad — never on the kick)",
        "get_device_params → enable the sidechain section: set 'S/C On' to 1 (also try 'Sidechain On'); set 'S/C Gain' 0dB, ratio 4:1, attack 1–3ms, release 150–250ms, threshold until 3–6dB GR",
        "ROUTING: the external input (Audio From = kick track) usually can't be set via the API — if S/C params exist but no kick feeds it, tell the user: 'expand the Compressor (▸ triangle), set Audio From to the kick track, Post FX' — one click, then verify by ear",
      ],
      "method 2 — Auto Pan pump (no routing needed, 100% automatable)": [
        "load_audio_effect 'Auto Pan' on the target track",
        "set params: 'Amount' 70–100%, 'Rate Type'/sync to beats, 'Sync Rate' = 1/4 (each beat), 'Phase' 0° and 'Shape'/offset so BOTH channels duck together ON the beat and recover before the next (this is the classic ghost-sidechain trick — Auto Pan in mono-duck mode)",
        "audition WITH the kick: the duck must land exactly on the kick hit; nudge Phase if it pumps off-beat",
      ],
      "method 3 — volume-automation pump (works everywhere, sample-exact)": [
        "write_automation on the target track: param 'volume', points per beat: {time:0, value:dip}, {time:0.25, value:rising}, {time:0.9, value:full} repeated each beat of the clip — a drawn sidechain curve",
        "use for clips/sections where a device is overkill, or to pump a RETURN track",
      ],
      "pumping feels off / seasick": ["release too long — shorten so it fully recovers before the next kick", "duck depth too deep for the genre — glue wants 2–4dB only", "check the duck lands ON the kick (phase/attack)"],
    },
  },

  arrangement: {
    role: "the song on the TIMELINE — sections, tension and release, not an endless loop. Session clips are sketches; arrange_clip lays the actual song.",
    checklist: [
      "STRUCTURE EXISTS: the arrangement view has real sections, not one looping 4-bar cell. Standard club blueprint (bars, 4/4): INTRO 16 (kick+hats only, maybe filtered) → GROOVE A 16 (bass enters, percussion fills in) → BUILD 8 (riser, snare roll, filter opens) → DROP/MAIN 16–32 (everything in: bass+chords+lead) → BREAKDOWN 8–16 (kick OUT, pads/melody breathe, atmosphere) → BUILD 8 → DROP B 16–32 (variation: extra layer or new hook) → OUTRO 16 (strip back to drums — DJ-friendly). Trap/hip-hop: INTRO 8 → HOOK 16 → VERSE 16 → HOOK 16 → VERSE 16 → HOOK 16 → OUTRO 8. Scale to the brief.",
      "BEAT MATH: bar N starts at beat (N-1)*4 — arrange_clip times for a section at bars 17–32 = [64, 80, 96, 112] for a 4-bar clip. Lay EVERY element's clip at every section where it plays; absence is arrangement too (the breakdown is defined by the kick NOT being there).",
      "TRANSITIONS at every 8/16-bar boundary: riser/sweep INTO it, impact ON it, or an automation move THROUGH it (filter sweep via write_automation across the last 2 bars). A section change with nothing marking it sounds like a mistake.",
      "TENSION CURVE: each section either adds or removes energy on purpose — drop after build, space after density. Two identical adjacent sections = delete one or vary it (new seed, extra layer, octave lift).",
      "VERIFY: after arranging, record_tracks for the song length → analyze_recordings playsAt per track should MATCH the plan (kick absent exactly in the breakdown, bass from bar 17, …). If playsAt disagrees with the blueprint, fix the timeline.",
    ],
    diagnose: {
      "song is just a loop": ["pick the genre blueprint above, map each existing clip to its sections, lay them with arrange_clip at the right beat times, then add transitions"],
      "sections all sound the same": ["vary per section: drop an element, add one, change the drum seed, lift the lead an octave, open a filter — each section needs ONE clear difference"],
      "transitions feel abrupt": ["riser the last 2 bars + impact on the downbeat; write_automation a filter/volume sweep across the boundary"],
      "no energy curve": ["force the map: intro low → build rising → drop high → breakdown low → bigger drop — check each section moves the energy somewhere"],
    },
  },

  mixdown: {
    role: "the MIX PROCESS — balance first, surgery second, polish last. Run this whole sequence before any mastering move; a master can't fix a bad balance.",
    checklist: [
      "ORDER OF OPERATIONS (never skip ahead): (1) STATIC BALANCE — all faders, no FX changes: set the level pyramid below with set_mixer while review_mix is playing; (2) PAN MAP — kick/snare/bass/lead dead center, hats/percussion ±10–30%, pads/doubles wide; (3) CORRECTIVE EQ — cut what's wrong per track (mud 200–400Hz, boxiness 400–700Hz, harshness 2–5kHz), high-pass everything that isn't kick/bass/sub at 80–150Hz; (4) COMPRESSION where dynamics misbehave (uneven bass → 3–4dB GR; spiky percussion → transient taming); (5) SIDECHAIN per the sidechain skill; (6) SPACE — reverb/delay on RETURNS with sends, not inserts (one short room + one long verb + one synced delay is a full kit); (7) AUTOMATION rides for sections; (8) BUS GLUE last (drum bus 2:1 slow-attack 1–2dB).",
      "THE LEVEL PYRAMID (peak dB targets while the full mix plays, club genres): kick -6…-8 → bass/808 -8…-12 → snare/clap -8…-12 → lead/vocal -8…-14 → chords/pads -14…-18 → hats/perc -16…-20 → FX/atmos -18…-24. Verify with review_mix per track; a 'main element' under -26dB is a mistake, not a choice (audition flags tooQuiet).",
      "MASKING CHECK: the two most common fights are kick↔bass (40–100Hz — sidechain or carve) and lead↔pads (1–4kHz — dip the pads where the lead lives). analyze_recordings' low-end clash observation + per-track balance expose both.",
      "MONO + SMALL-SPEAKER CHECK: lows mono below ~120Hz (Utility); the mix must still make sense narrow — bass needs saturated mids to survive a phone speaker.",
      "HEADROOM INTO MASTERING: master bus peaking ≈ -6dB with NO limiter engaged yet; if you're already touching 0dB the balance is too hot — pull ALL faders down 4dB together, don't squash.",
      "REFERENCE DISCIPLINE: re-run review_mix after EVERY pass (recursive listening) and compare each track's measured character against its element_skill target; the genre's mixmaster line (genre_skill) sets the loudness/feel target.",
    ],
    diagnose: {
      "mix sounds cluttered / no separation": ["high-pass everything non-bass at 100–150Hz", "carve one 'pocket' per element (cut others 2–3dB where it lives)", "delete or mute elements that fail the 'is it NEEDED' test — density is not fullness"],
      "mix sounds small / weak": ["check the pyramid: usually the kick/bass are too quiet relative to a loud lead", "mono the lows, widen ONLY pads/doubles", "saturate the bass mids; glue the drum bus"],
      "can't hear an element that matters": ["raise it 1–2dB AND dip its masker 1–2dB at the clash frequency (find it via both tracks' balance from analyze_recordings)", "pan the masker slightly off-center instead of boosting"],
      "loud but lifeless": ["too much compression too early — back off bus GR to 1–2dB, restore transients (slower attacks)", "reintroduce dynamics with section automation (drop -1dB in verses)"],
      "great solo'd, bad together": ["mix decisions only count IN CONTEXT — re-balance with review_mix playing the FULL mix; never EQ a track solo'd"],
    },
  },

  master: {
    role: "the final chain — translation and loudness without killing dynamics. DEFAULT POSTURE: loud, polished and finished without being asked — think FOR the user (they want more than they say); only hold back if they explicitly say so.",
    checklist: [
      "ORDER: EQ → glue compressor → saturation → imaging/width → LIMITER LAST (get_device_chains verifies; move_device fixes; ClaudeMeter sits after everything as the ear, not processing).",
      "LIMITER CHOICE — prefer the high-end ones when installed (check chains/favorites/list_browser plugins): FabFilter Pro-L 2 first, iZotope Ozone Maximizer second, stock Limiter as the fallback. Then actually WORK it: drive 1–3dB GR (streaming) / 3–6dB (club), ceiling -0.3dBTP, and verify the measured level after.",
      "GLUE: 1–2dB of slow-attack bus compression (Buster SE / Glue Compressor), no pumping (unless the genre wants it).",
      "UTILITY ON THE MASTER by default: Bass Mono engaged somewhere 120–300Hz (to taste per track) — mono lows are non-negotiable for club playback.",
      "WIDTH where it sparkles: widen ONLY the highs (≈5–10kHz+) — EQ Eight in M/S mode with a Side high-shelf +1–2dB, or Ozone Imager's high band +20–30%. Never widen below ~120Hz.",
      "HEADROOM into the limiter ≈ -6dB peaks; ceiling -0.3dB.",
      "LOUDNESS to target: ≈ -14 LUFS streaming, -7…-9 club — measured, not guessed (analyze the master recording). Default LOUD and clean unless told otherwise.",
      "TONAL BALANCE: master spectrum has no missing/bloated band vs reference (analyze_recordings master row's balance).",
      "MONO CHECK: the mix survives mono (no vanishing lead/bass).",
    ],
    diagnose: {
      "limiter not last / chain disorder": ["move_device on the master (track -1) — limiter to the end, EQ before dynamics"],
      "lacks sparkle / top-end excitement": [
        "the low-triggered HIGH-LIFT trick: FabFilter Pro-MB on the master — band ≈7k–20k in upward-EXPANSION mode, range 2–6dB, the band's own sidechain/trigger filtered to ≈100–500Hz → every kick/bass hit lifts the air for a moment. Subtle = magic, obvious = wrong",
        "stock approximation: Multiband Dynamics, high band 'Above' ratio below 1:1 (upward expansion) — triggered by program energy rather than keyed lows, still adds the breathing top",
        "or simply a Side high-shelf +1–2dB (M/S EQ) if the mix just needs static air",
      ],
      "flat / lifeless after limiting": ["back the limiter off (lower input/raise ceiling), keep 1–2dB less loudness", "check the glue comp isn't over 3dB GR"],
      "harsh top": ["wide gentle cut 1–2dB around 3–8kHz on the master EQ, or fix the offending track instead (better)"],
      "weak low end on the master": ["fix at the SOURCE first (kick/bass balance), then a small low-shelf"],
    },
  },
};

// the run-through order the user described: foundation up, then the print
const CHECKLIST_ORDER = ["kick", "bass", "snare_clap", "hats_percussion", "chords_pads", "melody_lead", "vocal", "sidechain", "fx_transitions", "arrangement", "mixdown", "master"];

function getElement(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().replace(/[\s/-]+/g, "_");
  if (ELEMENTS[k]) return { element: k, ...ELEMENTS[k] };
  const alias = {
    drums: "kick", kickdrum: "kick", sub: "bass", "808": "bass", snare: "snare_clap", clap: "snare_clap",
    hats: "hats_percussion", hihat: "hats_percussion", hi_hat: "hats_percussion", percussion: "hats_percussion", perc: "hats_percussion",
    chords: "chords_pads", pad: "chords_pads", pads: "chords_pads", keys: "chords_pads",
    melody: "melody_lead", lead: "melody_lead", hook: "melody_lead", arp: "melody_lead",
    vocals: "vocal", vox: "vocal", fx: "fx_transitions", transitions: "fx_transitions", riser: "fx_transitions",
    mixbus: "master", mastering: "master", mix: "mixdown",
    side_chain: "sidechain", sidechaining: "sidechain", pump: "sidechain", ducking: "sidechain", duck: "sidechain",
    arrange: "arrangement", timeline: "arrangement", structure: "arrangement", song_structure: "arrangement",
    mixing: "mixdown", mix_down: "mixdown", balance: "mixdown", mix_and_master: "mixdown", levels: "mixdown",
  }[k];
  return alias ? { element: alias, ...ELEMENTS[alias] } : null;
}

function list() { return CHECKLIST_ORDER.slice(); }

// the full production run-through: per element, what to verify and which tool measures it
function fullChecklist() {
  return CHECKLIST_ORDER.map((k) => ({
    element: k,
    role: ELEMENTS[k].role,
    verify: ELEMENTS[k].checklist,
  }));
}

module.exports = { getElement, list, fullChecklist, CHECKLIST_ORDER };
