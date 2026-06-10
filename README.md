# Claude Copilot for Ableton

A chat panel that lives **inside Ableton Live** and has real hands on your session.
Ask in plain language; Claude reads your tracks, chooses sounds, mixes, tweaks device
parameters, and writes chords / melodies / MIDI — by actually doing it, not describing it.

It's a single self-contained Max for Live device. No external app, no server to run,
no Python — Node is bundled with Max for Live, so the device runs Claude's agent loop
itself and talks to Live through the Live API.

```
┌──────────────────────── ClaudeCopilot.amxd (one device) ────────────────────────┐
│                                                                                  │
│   jweb  ────────────►  node.script (Node-for-Max)  ────────►  v8 (LiveAPI)        │
│   chat UI   user msg   • Anthropic tool-use loop      reqId    • runs on Live's    │
│   (chat.html)          • streams tokens back          round-   main thread        │
│        ◄───────────────  • dispatches tool calls      trip     • notes, mixer,     │
│           assistant      • chord/mixing engine                 device params,      │
│           tokens          (core/*.js, pure + tested)           browser/sounds      │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲                                                            │
        │ Anthropic Messages API (HTTPS, streaming)                  ▼
     api.anthropic.com                                          Ableton Live 12
```

## What it can do

- **Choose sounds** — `load_instrument` / `load_audio_effect` search Live's browser by
  description ("warm analog pad", "Glue Compressor") and load onto a track.
- **Mix individual tracks** — `set_mixer` (volume/pan/sends/mute/solo), `set_eq_band`,
  `set_compressor`, and generic `set_device_param` for anything else.
- **Control any device** — `list_devices` / `get_device_params` to discover, then set.
  VST/AU plug-ins work too once you **Configure** their knobs in Live (the copilot
  walks you through it); add your go-to plug-ins (FabFilter, Ozone…) as favorites in ⚙.
- **HEAR the whole set** — `place_meters` drops a ClaudeMeter analyzer on every track,
  every return bus, and the master: loudness + 4-band spectrum + WHEN in the song each
  track plays. `record_tracks` multitracks the whole song to wavs and
  `analyze_recordings` dissects them as a group (full FFT, low-end clashes, active
  bars) — then it cleans up after itself.
- **Master a song** — maps every chain (`get_device_chains`), checks plug-in order,
  reorders with `move_device`, processes the master bus, verifies by listening.
- **Create notes & chords** — `write_chords` (voice-led, register-aware spread
  voicings, real cadences), `write_melody` (motif-based A A′ B A″ phrasing), and raw
  `write_notes` for drums/bass.
- **Drive the session** — `get_session`, `list_tracks`, `create_track`, `fire_clip`, `transport`.
- **Use local LLMs (beta)** — ⚙ settings can point the agent at Ollama, LM Studio,
  llama.cpp, Jan, or GPT4All instead of the Claude API. Untested per provider; tool
  calling depends on the model.

## Install

```bash
node scripts/build-device.js   # bake the .amxd (absolute paths to this repo)
bash scripts/install.sh        # bake + test + copy into your Ableton User Library
```

Then in Live 12: browser → **Places ▸ User Library ▸ Presets ▸ Audio Effects ▸ Max
Audio Effect ▸ Claude Copilot** → drag onto a track. Click ⚙ in the panel and paste your
Anthropic API key once (stored in `~/.claude-copilot/config.json`, never inside the device).

> The device loads its brain (`device/chat.html`, `device/node/main.js`,
> `device/v8/liveapi.js`) from this repo by **absolute path** — no Freeze needed for
> personal use. If you move the repo, re-run `install.sh`. To share the device with
> someone else, open it in Max and **Freeze** (bundles the files).

## Try it

- "What's on each track right now?"
- "Write a dreamy Cmaj7–Am7–Dm7–G7 progression on track 2, voice-led."
- "Load a warm analog pad on track 3 and play it."
- "Track 1 sounds muddy — add an EQ Eight and cut the low-mids."
- "Set up a 4:1 glue compressor on the drum bus with a slow attack."
- "Write a syncopated 808 bassline in F minor under these chords."

## Layout

| path | what |
|---|---|
| `core/theory.js`, `core/chords.js` | music theory + chord/voicing/voice-leading engine (pure, tested) |
| `core/tools.js` | the tool catalog Claude sees + dispatch to Live ops |
| `core/agent.js` | Claude tool-use loop (streaming + prompt caching) |
| `core/anthropic.js` | dependency-free streaming Messages API client |
| `device/chat.html` | the in-Ableton chat UI (jweb) |
| `device/node/main.js` | node.script entry: wires UI ↔ agent |
| `device/node/maxBridge.js` | awaitable request-id bridge to the LiveAPI executor |
| `device/v8/liveapi.js` | the `v8` LiveAPI executor (runs on Live's main thread) |
| `tools/amxd.js` | `.amxd` pack/unpack (validated byte-for-byte vs a real device) |
| `scripts/build-device.js` | generates the `.amxd` patcher |
| `scripts/test-offline.js` | tool-dispatch tests against a mock Ableton |

## Tests

```bash
node core/chords.test.js     # 20 music-engine assertions
node scripts/test-offline.js # 19 tool-dispatch assertions (mock Live)
```

The Node brain is fully tested offline. The in-Live pieces (jweb / node.script / v8)
are written to Live-API calls verified against Cycling '74 + Ableton docs, but can only
be exercised inside Live — see **Troubleshooting** if something doesn't wire up.

## Troubleshooting

- **Panel is blank.** jweb didn't load `chat.html`. Open the device in Max (Edit button),
  confirm the `url` message points at an existing absolute path. Alternative load message:
  `readfile <path>`.
- **"agent" dot stays red.** `node.script` didn't start. In Max's console check for the
  "Claude Copilot agent started" line. Verify Max's bundled Node is ≥18 (the client uses
  `https`, so older is usually fine). Confirm the absolute path to `main.js` is correct.
- **"Ableton" dot goes red on a tool.** The `v8` executor errored. If your Max predates
  the `v8` object, change `v8` → `js` in `scripts/build-device.js` and re-bake. If a
  LiveAPI path errors, it's surfaced in the chat with the message.
- **Nothing happens on a parameter set.** Stock-device parameter names vary; the copilot
  discovers them at runtime via `get_device_params`. If a name didn't match, it reports a
  warning — tell it the exact parameter name.
- **Key issues.** Paste the key via ⚙, or `export ANTHROPIC_API_KEY=…` before launching Live.

## Credits / references

- `.amxd` binary format cross-checked against [ktamas77/js2max](https://github.com/ktamas77/js2max)
  and a real device, byte-for-byte.
- Architecture validated against the shipping **Producer Pal** design (Node-for-Max +
  LiveAPI over patch cords); this is a clean-room reimplementation.
