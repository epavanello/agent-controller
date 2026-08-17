import { z } from 'zod'

export const AgentIdSchema = z.enum(['claude', 'codex'])
export type AgentId = z.infer<typeof AgentIdSchema>

export interface AgentMeta {
  id: AgentId
  name: string
  color: string
}

export const AGENTS = {
  claude: { id: 'claude', name: 'Claude', color: '#f97316' },
  codex: { id: 'codex', name: 'Codex', color: '#38bdf8' }
} as const satisfies Record<AgentId, AgentMeta>

export const SessionStateSchema = z.enum(['working', 'waiting', 'offline', 'unknown'])
export type SessionState = z.infer<typeof SessionStateSchema>

/**
 * What the HUD shows and the speaker reads. `stale` is not a recorded state:
 * a transcript whose last line says "working" but that nothing has written to
 * in a long while is a leftover marker, not a running turn.
 */
export type SessionDisplayState = SessionState | 'stale'

/** A recorded "working" nothing has written to for this long is a leftover. */
export const STALE_WORKING_AFTER_MILLISECONDS = 5 * 60_000

/**
 * Past this much silence any recorded state is too old to trust. Waiting for
 * an answer stays "in attesa" meanwhile: that is still what it is doing.
 */
export const STALE_AFTER_MILLISECONDS = 6 * 60 * 60_000

export const SESSION_STATE_LABELS: Record<SessionDisplayState, string> = {
  working: 'Sta lavorando',
  waiting: 'In attesa',
  stale: 'Stale',
  offline: 'Offline',
  unknown: 'Sconosciuto'
}

/**
 * Single source for the state named in the list and in the announcement: the
 * two must never disagree about the same session.
 */
export const displayStateOf = (
  session: Pick<SessionInfo, 'state' | 'updatedAt' | 'live'>,
  now: number
): SessionDisplayState => {
  if (session.state === 'offline') return 'offline'
  // A live owner reports its state over its socket: no need to second-guess it.
  if (session.live || session.updatedAt <= 0) return session.state
  const silence = now - session.updatedAt
  if (session.state === 'working') {
    return silence > STALE_WORKING_AFTER_MILLISECONDS ? 'stale' : 'working'
  }
  return silence > STALE_AFTER_MILLISECONDS ? 'stale' : session.state
}

export const SessionSurfaceSchema = z.enum(['terminal', 'vscode', 'desktop', 'unknown'])
export type SessionSurface = z.infer<typeof SessionSurfaceSchema>

export const SessionInfoSchema = z.object({
  id: z.string(),
  /** Absolute path of its transcript or, if absent, its discovery record. */
  path: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  state: SessionStateSchema,
  surface: SessionSurfaceSchema,
  live: z.boolean(),
  question: z.string().nullable(),
  /** The agent's closing message, read aloud when a turn ends. */
  lastMessage: z.string().nullable()
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

const looksLikePath = (token: string): boolean =>
  token.length > 3 && token.includes('/') && /^[./~]?[\w@.-]*(?:\/[\w@.-]+)+$/.test(token)

const looksLikeUrl = (token: string): boolean =>
  /^[a-z][\w+.-]*:\/\//i.test(token) || token.startsWith('www.')

export const truncate = (text: string, limit = 80): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/**
 * Makes text safe to read aloud: path-like tokens (`/var/folders/…`,
 * `./src/…`) and URLs are dropped, or replaced when the meaning depends on
 * them. Read literally they bury the sentence they belong to.
 *
 * Shared with the renderer on purpose: session titles are stored already
 * sanitized, so the list shows the exact words the speaker pronounces.
 */
export const sanitizeForSpeech = (text: string, limit: number, replacePaths = false): string => {
  const cleaned = text
    .split(/\s+/)
    .map((token) => {
      if (looksLikeUrl(token)) return replacePaths ? 'un link' : ''
      if (looksLikePath(token)) return replacePaths ? 'il percorso' : ''
      return token
    })
    .filter((token) => token.length > 0)
    .join(' ')
    .trim()
  return truncate(cleaned, limit)
}

/** The maximum length of a stored session title, spoken as-is. */
export const MAX_TITLE = 60

/**
 * The exact sentence spoken when a session becomes the selected one. The HUD
 * renders it verbatim, so what is heard and what is read are one string.
 */
export const announceSessionText = (
  agent: AgentId,
  session: Pick<SessionInfo, 'title' | 'state' | 'updatedAt' | 'live'>,
  now: number
): string => {
  // A title cut at the length limit ends in an ellipsis; spoken before the
  // state it turns into a stutter of dots.
  const title = session.title.replace(/[…\s.]+$/, '')
  return `${AGENTS[agent].name}. ${title}. ${SESSION_STATE_LABELS[displayStateOf(session, now)]}.`
}

export const TransportSchema = z.enum(['USB', 'Bluetooth', 'Unknown'])
export type Transport = z.infer<typeof TransportSchema>

export const ControllerSnapshotSchema = z.object({
  connected: z.boolean(),
  transport: TransportSchema,
  batteryLevel: z.number().nullable(),
  supportsLight: z.boolean(),
  supportsHaptics: z.boolean(),
  lastInput: z.string().nullable()
})
export type ControllerSnapshot = z.infer<typeof ControllerSnapshotSchema>

export const emptyController: ControllerSnapshot = {
  connected: false,
  transport: 'Unknown',
  batteryLevel: null,
  supportsLight: false,
  supportsHaptics: false,
  lastInput: null
}

export const AudioCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string()
})
export type AudioCapability = z.infer<typeof AudioCapabilitySchema>

export const AudioCapabilitiesSchema = z.object({
  speaker: AudioCapabilitySchema,
  microphone: AudioCapabilitySchema
})
export type AudioCapabilities = z.infer<typeof AudioCapabilitiesSchema>

export const unavailableAudio: AudioCapabilities = {
  speaker: { available: false, reason: 'Sconosciuto' },
  microphone: { available: false, reason: 'Sconosciuto' }
}

/** One agent's session list plus the selection L1/R1 moves through it. */
export const AgentSessionsSchema = z.object({
  sessions: z.array(SessionInfoSchema),
  index: z.number(),
  activeSessionId: z.string().nullable()
})
export type AgentSessions = z.infer<typeof AgentSessionsSchema>

export const AppSnapshotSchema = z.object({
  agent: AgentIdSchema,
  /** Both agents ship every tick: the HUD tabs show counts for the other one. */
  byAgent: z.object({
    claude: AgentSessionsSchema,
    codex: AgentSessionsSchema
  }),
  activeSessionState: SessionStateSchema.nullable(),
  recording: z.boolean(),
  announcing: z.boolean(),
  controller: ControllerSnapshotSchema,
  audio: AudioCapabilitiesSchema,
  bridgeAvailable: z.boolean(),
  lastAnnouncement: z.string().nullable(),
  lastTranscription: z.string().nullable(),
  lastError: z.string().nullable()
})
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>

/** A HUD click on a session row, which may belong to the other agent's tab. */
export const SelectSessionRequestSchema = z.object({
  agent: AgentIdSchema,
  id: z.string()
})
export type SelectSessionRequest = z.infer<typeof SelectSessionRequestSchema>

/** Payload of the bridge's `controller` event, as published by Swift. */
export const BridgeControllerEventSchema = z.object({
  connected: z.boolean(),
  id: z.string().optional(),
  name: z.string().optional(),
  productCategory: z.string().optional(),
  transport: z.string(),
  batteryLevel: z.number().nullable().catch(null),
  supportsLight: z.boolean().catch(false),
  supportsHaptics: z.boolean().catch(false),
  lastInput: z.string().optional(),
  lastPressed: z.boolean().optional()
})
export type BridgeControllerEvent = z.infer<typeof BridgeControllerEventSchema>

export const BridgeMicButtonEventSchema = z.object({
  pressed: z.boolean()
})
export type BridgeMicButtonEvent = z.infer<typeof BridgeMicButtonEventSchema>

export const BridgeAudioEventSchema = z.object({
  speaker: AudioCapabilitySchema,
  microphone: AudioCapabilitySchema
})
export type BridgeAudioEvent = z.infer<typeof BridgeAudioEventSchema>

export const toTransport = (value: string): Transport =>
  TransportSchema.options.includes(value as Transport) ? (value as Transport) : 'Unknown'
