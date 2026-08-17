# Agent Controller

Orchestratore di agenti pilotato da un DualSense: L2/R2 per cambiare agente
(Claude/Codex), L1/R1 per cambiare sessione, tasto mic per parlare alla sessione,
annunci vocali nella cassa del controller, luce colorata per agente e vibrazione
quando l'agente chiede input.

Gestisce le sessioni Claude aperte da terminale, VS Code/Cursor e Claude Desktop,
oltre alle sessioni Codex (`~/.codex/sessions`).

> [!IMPORTANT]
> Progetto indipendente, non affiliato a Anthropic, OpenAI o Sony. I pattern nativi
> sono derivati da [codex-controller](https://github.com/ParthJadhav/codex-controller)
> (MIT, © Parth Jadhav).

## Requisiti

- macOS 14+
- DualSense (USB per cassa e microfono; in Bluetooth funzionano solo tasti, luce e vibrazione)
- Node.js 22+, Xcode command-line tools
- `codex` e/o `claude` CLI nel PATH (o in `~/.local/bin`)

## Sviluppo

```sh
npm install
npm run native:build   # compila l'helper Swift
npm run dev
```

## Sessioni Claude

Claude Code pubblica i processi vivi in `~/.claude/sessions`. Agent Controller unisce
quel registro con i transcript in `~/.claude/projects` e con l'indice di Claude
Desktop, ordinando tutto per ultima attività.

Quando una sessione è viva, il parlato entra nel suo socket Unix autenticato: è lo
stesso input stream posseduto da terminale, VS Code o Desktop. Se la sessione è
offline, Agent Controller esegue un solo `claude --resume` headless e lascia che sia
Claude a persistere l'intero turno. I file `.jsonl` non vengono mai modificati
direttamente.

Per l'invio live serve una versione recente di Claude Code che pubblichi
`messagingSocketPath`. Se un processo vecchio è ancora aperto, l'app rifiuta l'invio
invece di creare due proprietari della stessa sessione: aggiorna Claude Code e riapri
quella sessione.

## Mapping

| Input               | Azione                                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| L2 / R2             | Agente Claude / Codex                                                        |
| L1 / R1             | Sessione precedente / successiva                                             |
| Mic (tieni premuto) | Registra dal mic del controller; al rilascio trascrive e invia alla sessione |
| Touchpad            | Riscansiona le sessioni                                                      |
| Share               | Riannuncia agente e sessione in cassa                                        |

## Note

- La trascrizione usa `SFSpeechRecognizer` (on-device): concedi il permesso
  Riconoscimento vocale al primo uso.
- Luce: colore pieno = in attesa, pulse lento = sta lavorando, pulse veloce = registrazione.
- Se l'agente termina il turno con una domanda: vibrazione + domanda letta in cassa.
