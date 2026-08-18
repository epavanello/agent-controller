<div align="center">

# Agent Controller

### Your coding agents, on a game controller.

Hear what Claude Code and Codex are doing, answer them out loud, switch between them —
without touching the keyboard.

![The Agent Controller HUD](docs/hud.png)

</div>

## Why

Every other multi-agent tool is a screen you have to watch, running agents _it_ spawned.
Agent Controller drives the sessions **you already have open** — terminal, VS Code, Cursor,
Claude Desktop — from a DualSense, across the room.

- 🔊 **It talks.** The controller's speaker reads the agent's reply, or the question it is stuck on.
- 🎙️ **You talk back.** Hold the mic button, say it, it lands in the live session.
- 📳 **It taps you.** Haptics the moment an agent needs you. The light says who is working.

## The moment it pays off

Four agents running. You are on the couch.

1. **Buzz.** The controller reads out loud: _"Should I drop the legacy column?"_
2. **L1 / R1** to walk the list — every session announces itself as you land on it.
3. **Hold Mic:** _"Yes, but keep a backup table first."_
4. It goes into that running session and the agent keeps going. No window, no keyboard.

## It is not a second agent

When a Claude session is alive, your words go into **that process's own messaging socket** —
the same input stream its terminal or editor is holding. You are not resuming a transcript in
a parallel process, you are typing into the agent that is already running.

Offline sessions fall back to a single headless `claude --resume` / `codex exec resume`.
Transcript files are never edited by hand.

## Install

macOS 14+, Node 22+, Xcode command-line tools, and `claude` and/or `codex` in your `PATH`.

```sh
git clone https://github.com/EmaDev/agent-controller && cd agent-controller
npm install
npm run native:build   # Swift helper for controller, speaker and mic
npm run dev
```

Want an app instead of a dev server: `npm run native:build:release && npm run build:mac`
drops a `.dmg` in `dist/`.

> **DualSense over USB** for speaker and mic — macOS exposes no audio route for it over
> Bluetooth. Buttons, light and haptics work either way.

## Controls

|                |                                         |
| -------------- | --------------------------------------- |
| **L2 / R2**    | Claude / Codex                          |
| **L1 / R1**    | Previous / next session                 |
| **Mic (hold)** | Record, release to transcribe and send  |
| **Touchpad**   | Rescan                                  |
| **Share**      | Say the current agent and session again |
| **← → / ↑ ↓**  | The same, from the keyboard             |

Solid light = waiting · slow pulse = working · fast pulse = recording.
Orange is Claude, sky blue is Codex. The HUD lists all of this too.

## Voice language

The interface is English; your voice does not have to be. Pick the language in the
**Controller** panel — it sets both the announcements and the dictation, and only lists
languages your Mac actually has a voice for.

Power users: it lives in `~/Library/Application Support/Agent Controller/config.json`, where
`ttsLanguage`, `ttsVoice` (any name from `say -v '?'`) and `sttLanguage` can be set apart
if you want to dictate in one language and listen in another.

## Good to know

- Transcription is on-device (`SFSpeechRecognizer`). macOS asks for Microphone and Speech
  Recognition permission on first use.
- In `npm run dev` macOS calls the app "Electron" — that is the stock dev bundle. A packaged
  build is called Agent Controller.
- A session claiming "working" but silent for minutes is shown as **stale**, not trusted.
- If an old Claude Code process owns a session without publishing a messaging socket, sending
  is refused rather than creating two owners. Update Claude Code and reopen it.

## Releasing a build others can open

`npm run build:mac` signs with whatever Developer ID is in your keychain, but macOS also
wants the app **notarized** or Gatekeeper refuses to open it on another Mac
(`spctl -a -t exec` says _Unnotarized Developer ID_).

Store the credentials once, in the keychain, so no secret ever reaches the repo:

```sh
xcrun notarytool store-credentials agent-controller \
  --apple-id "<the Apple ID that owns the Developer Program membership>" \
  --team-id "<your 10-character team id>" \
  --password "<an app-specific password from appleid.apple.com>"
```

Then every release is:

```sh
export APPLE_KEYCHAIN_PROFILE=agent-controller
rm -rf dist && npm run build:mac          # signs, uploads, staples: a few minutes
spctl -a -vvv -t exec "dist/mac-arm64/Agent Controller.app"   # expect: accepted
```

Without those variables the build still succeeds — it logs that notarization was skipped and
produces a signed-but-unnotarized app, which is fine for running it yourself.

## Credits

The native DualSense work — HID identity, USB speaker and microphone routes, borrowing and
restoring the default audio device — is derived from
[codex-controller](https://github.com/ParthJadhav/codex-controller) (MIT, © Parth Jadhav), a
sibling project by another author. That is where the idea of driving a coding agent from a
DualSense comes from. Multi-agent discovery, live socket delivery, the orchestrator and the
HUD are this project's own.

Independent project. Not affiliated with Anthropic, OpenAI or Sony.
[MIT](LICENSE).
