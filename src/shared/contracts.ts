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

export const SessionStateSchema = z.enum(['working', 'waiting', 'unknown'])
export type SessionState = z.infer<typeof SessionStateSchema>

export const SessionInfoSchema = z.object({
  id: z.string(),
  /** Absolute path of the `.jsonl` this session was parsed from. */
  path: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  state: SessionStateSchema,
  question: z.string().nullable(),
  /** The agent's closing message, read aloud when a turn ends. */
  lastMessage: z.string().nullable()
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

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

export const AppSnapshotSchema = z.object({
  agent: AgentIdSchema,
  sessions: z.array(SessionInfoSchema),
  sessionIndex: z.number(),
  activeSessionId: z.string().nullable(),
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
