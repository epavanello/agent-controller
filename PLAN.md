# Agent Controller — Piano di implementazione (ver. finale)

Orchestratore di agenti (Claude + Codex) pilotato da un DualSense, ispirato al tweet:
L2/R2 per cambiare agente, L1/R1 per cambiare sessione, tasto mic per parlare alla
sessione, speaker del controller per gli annunci, luce per-agente, vibrazione quando
l'agente chiede input.

## Fattibilità (verificata su questa macchina e sul codebase `codex-controller`)

| Feature tweet | Fattibile | Come |
|---|---|---|
| L2/R2 → switch agente, L1/R1 → switch sessione | SÌ | GameController framework: shoulder (L1/R1) e trigger (L2/R2) già provati in `ControllerMonitor.swift` |
| Luce per-agente + pulse mentre lavora | SÌ | `GCController.light` (API pubblica) + timer JS che alterna il colore |
| Vibrazione quando serve input | SÌ | CoreHaptics (`playFeedback`) |
| Speaker annuncia agente/sessione | SÌ (solo USB) | Il DualSense espone un output CoreAudio 4-canali SOLO via USB (su macOS il BT non ha route audio). Pattern copiato: `DualSenseUSBSpeaker` (report HID `0x02` `0xa0 0x80 …` per la cassa interna) + `TemporaryDefaultAudioDevice` + `afplay`. TTS = `/usr/bin/say -o file.aiff` |
| Mic button → parla alla sessione | SÌ (solo USB) | Input CoreAudio 2-canali + report di route (`DualSenseUSBMicrophone`). Trascrizione: `SFSpeechRecognizer` nativo (gratuito, on-device) |
| Tasto mic (mute) del DualSense | SÌ (raw HID) | Non esposto da GameController: letto dal report HID USB `0x01`, byte 10 bit `0x02` (`DS_BUTTONS2_MIC`) |
| Enumerare sessioni per agente | SÌ (CLI) | File JSONL: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` e `~/.claude/projects/<cwd-enc>/<uuid>.jsonl`. Le app desktop non offrono API pubbliche ⇒ sessioni CLI (`codex`, `claude`, entrambe installate) |
| Rilevare "sta lavorando" / "serve input" | SÌ | Decodifica dell'ultima porzione del JSONL: Codex `event_msg` `task_start`/`task_complete` (con `last_agent_message`); Claude ultimo messaggio `assistant` con `stop_reason` `tool_use` vs `end_turn` |
| Mandare il testo trascritto alla sessione | SÌ | `codex exec resume <id> "<testo>"` e `claude -p --resume <id> "<testo>"` (verificato con `--help`), processo detached |

### Comportamento ibrido (USB vs Bluetooth)
- **USB**: tutto attivo — cassa (annunci TTS), mic (push-to-talk + trascrizione), tasto mic
  HID leggibile anche durante la registrazione.
- **Bluetooth**: niente cassa e niente mic (limite macOS, non nostro). Luce, vibrazione e
  tutti i tasti funzionano. Il mic button dà una vibrazione di avviso e un messaggio HUD.

### Caveat onesti
- Trascrizione: `SFSpeechRecognizer` richiede il permesso Riconoscimento vocale (prompt
  al primo uso; l'app chiede anche il permesso microfono).
- Desktop app (Claude.app / Codex.app): sessioni non enumerabili senza API private ⇒
  fuori scope; si pilotano le sessioni CLI.
- Il titolo sessione è il primo messaggio utente (troncato a 80 caratteri).

## Architettura

Stesso pattern di `codex-controller`, ma minimale:

```
Electron main (TS strict, Zod come SSOT dei contratti)
 ├─ NativeBridge  (JSONL su stdin/stdout → helper Swift, pattern copiato)
 ├─ Orchestrator  (macchina a stati: agente, sessione, stato lavoro, luce/haptics/speaker)
 ├─ SessionStore  (scan + cache + watch dei JSONL CLI, titolo/stato decodificati)
 ├─ senders       (spawn codex/claude CLI detached per inoltrare il parlato)
 └─ Speaker       (coda TTS: say → bridge → cassa controller)
Swift helper `AgentControllerBridge` (pattern copiati/ridotti da codex-controller, MIT)
 ├─ eventi controller (GameController) + luce + haptics
 ├─ tasto mic (raw HID USB)
 ├─ cassa USB (copiato verbatim + play(file)) e mic USB (copiato verbatim)
 └─ VoiceRecorder (AVAudioRecorder su input DualSense + SFSpeechRecognizer)
Renderer Svelte 5 (electron-vite, NO React)
 ├─ HUD: agente corrente (colore), sessione, stato, cheatsheet, capabilities
 └─ UI components: shadcn-svelte via CLI (card, badge, separator, button)
```

Niente SvelteKit ⇒ niente load/actions/remote functions: il "server" è il main process
di Electron e le chiamate remote sono IPC. I contratti condivisi sono definiti **una
volta** come schemi Zod in `src/shared/contracts.ts` (SSOT): i tipi TS usati da main,
preload e renderer sono derivati con `z.infer`.

## Mapping fisso (nessun binding configurabile)

| Input | Azione |
|---|---|
| L2 | Agente Claude |
| R2 | Agente Codex |
| L1 | Sessione precedente (dell'agente corrente) |
| R1 | Sessione successiva |
| Mic (mute) | Tieni premuto: registra dal mic, rilascia: trascrive e invia alla sessione (solo USB; cap 30s) |
| Touchpad click | Riscansione sessioni |
| Share | Riannuncia agente + sessione via speaker |

## Colori

| Agente | Colore luce |
|---|---|
| Claude | `#f97316` (orange) |
| Codex | `#38bdf8` (sky) |

Stati luce: **lavorando** = pulse lento (800ms) del colore agente, **registrazione** =
pulse veloce (300ms), **attesa** = colore pieno. Transizione in attesa con domanda
aperta ⇒ vibrazione `warning` + speaker legge la domanda (max 220 caratteri).

## Layout

```
agent-controller/
  PLAN.md
  package.json / electron.vite.config.ts (plugin svelte + tailwind) / tsconfig (strict)
  native/Package.swift
    Sources/ControllerBridge/
      main.swift  NativeCommand.swift  NativeCommandLineProcessor.swift  BridgeWriter.swift
      ControllerMonitor.swift (ridotto)  ControllerPublishPayload.swift (ridotto)
      ControllerLightColor.swift  ControllerInputPublishPolicy.swift  ControllerPressPolicy.swift
      DualSenseHIDIdentity.swift  DualSensePhysicalDevicePolicy.swift
      MicButtonMonitor.swift (NUOVO: raw HID tasto mic)
      DualSenseUSBSpeaker.swift (+ play)  DualSenseUSBMicrophone.swift (+ inputDevice)
      AudioDeviceUID.swift  TemporaryDefaultAudioDevice.swift  DefaultAudioDeviceMarker.swift
      CoreAudioCopiedProperty.swift  AudioRouteSetter.swift (NUOVO)
      AgentSpeaker.swift (NUOVO: say + afplay in cassa)  VoiceRecorder.swift (NUOVO: STT)
  src/
    shared/contracts.ts  (Zod SSOT + tipi derivati)
    main/   index.ts  nativeBridge.ts  orchestrator.ts  sessions.ts  senders.ts  speaker.ts
    preload/index.ts
    renderer/  App.svelte (HUD)  main.css (tema)  lib/components/ui (shadcn-svelte)
```

## Ordine di lavoro (eseguito)
1. Scaffold `create @quick-start/electron` template svelte-ts via CLI
2. init shadcn-svelte via CLI (preset vega) + add card/badge/separator/button
3. Copia/riduzione Swift bridge, build `swift build` OK
4. Main process (bridge/orchestrator/sessions/senders/speaker), contratti Zod
5. Preload + HUD Svelte
6. Verifica: `typecheck` OK, `lint` OK, `build` OK, smoke `npm run dev` OK
   (bridge nativo in esecuzione, sessioni enumerate, speaker correttamente
   disattivato senza cavo USB)
