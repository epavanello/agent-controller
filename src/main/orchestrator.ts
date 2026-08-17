import { AGENTS } from '../shared/contracts'
import type {
  AgentId,
  AppSnapshot,
  AudioCapabilities,
  BridgeAudioEvent,
  BridgeControllerEvent,
  BridgeMicButtonEvent,
  ControllerSnapshot,
  SessionInfo,
  SessionState
} from '../shared/contracts'
import { emptyController, toTransport, unavailableAudio } from '../shared/contracts'
import type { NativeBridge } from './nativeBridge'
import { sendToSession } from './senders'
import { sanitizeForSpeech, SessionStore } from './sessions'
import type { Speaker } from './speaker'

const POLL_INTERVAL_MILLISECONDS = 2_500
const MAX_RECORDING_MILLISECONDS = 30_000
const MAX_QUESTION_SPEECH = 220
/** Longer than this, a closing message is summarised as "ha finito". */
const MAX_CLOSING_SPEECH = 220
const PULSE_INTERVAL_MILLISECONDS = 300

interface AgentState {
  sessions: SessionInfo[]
  index: number
  /**
   * The selection anchor. `index` alone cannot hold it: the list is sorted by
   * recency, so a session that receives a message jumps to the top and every
   * position below it shifts by one.
   */
  activeId: string | null
  lastStateBySession: Map<string, SessionState>
  /** Closing messages already seen, so a reply is announced exactly once. */
  lastMessageBySession: Map<string, string>
}

const dim = (hex: string, factor: number): string => {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16)
    return Math.round(channel * factor)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`
}

/**
 * The id suffix of a fallback title (`progetto · 019f95ab`) disambiguates in
 * the HUD, but read aloud it is a hex spelling nobody can follow.
 */
const withoutSessionId = (title: string): string => {
  const stripped = title.replace(/\s*·\s*[0-9a-f]{6,}$/i, '').trim()
  if (stripped && !/^Sessione\s+[0-9a-f]{6,}$/i.test(stripped)) return stripped
  return 'senza nome'
}

const announceSessionText = (agent: AgentId, session: SessionInfo): string =>
  `${AGENTS[agent].name}. ${withoutSessionId(sanitizeForSpeech(session.title, 60))}`

export class Orchestrator {
  private agent: AgentId = 'claude'
  private readonly byAgent: Record<AgentId, AgentState> = {
    claude: {
      sessions: [],
      index: -1,
      activeId: null,
      lastStateBySession: new Map(),
      lastMessageBySession: new Map()
    },
    codex: {
      sessions: [],
      index: -1,
      activeId: null,
      lastStateBySession: new Map(),
      lastMessageBySession: new Map()
    }
  }
  private recording = false
  private recordingTimer: NodeJS.Timeout | null = null
  private pulseTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pulseOn = false
  private lightMode: string | null = null
  private controller: ControllerSnapshot = emptyController
  private audio: AudioCapabilities = unavailableAudio
  private lastAnnouncement: string | null = null
  private lastTranscription: string | null = null
  private lastError: string | null = null
  private readonly onSnapshot: (snapshot: AppSnapshot) => void

  constructor(
    private readonly bridge: NativeBridge,
    private readonly store: SessionStore,
    private readonly speaker: Speaker,
    onSnapshot: (snapshot: AppSnapshot) => void
  ) {
    this.onSnapshot = onSnapshot
    bridge.on('event', (event: { type: string; payload: unknown }) => {
      this.handleBridgeEvent(event)
    })
    bridge.on('restarted', () => {
      this.bridge.send('system.refresh')
    })
  }

  start(): void {
    this.bridge.send('system.refresh')
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MILLISECONDS)
    void this.poll()
    this.publish()
  }

  /** Re-emits the current snapshot; the speaker uses it for the announcing flag. */
  publishSnapshot(): void {
    this.publish()
  }

  /** Single announcement path, so every spoken session is traceable to its file. */
  private announceSession(agent: AgentId, session: SessionInfo): void {
    console.info(
      `[orchestrator] ${agent} session ${session.id} (${session.state}) — ${session.path}`
    )
    void this.speaker.speak(announceSessionText(agent, session))
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.stopPulse()
    this.stopRecordingTimer()
  }

  selectAgent(agent: AgentId): void {
    this.agent = agent
    const state = this.byAgent[agent]
    this.haptic('layer')
    this.applyLight()
    const session = state.sessions[state.index]
    if (session) this.announceSession(agent, session)
    else void this.speaker.speak(AGENTS[agent].name)
    this.lastAnnouncement = session?.title ?? `${AGENTS[agent].name} (nessuna sessione)`
    this.publish()
  }

  selectSession(delta: -1 | 1): void {
    const state = this.byAgent[this.agent]
    if (state.sessions.length === 0) {
      this.haptic('failure')
      this.lastError = `Nessuna sessione ${AGENTS[this.agent].name} trovata.`
      this.publish()
      return
    }
    state.index = Math.min(state.sessions.length - 1, Math.max(0, state.index + delta))
    const session = state.sessions[state.index]
    state.activeId = session.id
    this.haptic('layer')
    this.applyLight()
    this.announceSession(this.agent, session)
    this.lastAnnouncement = session.title
    this.publish()
  }

  /** Mic button tap from the HUD. */
  toggleRecording(): void {
    this.handleMicButton(!this.recording)
  }

  rescan(): void {
    this.haptic('layer')
    void this.poll()
    const session = this.byAgent[this.agent].sessions[this.byAgent[this.agent].index]
    this.lastAnnouncement = session
      ? `Sessione: ${session.title}`
      : `Nessuna sessione ${AGENTS[this.agent].name} trovata`
    if (session) this.announceSession(this.agent, session)
    else void this.speaker.speak(`Nessuna sessione ${AGENTS[this.agent].name}`)
  }

  reannounce(): void {
    const session = this.byAgent[this.agent].sessions[this.byAgent[this.agent].index]
    if (session) this.announceSession(this.agent, session)
    else void this.speaker.speak(AGENTS[this.agent].name)
  }

  private handleBridgeEvent(event: { type: string; payload: unknown }): void {
    if (event.type === 'controller') {
      this.handleController(event.payload as BridgeControllerEvent)
    } else if (event.type === 'micbutton') {
      this.handleMicButton((event.payload as BridgeMicButtonEvent).pressed)
    } else if (event.type === 'audio') {
      this.audio = event.payload as BridgeAudioEvent
      if (!this.audio.microphone.available && this.recording) {
        this.finishRecording(true)
      }
      this.publish()
    } else if (event.type === 'error') {
      this.lastError = (event.payload as { message: string }).message
      this.publish()
    }
  }

  private handleController(event: BridgeControllerEvent): void {
    this.controller = {
      connected: event.connected,
      transport: toTransport(event.transport),
      batteryLevel: event.batteryLevel,
      supportsLight: event.supportsLight,
      supportsHaptics: event.supportsHaptics,
      lastInput: event.lastInput ?? null
    }
    if (event.lastInput && event.lastPressed === true) {
      this.handleButton(event.lastInput)
    }
    this.publish()
  }

  private handleButton(input: string): void {
    console.info(`[orchestrator] button ${input}`)
    switch (input) {
      case 'leftShoulder':
        this.selectSession(-1)
        break
      case 'rightShoulder':
        this.selectSession(1)
        break
      case 'leftTrigger':
        this.selectAgent('claude')
        break
      case 'rightTrigger':
        this.selectAgent('codex')
        break
      case 'touchpad':
        this.rescan()
        break
      case 'view':
        this.reannounce()
        break
    }
  }

  private handleMicButton(pressed: boolean): void {
    console.info(`[orchestrator] mic button ${pressed ? 'down' : 'up'}`)
    if (pressed) {
      if (this.recording) return
      if (!this.audio.microphone.available) {
        this.haptic('warning')
        this.lastError = `Mic e cassa richiedono il cavo USB. (${this.audio.microphone.reason})`
        this.publish()
        return
      }
      const session = this.activeSession()
      if (!session) {
        this.haptic('warning')
        this.lastError = `Nessuna sessione ${AGENTS[this.agent].name} selezionata.`
        this.publish()
        return
      }
      void this.startRecording()
    } else if (this.recording) {
      void this.finishRecording(false)
    }
  }

  private async startRecording(): Promise<void> {
    this.haptic('success')
    const result = await this.bridge.request('mic.start', undefined, 15_000)
    if (!result.success) {
      this.haptic('warning')
      this.lastError = result.message
      this.publish()
      return
    }
    this.recording = true
    this.startRecordingTimer()
    this.applyLight()
    this.publish()
  }

  private async finishRecording(cancelled: boolean): Promise<void> {
    this.stopRecordingTimer()
    const wasRecording = this.recording
    this.recording = false
    this.applyLight()
    this.publish()
    if (!wasRecording) return
    const result = await this.bridge.request('mic.stop', undefined, 60_000)
    if (cancelled) return
    if (!result.success) {
      this.haptic('warning')
      this.lastError = result.message
      this.publish()
      return
    }
    const transcription = result.message.trim()
    this.lastTranscription = transcription
    const session = this.activeSession()
    if (!transcription) {
      this.haptic('warning')
      this.lastError = 'Nessun parlato rilevato.'
      this.publish()
      return
    }
    if (!session) {
      this.haptic('warning')
      this.lastError = `Nessuna sessione ${AGENTS[this.agent].name} selezionata.`
      this.publish()
      return
    }
    this.haptic('success')
    sendToSession(this.agent, session, transcription)
    this.lastAnnouncement = `Inviato a ${AGENTS[this.agent].name}: ${session.title}`
    this.publish()
  }

  private activeSession(): SessionInfo | undefined {
    const state = this.byAgent[this.agent]
    return state.sessions[state.index]
  }

  private startRecordingTimer(): void {
    this.stopRecordingTimer()
    this.recordingTimer = setTimeout(() => {
      this.lastError = 'Registrazione interrotta (limite 30s).'
      void this.finishRecording(false)
    }, MAX_RECORDING_MILLISECONDS)
  }

  private stopRecordingTimer(): void {
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer)
      this.recordingTimer = null
    }
  }

  private async poll(): Promise<void> {
    const agents: AgentId[] = ['claude', 'codex']
    for (const agent of agents) {
      const sessions = await this.store.list(agent)
      const state = this.byAgent[agent]
      const previousBySession = new Map(state.lastStateBySession)
      const previousMessages = new Map(state.lastMessageBySession)
      state.lastStateBySession = new Map(sessions.map((s) => [s.id, s.state]))
      state.lastMessageBySession = new Map(sessions.map((s) => [s.id, s.lastMessage ?? '']))
      const previousIndex = state.index
      state.sessions = sessions
      if (sessions.length === 0) {
        state.index = -1
        state.activeId = null
      } else if (state.activeId === null) {
        state.index = 0
        state.activeId = sessions[0].id
        if (agent === this.agent) {
          this.haptic('layer')
          this.applyLight()
          const session = sessions[0]
          this.lastAnnouncement = `Sessione: ${session.title}`
          this.announceSession(agent, session)
        }
      } else {
        // Follow the selected session across the re-sort; only if it is gone
        // does the position matter, and then just to stay in range.
        const found = sessions.findIndex((session) => session.id === state.activeId)
        state.index =
          found === -1 ? Math.min(Math.max(previousIndex, 0), sessions.length - 1) : found
        state.activeId = sessions[state.index].id
      }

      // Announce activity on the *active* session only. A short turn can begin
      // and end between two polls, so a new closing message counts as activity
      // even when the state never appeared to change.
      const active = sessions[state.index]
      if (active && agent === this.agent) {
        const previousState = previousBySession.get(active.id)
        const previousMessage = previousMessages.get(active.id)
        const changedState = previousState !== undefined && previousState !== active.state
        const answered =
          previousMessage !== undefined &&
          previousMessage !== (active.lastMessage ?? '') &&
          active.state === 'waiting'
        if (changedState || answered) this.announceActivity(active)
      }
    }
    this.applyLight()
    this.publish()
  }

  private announceActivity(session: SessionInfo): void {
    const name = AGENTS[this.agent].name
    if (session.state === 'working') {
      this.lastAnnouncement = `${name} sta lavorando: ${session.title}`
      return
    }
    if (session.state !== 'waiting') return
    this.haptic('warning')
    if (session.question) {
      const question = sanitizeForSpeech(session.question, MAX_QUESTION_SPEECH, true)
      this.lastAnnouncement = `${name} chiede: ${question}`
      void this.speaker.speak(`${name} chiede. ${question}`)
      return
    }
    // A closing message is worth hearing only while it still fits in one
    // breath: past that it is a report to read, not an announcement.
    const closing = session.lastMessage
      ? sanitizeForSpeech(session.lastMessage, MAX_CLOSING_SPEECH + 1, true)
      : ''
    if (closing && closing.length <= MAX_CLOSING_SPEECH) {
      this.lastAnnouncement = `${name} ha finito: ${closing}`
      void this.speaker.speak(`${name} ha finito. ${closing}`)
      return
    }
    this.lastAnnouncement = `${name} ha finito: ${session.title}`
    void this.speaker.speak(`${name} ha finito.`)
  }

  /**
   * Idempotent: the poll loop calls this every tick, so re-applying an
   * unchanged mode must not restart the pulse — that would reset its phase and
   * stretch every poll boundary into a visible pause.
   */
  private applyLight(): void {
    const color = AGENTS[this.agent].color
    const active = this.activeSession()
    const pulsing = this.recording || active?.state === 'working'
    const mode = pulsing ? `pulse:${color}` : `steady:${color}`
    if (mode === this.lightMode) return
    this.stopPulse()
    this.lightMode = mode
    if (pulsing) this.startPulse(PULSE_INTERVAL_MILLISECONDS)
    else this.bridge.send('light.set', { color })
  }

  private startPulse(intervalMilliseconds: number): void {
    if (this.pulseTimer) return
    this.pulseOn = true
    const color = AGENTS[this.agent].color
    this.bridge.send('light.set', { color: dim(color, 0.35) })
    this.pulseTimer = setInterval(() => {
      this.pulseOn = !this.pulseOn
      this.bridge.send('light.set', {
        color: this.pulseOn ? color : dim(color, 0.35)
      })
    }, intervalMilliseconds)
  }

  private stopPulse(): void {
    this.lightMode = null
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer)
      this.pulseTimer = null
    }
  }

  private haptic(tone: 'success' | 'failure' | 'warning' | 'layer'): void {
    this.bridge.send('haptics.play', { tone })
  }

  private publish(): void {
    const state = this.byAgent[this.agent]
    const active = state.sessions[state.index]
    this.onSnapshot({
      agent: this.agent,
      sessions: state.sessions,
      sessionIndex: state.index,
      activeSessionId: active?.id ?? null,
      activeSessionState: active?.state ?? null,
      recording: this.recording,
      announcing: this.speaker.isAnnouncing,
      controller: this.controller,
      audio: this.audio,
      bridgeAvailable: this.bridge.isAvailable,
      lastAnnouncement: this.lastAnnouncement,
      lastTranscription: this.lastTranscription,
      lastError: this.lastError
    })
  }
}
