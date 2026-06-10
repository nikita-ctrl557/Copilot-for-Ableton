// genreSkills.js — the GENRE VOCABULARY: how melodies, basslines and chords
// actually behave in each genre, anchored by famous reference tracks, plus the
// genre's sound palette and mix/master targets. Each recipe maps straight onto
// the writing tools (write_chords romans/presets/rhythm, write_bassline styles,
// write_melody) so knowledge becomes concrete calls, not vibes.
// deviceSkills = what the knobs do; elementSkills = what finished elements need;
// THIS = what the GENRE sounds like, with examples a producer would name-check.

const GENRES = {
  "tech house": {
    bpm: "122–128",
    melodies: {
      character: "Minimal and percussive — short pitched stabs, vocal-chop hooks, one catchy 1-bar riff that trades with the bass. Long lead lines are rare; the hook is rhythmic.",
      examples: ["FISHER – Losing It (the whole hook is one bouncing synth riff)", "CamelPhat & Elderbrook – Cola (sparse vocal hook over stabs)", "Green Velvet & Patrick Topping – Voicemail (spoken vocal AS the hook)"],
      recipe: "write_melody over the same 1–2 chords, octave 4, then THIN it: keep 3–5 notes/bar max, rests on downbeats so it interlocks with the bass.",
    },
    bassline: {
      character: "THE lead instrument of the genre: syncopated 16th groove around the offbeats, root+octave bounce, ghost notes, space on the kick.",
      examples: ["FISHER – Losing It (octave-bounce bass carries the track)", "Solardo – On My Mind (rolling 16th groove)", "Patrick Topping – Forget (bouncy minimal bass)"],
      recipe: "write_bassline style:'tech-house', octave 1, try 2–3 seeds and keep the bounciest; sidechain 3–5dB to the kick.",
    },
    chords: {
      character: "Almost none — a single minor chord stabbed on offbeats, or a two-chord vamp (i–VII or i–iv). Harmony is texture, not progression.",
      examples: ["CamelPhat – Cola (one dark minor stab)", "Eats Everything style i–VII organ vamps"],
      recipe: "write_chords chords:['i','i','VII','i'] (or just ['i']) rhythm:'offbeat', enrich_level 1, octave 3 — short stabs, never held pads.",
    },
    sound: "Kick: punchy, tight, tuned (909-family). Bass: round analog mono sub + saturated mid layer. Signature: chopped vocal one-shots, dub-delay stabs, rolling shaker/perc loops.",
    mixmaster: "Drums + bass = 80% of the mix energy; everything else tucked. Mono lows, club-loud master ≈ -7…-9 LUFS, kick peaks lead the mix at ≈ -6dB.",
  },

  "deep house": {
    bpm: "118–124",
    melodies: {
      character: "Soulful and understated: Rhodes/organ licks, filtered vocal phrases, melodies leave huge space and ride the chord extensions (9ths, 13ths).",
      examples: ["Kerri Chandler – Rain (keys noodle around m9 chords)", "Disclosure – Latch (stabby vocal-led hooks)", "Larry Heard (Mr. Fingers) – Can You Feel It (the pad IS the melody)"],
      recipe: "write_melody over the full progression, octave 4, keep long notes + rests; target chord 9ths on strong beats (the engine lands chord tones — pick enrich level 2 chords so the colour exists).",
    },
    bassline: {
      character: "Warm, rolling, melodic — walks between root, 5th and octave in smooth 16th motion; deeper and rounder than tech house.",
      examples: ["Mr. Fingers – Mystery of Love (the archetypal deep rolling bass)", "Kerri Chandler – Bar A Thym (driving melodic low end)", "Disclosure – White Noise (melodic moving bass)"],
      recipe: "write_bassline style:'rolling', octave 1, swing 0 (grid), velocity ~100; let it MOVE — this genre tolerates 5th/b7 colour.",
    },
    chords: {
      character: "THE genre of chords: minor 7th/9th stabs and pads, two-to-four chord vamps with jazz colour, often i7–IV7 or im9–VIm9 motion.",
      examples: ["Mr. Fingers – Can You Feel It (Fm9-flavoured pads)", "Kerri Chandler's m9 stab language", "Disclosure – Latch intro (maj9/m9 stabs)"],
      recipe: "write_chords preset:'deep-house' (i–VI–III–VII) or chords:['i','iv','VII','VI'], enrich_level 2 (9ths ON), rhythm:'offbeat' for stabs or 'held' for the pad layer, voicing 'spread'.",
    },
    sound: "Kick: soft, round, deeper than tech house. Bass: pure analog sub warmth. Signature: m9 Rhodes/organ stabs, vinyl hiss, jazzy keys, muted 909 hats.",
    mixmaster: "Smoother top end than tech house — no harshness above 8k; master ≈ -9…-11 LUFS, dynamics breathe; bass RMS sits nearly level with the kick.",
  },

  house: {
    bpm: "120–126",
    melodies: {
      character: "Piano riffs and diva vocal hooks — big, major-leaning, gospel-tinged. The piano riff is often THE drop.",
      examples: ["Robin S – Show Me Love (M1 organ riff)", "CeCe Peniston – Finally (piano + diva topline)", "Inner City – Good Life (synth hook answers the vocal)"],
      recipe: "write_melody octave 4–5 over the progression, busier than deep house (8th-note motion), land hard on the downbeat root; layer with a piano/organ patch.",
    },
    bassline: {
      character: "The classic 'and'-of-the-beat octave bass (offbeat M1-style), or a walking piano-house line. Bounce, not roll.",
      examples: ["Robin S – Show Me Love (THE M1 offbeat bass)", "Armand Van Helden – U Don't Know Me (driving filtered disco bass)", "Daft Punk – Around the World (melodic walking bass)"],
      recipe: "write_bassline style:'offbeat' (classic) or 'octave' (driving), octave 1; the M1/organ bass patch matters as much as the notes.",
    },
    chords: {
      character: "Gospel/disco changes: minor 7ths with real movement — i–VI–III–VII, ii–V motion, or the eternal vi–IV–I–V in major piano house.",
      examples: ["Strike – U Sure Do (rave piano changes)", "Alison Limerick – Where Love Lives (gospel piano)", "Robin S – Show Me Love (m7 organ vamp)"],
      recipe: "write_chords preset:'deep-house' for the dark side or chords:['vi','IV','I','V'] for piano-house euphoria, rhythm:'offbeat' or 'stabs8', enrich ON, octave 3.",
    },
    sound: "Kick: classic 909 thump. Bass: M1 organ bass / filtered disco loops. Signature: piano stabs, diva vocals, 909 open-hat offbeats, organ.",
    mixmaster: "Vocal/piano share the front with the kick; master ≈ -8…-10 LUFS; sidechain subtler than EDM (2–3dB).",
  },

  techno: {
    bpm: "128–140",
    melodies: {
      character: "Hypnotic, not melodic: 1-bar acid loops, single-note pulses, dark drones that evolve by FILTER not by pitch. Melody = modulation over time.",
      examples: ["Plastikman – Spastik (rhythm IS the melody)", "Charlotte de Witte – Doppler (dark pulse riff)", "Amelie Lens style one-riff acid loops"],
      recipe: "write_melody with 2–4 pitches max (root, b7, octave), 1-bar loop, then write_automation a filter sweep over 8+ bars — the movement is the song.",
    },
    bassline: {
      character: "Rumble: the kick's own tail IS the bass in much techno; otherwise a relentless 16th rolling sub or off-beat stab locked to the kick.",
      examples: ["Berghain-style rumble kicks (kick tail = bassline)", "Robert Hood – minimal single-note funk", "303 acid lines (Phuture – Acid Tracks)"],
      recipe: "write_bassline style:'acid' (303 16ths w/ slides) or 'sub' (sparse roots); or skip the bass track and lengthen the kick decay + saturate (rumble).",
    },
    chords: {
      character: "Rarely chords — a single sustained minor/sus drone or a detuned stab hit every 2–4 bars for dread.",
      examples: ["Dettmann/Klock grayscale drones", "old-school rave stabs (Joey Beltram – Energy Flash)"],
      recipe: "write_chords chords:['i'] rhythm:'held' octave 2–3 on a dark pad, OR one 'push' stab; automate filter/reverb size instead of changing harmony.",
    },
    sound: "Kick: long, saturated, tuned LOW (rumble). Signature: 909/707 percussion, acid 303, metallic hits, huge reverbs gated short.",
    mixmaster: "Kick dominates outright (-5…-6dB peaks); brutal mono low end; master -6…-8 LUFS club-loud; hats can bite more than other genres.",
  },

  trance: {
    bpm: "132–140",
    melodies: {
      character: "THE melody genre: long emotional lead lines (2–8 bars), supersaw, arpeggiated 16th plucks underneath, huge build–release arcs.",
      examples: ["Robert Miles – Children (iconic piano lead)", "ATB – 9 PM (Till I Come) (plucked guitar-synth hook)", "Paul van Dyk – For An Angel (anthem lead)"],
      recipe: "write_melody over the FULL progression, octave 5, let phrases run 2 bars; add a 16th-note arp layer (write_notes on chord tones) an octave below; supersaw patch + reverb/delay sends.",
    },
    bassline: {
      character: "Driving offbeat bass (the 'trance gallop'): root on the off-8th every beat, occasionally 1/16 rolls into the next bar.",
      examples: ["Above & Beyond style offbeat drive", "System F – Out of the Blue (relentless offbeat root)"],
      recipe: "write_bassline style:'offbeat', octave 1, velocity 110 — keep it ROOT-heavy (this genre wants stability under the emotional top).",
    },
    chords: {
      character: "Epic minor progressions held as supersaw pads: i–VI–III–VII (the trance progression) or i–VI–VII; suspensions resolving at the drop.",
      examples: ["Children's i–VI–III–VII family", "Adagio For Strings (Tiësto) harmonic arc", "Gareth Emery anthem pads"],
      recipe: "write_chords preset:'epic' (i–VI–III–VII), rhythm:'held', enrich ON, voicing 'spread', octave 3; double with 'offbeat' stabs in the drop.",
    },
    sound: "Kick: clean punchy 4-floor. Bass: offbeat saw-sub. Signature: SUPERSAW everything, 16th plucks, white-noise sweeps, sidechained pads.",
    mixmaster: "Lead + pads get the space (big reverb, ducked under kick); master -7…-9 LUFS; the breakdown can be -6dB quieter than the drop on purpose.",
  },

  "uk garage": {
    bpm: "130–136",
    melodies: {
      character: "Chopped, pitched vocal phrases as the hook; skippy organ/keys licks filling the 2-step gaps.",
      examples: ["Artful Dodger – Re-Rewind (chopped vocal hook)", "MJ Cole – Sincere (musical keys + vocal science)", "DJ Luck & MC Neat – A Little Bit of Luck"],
      recipe: "write_melody sparse + syncopated (octave 4), then offset phrases to the &s; vocal-chop samples (load_sound 'vocal') pitched to key beat the synth every time.",
    },
    bassline: {
      character: "2-step sub bass: long dark sub notes landing AROUND the kick pattern, with the occasional double-hit skip; warm but menacing.",
      examples: ["MJ Cole – Sincere (melodic warm sub)", "Wookie – Battle (gospel-garage b-line)", "Zed Bias – Neighbourhood (dark sub stabs)"],
      recipe: "write_bassline style:'garage', octave 1 — the shuffle is in the rests; keep 2–4 pitches (root, b7, 5th).",
    },
    chords: {
      character: "Jazzy and expensive-sounding: m9/maj7 keys stabs, often ii–V flavoured, syncopated to the 2-step shuffle.",
      examples: ["MJ Cole's m9 keys language", "Sunship – Cheque One Two (swung organ stabs)"],
      recipe: "write_chords chords:['ii','v','i','i'] or preset:'jazz-251', enrich_level 2, rhythm:'push' (syncopated), octave 3.",
    },
    sound: "Drums: skippy 2-step (swung 16th hats, sparse kicks). Bass: pure warm sub. Signature: pitched vocal chops, organ keys, rimshot shuffles.",
    mixmaster: "Drums crisp on top, sub deep below, big mid gap for the vocal; master -8…-10 LUFS; swing is sacred — never flatten the shuffle.",
  },

  dnb: {
    bpm: "170–176",
    melodies: {
      character: "Liquid: long washy pads + soulful vocal lines. Neuro/dancefloor: the BASS is the melody; tops are stabs and pitched FX.",
      examples: ["LTJ Bukem – Horizons (liquid pads/keys)", "Netsky – Love Has Gone (vocal liquid)", "Pendulum – Tarantula (riff-driven)"],
      recipe: "liquid → write_melody over m9 chords, octave 4–5, long phrases; dancefloor → keep tops minimal, give the riff energy to the bass (reese).",
    },
    bassline: {
      character: "Reese growls moving in long 1–2 bar phrases under 174 drums, or rolling sub 8ths (liquid); movement comes from filter modulation as much as pitch.",
      examples: ["Pendulum/Noisia reese language", "Calibre rolling liquid subs", "Goldie – Inner City Life (deep sub swells)"],
      recipe: "write_bassline style:'reese', octave 1, beats_per_chord 4; design the reese (deviceSkills 'reese': 2 detuned saws + slow LFO→filter) and AUTOMATE the cutoff per phrase.",
    },
    chords: {
      character: "Liquid loves m9/maj9 wash (two-chord vamps drowned in reverb); dancefloor uses a single dark minor stab if any.",
      examples: ["LTJ Bukem's m9 atmosphere", "High Contrast – Return of Forever (lush maj9 movement)"],
      recipe: "write_chords chords:['i','VI'] enrich_level 2 rhythm:'held' octave 3, big reverb send; sidechain the pad to the kick+snare.",
    },
    sound: "Drums: fast broken breaks (2&4 snare), layered breaks under one-shots. Bass: reese + sine sub. Signature: time-stretched breaks, pads, vocal washes.",
    mixmaster: "Snare is the loudest transient (≈ kick level); sub mono and HUGE; master -7…-9 LUFS; drums bussed + glued hard.",
  },

  dubstep: {
    bpm: "138–142 (half-time feel)",
    melodies: {
      character: "Minimal eerie tops (music-box, pitched vox) in the intro; in the drop the modulated BASS carries all melodic interest ('talking' basses).",
      examples: ["Benga & Coki – Night (the riff IS the bass)", "Skrillex – Scary Monsters (vocal-formant bass melodies)", "Burial's ghostly pitched vocals (deeper side)"],
      recipe: "intro: write_melody sparse octave 5 dark minor; drop: write_bassline the riff, then design wobble (LFO→filter rate automation) — the LFO RATE changes per note are the hook.",
    },
    bassline: {
      character: "Half-time wobble/growl riffs — few pitches, massive modulation; sub layer follows the same roots straight.",
      examples: ["Night's two-note riff", "Rusko – Cockney Thug (wide wobbles)", "Zomboy/Excision growl riffs"],
      recipe: "write_bassline style:'sub' for the sub layer + write_notes the riff (half-time, octave 1–2); Wavetable: LFO→filter with rate automated 1/4→1/8→1/16 per bar.",
    },
    chords: {
      character: "Barely any — a dark sustained minor pad or single stab for dread; harmony stays out of the bass's way.",
      examples: ["Burial-style pad washes", "classic DMZ single-stab dread"],
      recipe: "write_chords chords:['i'] rhythm:'held' octave 3 with dark pad, high-passed above the bass.",
    },
    sound: "Drums: huge half-time snare on 3. Bass: wobble/growl + clean sine sub UNDER it. Signature: LFO wobble, vocal formant filters, cinematic FX.",
    mixmaster: "Snare massive, sub mono and dominant, mids carved for the growl; master -6…-8 LUFS; the sub/growl split (sub <100Hz clean, growl 100Hz+) is the whole mix.",
  },

  trap: {
    bpm: "130–150 (half-time, or 65–75 'true' BPM)",
    melodies: {
      character: "Dark bell/flute/pluck motifs in (harmonic) minor, 2–4 bar loops, heavy space; melodic hooks are simple and ominous.",
      examples: ["Future – Mask Off (the flute loop)", "Metro Boomin's bell/choir motifs", "Travis Scott – goosebumps (woozy pluck hook)"],
      recipe: "write_melody octave 4–5, harmonic_minor mode, 4–6 notes per 2 bars, LOTS of rests; bell/pluck patch + dark reverb.",
    },
    bassline: {
      character: "The 808 IS the bass and the kick: long gliding 808 notes on the roots, syncopated with the kick pattern, occasional octave slides.",
      examples: ["Mask Off's sliding 808 roots", "21 Savage/Metro 808 patterns", "Travis Scott sustained 808 glides"],
      recipe: "write_bassline style:'sub', octave 1, long durations; or write_notes 808 roots following the kick; pitch-glide via overlapping notes (slide feel) — tune the 808 to the root (tuning check!).",
    },
    chords: {
      character: "A looping minor vamp — i–VI or i–iv–VI — usually as a dark pad/choir/string loop behind the motif.",
      examples: ["Mask Off's i–VI flute-pad bed", "Metro Boomin choir vamps"],
      recipe: "write_chords chords:['i','i','VI','i'] mode:'minor' (or harmonic_minor), rhythm:'held', octave 3, dark pad/strings.",
    },
    sound: "Drums: 808 kit (rolls/triplet hats, clap on 3). Bass: TUNED 808 with saturation. Signature: hat rolls (write_drums 'trap' does them), dark bells, vocal chants.",
    mixmaster: "808 is the loudest element after the snare/clap; hats bright but tucked; master -8…-10 LUFS; the 808's tuning + saturation decide the whole low end.",
  },

  "hip hop": {
    bpm: "85–95 (boom bap) / 60–75 (modern)",
    melodies: {
      character: "Sample-flavoured: short dusty piano/horn/soul licks looped 2–4 bars, behind the (imaginary) vocal; melody answers the snare.",
      examples: ["Nas – N.Y. State of Mind (dark piano loop)", "Dilla's off-kilter Rhodes licks", "9th Wonder soul chops"],
      recipe: "write_melody octave 3–4, SHORT loop, swing handled by the genre drums (don't add timing swing to melody unless asked); lo-fi keys/Rhodes patch.",
    },
    bassline: {
      character: "Round fingered-bass loops: root–5th–b7 walks locking to the kick, leaving beat 2/4 for the snare; simple and fat.",
      examples: ["NY boom-bap upright-style loops", "Dr. Dre's melodic P-funk synth bass (G-funk side)"],
      recipe: "write_bassline style:'pluck' or 'octave', octave 1–2, velocity ~100; mirror the kick placement (read the drum clip first).",
    },
    chords: {
      character: "Two dusty jazz chords looped forever: m7/m9 vamps, ii–V colour, often sampled feel (slightly detuned, filtered).",
      examples: ["Nas/Premier minor piano vamps", "Dilla m9 Rhodes language", "Wu-Tang's eerie two-chord loops"],
      recipe: "write_chords chords:['i','iv'] or preset:'lofi' (ii–V–iii–vi), enrich_level 2, rhythm:'held', octave 3, low-passed + saturated.",
    },
    sound: "Drums: dusty break kits, swung hats, hard snare. Bass: round sub/finger bass. Signature: vinyl crackle, filtered samples, horn stabs.",
    mixmaster: "Drums in front (snare loudest), everything else lo-fi'd behind; master -9…-12 LUFS — punch over loudness.",
  },

  "lo-fi": {
    bpm: "70–90",
    melodies: {
      character: "Wistful jazz licks over the chords, intentionally loose, mellow register, tape-warbled; melody noodles rather than hooks.",
      examples: ["Nujabes – Feather (melodic jazz-hop)", "J Dilla – Don't Cry (soul chop melody)", "the entire 'lofi beats to study to' canon"],
      recipe: "write_melody octave 4, slow phrases, end phrases on 9ths/7ths (enrich level 2 chords supply them); Rhodes/soft keys + chorus + low-pass ~8kHz.",
    },
    bassline: {
      character: "Soft round sub following roots in half/whole notes, the occasional approach note; almost felt more than heard.",
      examples: ["Nujabes' warm walking bass moments", "standard lofi sub-pulse"],
      recipe: "write_bassline style:'sub', octave 1, velocity ~85; long durations, no aggression.",
    },
    chords: {
      character: "Jazz progressions are the genre: ii–V–I with 7ths/9ths everywhere, borrowed chords, gentle voice-leading.",
      examples: ["Nujabes' maj9/m9 changes", "ii–V–iii–vi lofi standard loop"],
      recipe: "write_chords preset:'lofi' or 'jazz-251', enrich_level 2, sevenths true, rhythm:'held', voicing 'spread', octave 3 — then low-pass + slight detune/wobble for tape feel.",
    },
    sound: "Drums: soft dusty kit, swung. Keys: Rhodes/piano through tape. Signature: vinyl noise, rain FX, tape pitch wobble, low-passed everything.",
    mixmaster: "Nothing bright: gentle low-pass on the master bus is idiomatic; master -12…-14 LUFS, soft-knee glue; dynamics stay gentle.",
  },

  "edm festival": {
    bpm: "126–130",
    melodies: {
      character: "Anthem toplines: huge simple major/minor hooks playing the CHORDS as the lead (chord-stab melody), built for 50,000 people to sing.",
      examples: ["Avicii – Levels (THE festival hook)", "Swedish House Mafia – Don't You Worry Child (chord-lead drop)", "Calvin Harris – Feel So Close"],
      recipe: "write_melody octave 5 landing only chord tones on beats, then double it: lead + chords playing the SAME rhythm ('stabs8') = the festival drop sound (supersaw, wide, sidechained).",
    },
    bassline: {
      character: "Drop: root 8ths glued to the kick via heavy sidechain; break: none. Function over funk.",
      examples: ["Levels' pumping root bass", "Martin Garrix – Animals (big-room toms/bass)"],
      recipe: "write_bassline style:'octave' or 'offbeat', octave 1, then sidechain HARD (6–10dB, the pump is the genre).",
    },
    chords: {
      character: "Four-chord anthems: vi–IV–I–V or I–V–vi–IV in full supersaw, played as the drop rhythm.",
      examples: ["Levels (vi–IV–I–V family)", "Don't You Worry Child (anthem changes)", "Titanium (IV–I–V–vi behind the vocal)"],
      recipe: "write_chords chords:['vi','IV','I','V'] (or preset:'pop'), rhythm:'stabs8' in the drop / 'held' in the break, enrich ON, octave 3–4, supersaw + width.",
    },
    sound: "Kick: huge layered 4-floor. Signature: supersaws, white-noise risers + crash on every 8, pitch risers, snare build rolls.",
    mixmaster: "Loud and wide: master -6…-8 LUFS, big sidechain pump everywhere except the kick; the drop must be +3dB perceived over the break.",
  },

  "afro house": {
    bpm: "118–124",
    melodies: {
      character: "Call-and-response marimba/kalimba/vocal phrases, pentatonic-leaning, woven INTO the percussion groove rather than floating above it.",
      examples: ["Black Coffee – Drive (sparse melodic motifs in the groove)", "Themba / Culoe De Song organic hooks", "&ME / Keinemusik melodic-organic lines"],
      recipe: "write_melody octave 4, sparse syncopated phrases (rests on downbeats), mostly steps; marimba/pluck patch, dry-ish (percussion owns the space).",
    },
    bassline: {
      character: "Hypnotic round sub riff, syncopated WITH the percussion, often 2-bar loops with one signature off-accent; melodic but patient.",
      examples: ["Black Coffee's rolling sub grooves", "Da Capo / Enoo Napa tribal low end"],
      recipe: "write_bassline style:'tech-house' (the syncopation grammar fits) or 'rolling', octave 1, then STRIP: remove until the groove breathes.",
    },
    chords: {
      character: "Modal vamps — i–VII or two-chord m7 movement, often carried by organic keys/guitar loops more than pads.",
      examples: ["Drive's understated minor movement", "Keinemusik's m7 vamps"],
      recipe: "write_chords chords:['i','VII'] enrich_level 1, rhythm:'push', octave 3 — syncopated, modest, percussive.",
    },
    sound: "Drums: layered organic percussion (congas, shakers, log drums) over a soft 4-floor. Signature: log-drum basses (3-step adjacent), vocal chants, nature FX.",
    mixmaster: "Percussion detail is the headline — keep transients alive (light compression); master -9…-11 LUFS; wide percussion, mono sub.",
  },

  ambient: {
    bpm: "free / 60–90",
    melodies: {
      character: "Slow evolving motifs that repeat with tiny variations, or none at all — texture and timbre replace melody.",
      examples: ["Brian Eno – An Ending (Ascent) (slow swelling motif)", "Aphex Twin – #3 (Rhubarb) (patient loop)", "Stars of the Lid drones"],
      recipe: "write_melody octave 4, beats_per_chord 8+, very few notes, long durations; ENORMOUS reverb/delay sends; automate filter over 16+ bars.",
    },
    bassline: {
      character: "Sub drones on the root, changing once per chord (or per minute); felt, not played.",
      examples: ["Eno's pedal-tone foundations", "Tim Hecker low swells"],
      recipe: "write_bassline style:'sub', beats_per_chord 8–16, octave 1; fade in/out with volume automation.",
    },
    chords: {
      character: "Suspended, ambiguous, slow: maj7/add9/sus chords drifting i–VI–IV or non-functional colour shifts, always 'held'.",
      examples: ["An Ending's suspended major wash", "Boards of Canada's detuned maj/min ambiguity"],
      recipe: "write_chords chords:['i','VI','IV','VI'] enrich_level 2, rhythm:'held', beats_per_chord 8, voicing 'spread', octave 3; slow attack pad (attack 1s+), reverb 8s+.",
    },
    sound: "No drums (or a distant pulse). Signature: granular pads, tape hiss, field recordings, detune/chorus, endless reverb tails.",
    mixmaster: "Dynamics ARE the music — barely compress; master -14…-18 LUFS; stereo as wide as it wants; gentle high-shelf air.",
  },

  pop: {
    bpm: "95–120",
    melodies: {
      character: "Verse low + chorus HIGH (the lift is the hook), short repeated cells, syllabic rhythm; the topline rules every other element.",
      examples: ["The Weeknd – Blinding Lights (80s synth hook + topline)", "Dua Lipa – Levitating (disco-pop hook cells)", "Ed Sheeran – Shape of You (marimba motif)"],
      recipe: "write_melody octave 4 for the 'verse' clip, regenerate octave 5 + denser for the 'chorus' clip; keep one 2-bar cell repeating with one variation.",
    },
    bassline: {
      character: "Serves the song: disco octave drive, synthwave 8ths, or root-5th pop patterns — clean and consistent.",
      examples: ["Blinding Lights' driving 8ths", "Levitating's disco octave funk"],
      recipe: "write_bassline style:'octave' (disco/synth-pop) or 'offbeat', octave 1, low variation (pop wants stability).",
    },
    chords: {
      character: "The four-chord canon: I–V–vi–IV and vi–IV–I–V power everything; the trick is RHYTHM and instrumentation, not the changes.",
      examples: ["I–V–vi–IV: countless hits (Let It Be lineage)", "Blinding Lights' minor synth vamp", "Levitating's funk vamp"],
      recipe: "write_chords preset:'pop' (I–V–vi–IV) or 'emotional' (vi–IV–I–V), enrich_level 1, rhythm to match the groove ('stabs8' funk-pop / 'held' ballad), octave 3.",
    },
    sound: "Genre-fluid: pick an era (80s synthwave, disco-funk, acoustic-pop) and commit the whole palette to it.",
    mixmaster: "Vocal-first mix even when instrumental (leave 2–5kHz space); master -8…-11 LUFS streaming-loud; choruses +1–2dB wider and brighter than verses.",
  },
};

// aliases → canonical key
const ALIASES = {
  "tech-house": "tech house", techhouse: "tech house",
  "deep-house": "deep house", deephouse: "deep house",
  "drum and bass": "dnb", "drum & bass": "dnb", "d&b": "dnb", jungle: "dnb", liquid: "dnb",
  "uk garage": "uk garage", ukg: "uk garage", garage: "uk garage", "2-step": "uk garage", "2step": "uk garage",
  "hip-hop": "hip hop", hiphop: "hip hop", "boom bap": "hip hop", "boom-bap": "hip hop", rap: "hip hop",
  "lo-fi": "lo-fi", lofi: "lo-fi", "lofi hip hop": "lo-fi",
  edm: "edm festival", "big room": "edm festival", festival: "edm festival", "progressive house": "edm festival",
  "afro-house": "afro house", afrohouse: "afro house", afro: "afro house", amapiano: "afro house",
  "melodic techno": "techno", "hard techno": "techno", acid: "techno",
  psytrance: "trance", "uplifting trance": "trance",
  "future bass": "trap", drill: "trap",
  chillout: "ambient", drone: "ambient", cinematic: "ambient",
  "synth-pop": "pop", synthwave: "pop", disco: "pop", funk: "pop", "indie pop": "pop",
};

function norm(s) { return String(s || "").toLowerCase().trim(); }

function get(genre) {
  const q = norm(genre);
  if (!q) return null;
  if (GENRES[q]) return { genre: q, ...GENRES[q] };
  if (ALIASES[q] && GENRES[ALIASES[q]]) return { genre: ALIASES[q], matchedFrom: q, ...GENRES[ALIASES[q]] };
  // containment both ways ("classic tech house groove" → tech house)
  for (const k of Object.keys(GENRES)) if (q.includes(k) || k.includes(q)) return { genre: k, matchedFrom: q, ...GENRES[k] };
  for (const [a, k] of Object.entries(ALIASES)) if (q.includes(a)) return { genre: k, matchedFrom: q, ...GENRES[k] };
  return null;
}

function list() { return Object.keys(GENRES); }

module.exports = { get, list, GENRES };
