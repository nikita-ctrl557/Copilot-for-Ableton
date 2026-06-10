#!/usr/bin/env bash
# install.sh — bake ClaudeCopilot.amxd with absolute paths to this repo's brain,
# then copy it into Ableton's User Library so it shows up in Live's browser.
# Re-run any time you move the repo. Safe + reversible (it only copies one file).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_LIB="$HOME/Music/Ableton/User Library"
DEST_DIR="$USER_LIB/Presets/Audio Effects/Max Audio Effect"
DEVICE="$REPO/device/ClaudeCopilot.amxd"

echo "▸ Claude Copilot for Ableton — install"
echo "  repo: $REPO"

# 1. node present?
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node 18+ (https://nodejs.org) and re-run." >&2
  exit 1
fi

# 2. install Node deps for subscription mode (Claude Agent SDK + zod)
echo "▸ installing agent deps (subscription mode)…"
( cd "$REPO/device/node" && npm install --no-audit --no-fund --loglevel=error ) \
  && echo "  ✓ device/node/node_modules" \
  || echo "  ! npm install failed — subscription mode needs it; API-key mode still works"

# 3. bake the devices (absolute paths to chat.html / main.js / liveapi.js / meter)
echo "▸ baking devices…"
node "$REPO/scripts/build-device.js" >/dev/null && echo "  ✓ ClaudeCopilot.amxd"
node "$REPO/scripts/build-meter.js" >/dev/null && echo "  ✓ ClaudeMeter.amxd"
node "$REPO/scripts/build-window.js" >/dev/null && echo "  ✓ ClaudeCopilotWindow.amxd"

# 3. self-tests (fast, offline)
echo "▸ running tests…"
node "$REPO/core/chords.test.js"   >/dev/null && echo "  ✓ chord engine"
node "$REPO/scripts/test-offline.js" >/dev/null && echo "  ✓ tool dispatch"

# 4. copy into the User Library
if [ ! -d "$USER_LIB" ]; then
  echo "✗ Ableton User Library not found at: $USER_LIB" >&2
  echo "  Open Live > Preferences > Library to find yours, then copy $DEVICE there." >&2
  exit 1
fi
mkdir -p "$DEST_DIR"
cp "$DEVICE" "$DEST_DIR/"
cp "$REPO/device/ClaudeMeter.amxd" "$DEST_DIR/" 2>/dev/null && echo "  ✓ ClaudeMeter.amxd installed"
cp "$REPO/device/ClaudeCopilotWindow.amxd" "$DEST_DIR/" 2>/dev/null && echo "  ✓ ClaudeCopilotWindow.amxd installed"

# 6. install the Python remote script (the loader — it can reach Live's browser, which M4L can't)
RS_DIR="$USER_LIB/Remote Scripts/Claude_Copilot"
mkdir -p "$RS_DIR"
cp "$REPO/remote_script/Claude_Copilot/"*.py "$RS_DIR/" 2>/dev/null && echo "  ✓ Claude_Copilot remote script installed"
cat <<'RS'

  ►► ONE-TIME: enable the loader so Claude can load + edit devices ◄◄
     Live ▸ Settings ▸ Link/Tempo/MIDI ▸ Control Surface ▸ pick "Claude_Copilot"
     (Input/Output = None), then QUIT + reopen Live once (it only scans at startup).
     On first run macOS may ask to allow incoming connections → Allow.

  ►► VERIFY it actually works (talks straight to Live, bypasses everything else): ◄◄
     node scripts/diagnose.js          # read-only: is the loader running? what does it see?
     node scripts/diagnose.js --load 0 # actually load a Reverb onto track 0 as a live test
RS
echo "▸ installed to User Library:"
echo "  $DEST_DIR/ClaudeCopilot.amxd"

# 5. optional: seed the API key from the environment — only on FIRST install
# (an existing config carries favorites/local-LLM/voice settings; never overwrite it)
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.claude-copilot/config.json" ]; then
  mkdir -p "$HOME/.claude-copilot"
  printf '{\n  "apiKey": "%s",\n  "model": "claude-fable-5"\n}\n' "$ANTHROPIC_API_KEY" > "$HOME/.claude-copilot/config.json"
  chmod 600 "$HOME/.claude-copilot/config.json"
  echo "  ✓ seeded API key from \$ANTHROPIC_API_KEY"
fi

cat <<EOF

✓ Done. In Ableton Live 12:
  1. Show the browser (⌘+Alt+B). Open  Places ▸ User Library ▸ Presets ▸ Audio Effects ▸ Max Audio Effect.
  2. Drag  Claude Copilot  onto any track (an empty MIDI track is a good home).
  3. The chat panel appears in the device. Click ⚙ and paste your Anthropic API key (once).
  4. Try:  "what's on each track?"  or  "write a Cmaj7–Am7–Dm7–G7 progression on this track".

Tip: keep this repo where it is — the device loads its brain from
  $REPO/device  (chat.html, node/main.js, v8/liveapi.js)
If you move the repo, re-run this script.
EOF
