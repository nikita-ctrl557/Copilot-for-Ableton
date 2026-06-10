# Claude_Copilot — Ableton MIDI Remote Script.
# Gives Claude Copilot a way to LOAD devices/instruments/effects from Live's browser,
# which Max for Live's LiveAPI cannot reach on Live 12. It opens a localhost socket
# the node backend connects to; all Live API work runs on the main thread.
from .ClaudeCopilot import ClaudeCopilot


def create_instance(c_instance):
    return ClaudeCopilot(c_instance)
