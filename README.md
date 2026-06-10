# Claude Copilot for Ableton

A chat panel that lives **inside Ableton Live 12** with real hands — and real **ears** — on your session. Ask in plain language; Claude writes chords/melodies/basslines/drums, designs sounds, controls devices and plug-ins, **listens to what it made**, and mixes & masters — by actually doing it, then hearing it, then fixing it.

It's a self-contained Max for Live device. Node is bundled with Max, so the device runs the agent loop itself and talks to Live through the Live API plus a small Python remote script (the "loader").

```
jweb chat UI ⇄ node.script (agent loop, skills, analysis) ⇄ v8 LiveAPI + Python loader (TCP 9001)
                          ⇡ HTTP 8723: ClaudeMeter fleet (loudness/spectrum/recording), uploads, info panel
```

## Phase 1 — control ✅
- **Write music**: chords (voice-led, electronic voicings: low root+octave foundation, rootless colour upstairs, `duo` two-note mode), motif-based melodies (A A' B A'' phrasing), seeded groove-grammar basslines (`tech-house`, `acid`, `rolling`, `garage`…), genre-correct drums with fills + variation.
- **Sound design**: stock synths (Wavetable/Operator/Drift…) — params, properties, **mod-matrix routing** (`set_modulation`: Env→filter plucks, LFO→wavetable motion), envelopes, complex LFO craft.
- **Devices & plug-ins**: load/tune stock devices; VST/AU (FabFilter, Ozone, Kickstart…) via Live's Configure flow, with built-in + self-researched plug-in docs; chain reordering; duplicate-load guard.
- **Session & arrangement**: tracks, clips, automation (write/read/clear), timeline arrangement with genre blueprints, sidechain by design (Kickstart / compressor / Auto Pan / drawn pump).

## Phase 2 — listening ✅ (real, shipped)
- **ClaudeMeter** analyzer on every track/return/master: live loudness + 4-band spectrum + song-position activity ("plays bars 1–8, 17–24") + REC.
- **Multitrack capture**: every track records to its own wav simultaneously; group FFT analysis (balance, fundamental + **tuning vs the detected key**, active sections, low-end clashes); auto-cleanup after.
- **The enforced loop**: every sound change is tracked; the agent **cannot end a turn without auditioning what it changed** (configurable number of listen→fix phases); `tooQuiet`/silent/character verdicts are work orders.
- **Key detection from the actual MIDI** (Krumhansl), not Live's scale chooser; beatbox/hum → MIDI; reference audio → recreated beats/sounds; audio attachments analyzed.

## Phase 3 — roadmap 🚧
- Stem separation of reference tracks (recreate each layer of a song).
- Audio-to-audio matching EQ against a reference master.
- Live performance mode (scene-aware jamming, follow actions).
- Cross-project knowledge (your best patches/grooves reused between songs).

## Install
```bash
bash scripts/install.sh   # installs deps, bakes devices, runs tests, copies to User Library
```
Then in Live 12: **User Library ▸ Presets ▸ Audio Effects ▸ Max Audio Effect ▸ Claude Copilot** → drag onto a track. Enable the loader once: Live ▸ Settings ▸ Link/Tempo/MIDI ▸ Control Surface ▸ **Claude_Copilot**, restart Live.

**Sign in with YOUR account**: ⚙ Settings → subscription (uses your Claude Code login — run `claude` once in Terminal to sign in), an Anthropic API key, or a **local LLM** (Ollama/LM Studio/llama.cpp/Jan/GPT4All — beta).

## Settings highlights
- **Skills**: import/write your own skill files — the copilot reads them and they **outrank** built-ins; built-in skills & libraries are listed too.
- **Favorite plug-ins**, **Effort** (quick/standard/meticulous), **Work phases** (how many listen→fix passes per request), voice input (local Whisper), project info panel (📊) with live per-track spectrum.

## Tests
```bash
node core/chords.test.js && node core/melody.test.js && node core/groove.test.js \
  && node core/key.test.js && node scripts/test-audio2midi.js && node scripts/test-offline.js
```

## Layout
| path | what |
|---|---|
| `core/` | agent loop, tool catalog, music engines, skills (element/genre/plugin/custom), spectral analysis, meter store |
| `device/` | chat UI, node entry, v8 LiveAPI executor, meter device sources |
| `remote_script/` | the Python loader (browser loads, params, chains, meters, mod matrix) |
| `scripts/` | device builders, installer, test suites |
| `tools/amxd.js` | .amxd pack/unpack |
