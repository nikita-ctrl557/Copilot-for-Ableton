// progressions.js — a LARGE chord-progression library (roman numerals + mode +
// genre/mood tags + where you've heard the move). Progressions are musical
// vocabulary, not copyrightable material — this is the "big amounts of chords"
// layer: browseable via the progression_library tool, playable directly via
// write_chords (any entry's romans + mode drop straight in).
// Conventions: lowercase = minor, UPPER = major; quality suffixes are added by
// the chord engine's enrich; mode tells write_chords which scale to spell from.

const P = (name, mode, romans, genres, mood, note) => ({ name, mode, romans, genres, mood, note });

const PROGRESSIONS = [
  // ---- house / deep house / garage ----
  P("deep classic", "minor", ["i", "VI", "III", "VII"], ["deep house", "house", "trance"], "deep/emotive", "the workhorse minor loop — Children to Levels-era"),
  P("deep sway", "minor", ["i", "iv", "VII", "VI"], ["deep house", "afro house"], "hypnotic", "Kerri Chandler-style sway"),
  P("m9 vamp", "minor", ["i", "iv"], ["deep house", "lo-fi", "hip hop"], "smoky", "two-chord m9 vamp — Can You Feel It lineage"),
  P("garage bounce", "minor", ["i", "III", "VII", "iv"], ["uk garage", "house"], "bittersweet bounce", "MJ Cole-flavoured movement"),
  P("uplift house", "major", ["I", "iii", "IV", "V"], ["house", "pop"], "sunny", "piano-house lift"),
  P("gospel house", "major", ["I", "IV", "ii", "V"], ["house"], "gospel warmth", "praise-break changes under a 4-floor"),
  P("french filter", "major", ["ii", "V", "I", "IV"], ["house", "pop"], "smooth disco", "filter-house loop bait"),
  P("organ anthem", "minor", ["i", "VII", "VI", "VII"], ["house", "techno", "trance"], "driving", "rave organ stabs"),
  P("latin house", "minor", ["i", "iv", "V", "i"], ["house", "afro house"], "fiery", "andalusian-adjacent montuno feel"),
  P("soulful 6-4-1-5", "major", ["vi", "IV", "I", "V"], ["house", "pop", "edm festival"], "euphoric-sad", "the eternal pop-dance four"),
  // ---- tech house / techno / minimal ----
  P("tech vamp", "minor", ["i", "i", "VII", "i"], ["tech house", "techno"], "relentless", "one-chord groove with a VII breath"),
  P("dark shift", "phrygian", ["i", "II", "i", "II"], ["techno", "tech house"], "menacing", "phrygian II rub — instant dark"),
  P("warehouse", "minor", ["i", "v", "i", "VI"], ["techno"], "cold", "minor v keeps it grayscale (no leading tone)"),
  P("acid pedal", "minor", ["i"], ["techno", "tech house"], "hypnotic", "single-chord pedal; movement comes from filter"),
  // ---- trance / progressive / melodic techno ----
  P("trance epic", "minor", ["i", "VI", "III", "VII"], ["trance", "edm festival", "melodic techno"], "epic", "THE trance progression"),
  P("prog lift", "minor", ["i", "III", "VII", "VI"], ["trance", "melodic techno"], "yearning", "rising thirds, falling resolution"),
  P("anjuna", "major", ["I", "V", "vi", "iii", "IV"], ["trance", "pop"], "bittersweet wide", "extended pop-trance arc"),
  P("melodic minor 6", "minor", ["i", "VI", "VII", "v"], ["melodic techno", "trance"], "afterhours", "Tale Of Us-adjacent gray-emotive"),
  P("suspended dawn", "major", ["I", "Vsus4", "vi", "IVsus4"], ["trance", "ambient", "pop"], "floating", "sus chords delay every resolution"),
  // ---- pop / EDM ----
  P("axis", "major", ["I", "V", "vi", "IV"], ["pop", "edm festival", "house"], "anthemic", "the four-chord axis of pop"),
  P("axis rotated", "major", ["vi", "IV", "I", "V"], ["pop", "edm festival"], "wistful-big", "same wheel, sadder door"),
  P("50s doo-wop", "major", ["I", "vi", "IV", "V"], ["pop", "lo-fi"], "nostalgic", "Stand By Me changes"),
  P("royal road", "major", ["IV", "V", "iii", "vi"], ["pop", "anime", "future bass"], "soaring", "J-pop royal road — koakuma changes"),
  P("pop punk lift", "major", ["I", "V", "vi", "iii", "IV", "I", "IV", "V"], ["pop"], "drive-time", "Canon-derived 8-chord arc"),
  P("minor pop", "minor", ["i", "VII", "VI", "VII"], ["pop", "synthwave", "edm festival"], "night-drive", "Blinding-Lights-era minor vamp"),
  P("borrowed iv", "major", ["I", "IV", "iv", "I"], ["pop", "lo-fi", "ambient"], "tearjerker", "the major→minor iv melt (Creep move, simplified)"),
  P("mixolydian shrug", "mixolydian", ["I", "VII", "IV", "I"], ["pop", "rock", "afro house"], "open road", "bVII shrug — Sweet-Home cadence family"),
  // ---- hip hop / trap / drill ----
  P("dark trap", "harmonic_minor", ["i", "i", "VI", "V"], ["trap", "hip hop"], "ominous", "harmonic-minor V = the dread leading tone"),
  P("mask vamp", "minor", ["i", "VI"], ["trap", "hip hop"], "haunted", "two-chord flute-loop bed"),
  P("drill slide", "phrygian", ["i", "II", "VII", "i"], ["trap", "drill"], "icy", "phrygian II over sliding 808s"),
  P("boom bap loop", "minor", ["i", "iv", "i", "VII"], ["hip hop", "lo-fi"], "dusty", "NY-state-of-mind family loop"),
  P("g-funk", "minor", ["i", "VII", "VI", "v"], ["hip hop"], "west coast", "whiny-lead minor descent"),
  P("soul chop", "major", ["Imaj7", "iii7", "vi7", "ii7", "V7"], ["hip hop", "lo-fi", "rnb"], "warm chops", "the sampled-soul turnaround"),
  // ---- rnb / neo-soul / gospel ----
  P("neo soul cycle", "minor", ["i7", "iv7", "VII7", "IIImaj7"], ["rnb", "lo-fi", "deep house"], "silky", "circle-of-fourths glide"),
  P("rnb 6-2-5-1", "major", ["vi7", "ii7", "V7", "Imaj7"], ["rnb", "jazz", "lo-fi"], "smooth resolve", "back-cycling turnaround"),
  P("gospel walkup", "major", ["I", "I7", "IV", "iv"], ["rnb", "gospel", "lo-fi"], "church", "I7 pushes to IV, minor iv melts home"),
  P("quartal float", "dorian", ["i", "ii", "i", "ii"], ["rnb", "lo-fi", "ambient"], "weightless", "dorian ii rocking — voice in fourths"),
  // ---- dnb / dubstep / uk bass ----
  P("liquid wash", "minor", ["i9", "VI9", "III9", "VII9"], ["dnb"], "liquid", "LTJ-style 9th wash over 174"),
  P("neuro stab", "minor", ["i", "ii", "i", "v"], ["dnb", "dubstep"], "clinical", "tension without release"),
  P("dub sway", "minor", ["i", "v"], ["dubstep", "uk garage"], "cavernous", "two dark poles, lots of space"),
  P("2-step soul", "major", ["ii7", "V7", "Imaj7", "vi7"], ["uk garage"], "sweet shuffle", "jazzy garage 2-5-1-6"),
  // ---- ambient / cinematic ----
  P("ambient drift", "major", ["I", "vi", "IV", "vi"], ["ambient", "lo-fi"], "weightless", "Eno-style slow alternation"),
  P("lydian rise", "lydian", ["I", "II", "I", "II"], ["ambient", "cinematic", "trance"], "wonder", "lydian II = instant film-score awe"),
  P("dorian sea", "dorian", ["i", "IV", "i", "IV"], ["ambient", "afro house", "melodic techno"], "rolling calm", "the dorian IV keeps minor hopeful"),
  P("cinematic fall", "minor", ["i", "VII", "VI", "V"], ["cinematic", "trance", "pop"], "tragic descent", "andalusian cadence — flamenco to film"),
  P("hopeful minor", "minor", ["i", "III", "VI", "VII"], ["cinematic", "edm festival", "trance"], "rising hope", "minor that climbs into light"),
  // ---- jazz vocabulary (for lo-fi / keys beds) ----
  P("jazz 2-5-1", "major", ["ii7", "V7", "Imaj7"], ["jazz", "lo-fi", "rnb"], "resolved", "the sentence of jazz"),
  P("minor 2-5-1", "minor", ["ii", "V7", "i7"], ["jazz", "lo-fi"], "noir", "minor sentence — half-diminished door"),
  P("rhythm changes A", "major", ["Imaj7", "vi7", "ii7", "V7"], ["jazz", "lo-fi"], "bouncing", "1-6-2-5 — endless loopable turnaround"),
  P("backdoor", "major", ["IV7", "VII7", "Imaj7"], ["jazz", "rnb", "lo-fi"], "sneaky resolve", "the backdoor cadence (bVII7→I)"),
  P("coltrane lite", "major", ["Imaj7", "VI7", "ii7", "V7"], ["jazz", "lo-fi"], "slippery", "secondary dominant colour without the full Giant Steps"),
  // ---- afro / latin / org ----
  P("afro modal", "dorian", ["i", "ii", "IV", "i"], ["afro house", "amapiano"], "earthy lift", "dorian movement under log drums"),
  P("amapiano air", "major", ["Imaj7", "V", "vi7", "IVmaj7"], ["amapiano", "afro house", "rnb"], "airy", "maj7 air over sparse percussion"),
  P("montuno", "minor", ["i", "iv", "V7", "iv"], ["latin", "house"], "fiery circle", "salsa montuno cycle"),
  P("bossa slide", "major", ["Imaj7", "ii7", "iii7", "ii7"], ["bossa", "lo-fi", "jazz"], "sea-breeze", "stepwise maj/min7 slide"),
  // ---- synthwave / retro ----
  P("synthwave night", "minor", ["i", "VI", "VII", "i"], ["synthwave", "pop", "edm festival"], "neon", "the retrowave standard"),
  P("outrun chase", "minor", ["i", "VII", "v", "VI"], ["synthwave", "cinematic"], "pursuit", "darker variation with minor v"),
  // ---- experimental colour moves ----
  P("chromatic mediant", "major", ["I", "bVI", "I", "bIII"], ["cinematic", "trance", "pop"], "epic twist", "chromatic mediants — instant trailer"),
  P("picardy loop", "minor", ["i", "VI", "iv", "I"], ["ambient", "cinematic"], "dawn break", "ends on the major I (picardy) — light at the end"),
  P("pedal sus", "major", ["Isus4", "I", "Isus2", "I"], ["ambient", "pop", "trance"], "breathing", "one chord breathing through suspensions"),
  P("mode mixture", "major", ["I", "v", "IV", "iv"], ["pop", "lo-fi", "rnb"], "bittersweet fade", "minor v + iv borrowed — sunset chords"),
];

function norm(s) { return String(s || "").toLowerCase().trim(); }

// browse: by genre and/or mood substring; no filters = everything (names+tags only)
function search({ genre, mood } = {}) {
  const g = norm(genre), m = norm(mood);
  return PROGRESSIONS.filter((p) =>
    (!g || p.genres.some((x) => x.includes(g) || g.includes(x))) &&
    (!m || norm(p.mood).includes(m) || m.includes(norm(p.mood))));
}

function get(name) {
  const q = norm(name);
  return PROGRESSIONS.find((p) => norm(p.name) === q) ||
         PROGRESSIONS.find((p) => norm(p.name).includes(q) || q.includes(norm(p.name))) || null;
}

module.exports = { PROGRESSIONS, search, get };
