# Agent Controller

**Drive your live Claude Code and Codex sessions from a DualSense — without looking at a screen.**

Agent Controller finds every coding-agent session running on your Mac, puts them on one
list, and hands the whole list to a game controller: triggers switch agent, shoulders
switch session, the mic button talks to the selected one. The controller's speaker reads
the agent's answer back, its light shows what the agent is doing, and it vibrates when the
agent stops and asks you something.

> [!IMPORTANT]
> Independent project. Not affiliated with Anthropic, OpenAI or Sony.

## What nobody else does

The multi-agent tooling that exists today — TUIs, kanban boards, worktree runners,
session browsers — is built around a screen you keep staring at, and around _spawning_
agents in parallel. Agent Controller inverts both:

|           | Everyone else                 | Agent Controller                                                |
| --------- | ----------------------------- | --------------------------------------------------------------- |
| Interface | Terminal UI / web dashboard   | A game controller you hold while doing something else           |
| Input     | Typing                        | Push-to-talk from the controller's own microphone               |
| Output    | Text you read                 | Speech in the controller's speaker, light, haptics              |
| Sessions  | New agents it launched itself | The sessions **you** already started, wherever you started them |
| Delivery  | A fresh CLI process per task  | The authenticated input socket of the live session              |

The last row is the technical heart of it. When a Claude session is alive, the spoken
message goes into that process's own messaging socket — the same input stream the
terminal, VS Code or Claude Desktop is holding. You are not starting a second agent on the
same transcript, you are typing into the one that is already running, from across the room.

## The use case it wins

You have three or four agents working. You are not at the keyboard — you are on the couch,
at the whiteboard, making coffee. One of them finishes and asks a question.

1. The controller vibrates and reads the question out loud in its speaker.
2. You press L2/R2 to be sure which agent it was, L1/R1 to walk the session list; each
   session announces itself as you land on it.
3. You hold the mic button and answer out loud.
4. The transcription goes straight into that live session and the agent keeps going.

No window, no keyboard, no context switch. Long autonomous runs stop being something you
babysit and start being something you supervise.

## Requirements

- macOS 14+
- A DualSense controller. **USB** for speaker and microphone; over Bluetooth you still get
  buttons, light and haptics, but macOS exposes no audio route for the controller.
- Node.js 22+ and Xcode command-line tools
- `claude` and/or `codex` in `PATH` (or in `~/.local/bin`)

## Development

```sh
npm install
npm run native:build   # builds the Swift helper
npm run dev
```

## Controls

| Input             | Action                                                          |
| ----------------- | --------------------------------------------------------------- |
| L2 / R2           | Switch to the Claude / Codex agent                              |
| L1 / R1           | Previous / next session                                         |
| Mic button (hold) | Record from the controller mic; on release, transcribe and send |
| Touchpad click    | Rescan sessions                                                 |
| Share             | Announce the current agent and session again                    |
| ← → / ↑ ↓         | Same as L2/R2 and L1/R1, from the keyboard                      |

Light: solid colour = waiting, slow pulse = the agent is working, fast pulse = recording.
Orange is Claude, sky blue is Codex.

## How sessions are found

Claude Code publishes its live processes in `~/.claude/sessions`. Agent Controller merges
that registry with the transcripts in `~/.claude/projects` and with the Claude Desktop
index, then adds the Codex rollouts in `~/.codex/sessions`, and sorts everything by last
activity. Sessions started from a terminal, from VS Code/Cursor and from Claude Desktop all
show up the same way.

Delivery picks the safest route available:

- **Live session** → the message is written to that process's authenticated Unix socket.
- **Offline session** → one headless `claude --resume` / `codex exec resume`, letting the
  agent itself persist the whole turn.

The `.jsonl` transcripts are never edited directly. If an old Claude Code process still
owns a session but does not publish `messagingSocketPath`, delivery is refused rather than
creating two owners of the same session — update Claude Code and reopen that session.

## Configuration

The interface is English. Speech is not, so the spoken languages are configurable in

```
~/Library/Application Support/Agent Controller/config.json
```

written with defaults on first launch:

```json
{
  "speech": {
    "language": "en-US",
    "ttsLanguage": null,
    "ttsVoice": null,
    "sttLanguage": null
  }
}
```

- `language` — BCP-47 tag used for both directions unless overridden.
- `sttLanguage` — dictation only. This is the one to set when you speak a language other
  than the interface: the speech recogniser otherwise follows the Mac's own locale and
  turns your sentence into nonsense words.
- `ttsLanguage` / `ttsVoice` — announcements only. Without a voice name, the macOS voice
  you already use is kept whenever it speaks the right language; otherwise the first
  installed voice for that locale is picked. `say -v '?'` lists the valid names.

Announcements built by the app ("Claude. Fix the parser. Working.") are English. What the
agent itself wrote — its closing message, its open question — is read back in whatever
language it was written in, which is why the voice is worth setting.

Changes are read at startup: restart the app after editing.

## Notes and limits

- Transcription uses on-device `SFSpeechRecognizer`. macOS asks for Speech Recognition and
  Microphone permission on first use.
- Over Bluetooth the speaker and mic panels report as unavailable by design.
- A session whose transcript claims "working" but has been silent for minutes is shown as
  stale rather than trusted.

## Credits

The native DualSense patterns — HID identity, the USB speaker and microphone routes, the
borrow/restore of the default audio device — are derived from
[codex-controller](https://github.com/ParthJadhav/codex-controller) (MIT, © Parth Jadhav).
That is a sibling project by another author, not one of mine: it is where the idea of
driving a coding agent from a DualSense came from, and its Swift bridge is what made the
audio side of this one feasible. Everything above it — multi-agent session discovery, live
socket delivery, the orchestrator, the HUD — is this project's own.
