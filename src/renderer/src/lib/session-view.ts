import { displayStateOf, SESSION_STATE_LABELS, truncate } from '@shared/contracts'
import type { SessionDisplayState, SessionInfo } from '@shared/contracts'

export interface StateTone {
  label: string
  /** Tailwind classes for the status dot, the chip and the chip border. */
  dot: string
  chip: string
  /** True while the session is actually producing output. */
  pulsing: boolean
}

export const STATE_TONES: Record<SessionDisplayState, StateTone> = {
  working: {
    label: SESSION_STATE_LABELS.working,
    dot: 'bg-emerald-400',
    chip: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
    pulsing: true
  },
  waiting: {
    label: SESSION_STATE_LABELS.waiting,
    dot: 'bg-amber-400',
    chip: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    pulsing: false
  },
  stale: {
    label: SESSION_STATE_LABELS.stale,
    dot: 'bg-zinc-500',
    chip: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
    pulsing: false
  },
  offline: {
    label: SESSION_STATE_LABELS.offline,
    dot: 'bg-zinc-600',
    chip: 'border-zinc-600/40 bg-zinc-600/15 text-zinc-400',
    pulsing: false
  },
  unknown: {
    label: SESSION_STATE_LABELS.unknown,
    dot: 'bg-zinc-600',
    chip: 'border-zinc-600/40 bg-zinc-600/15 text-zinc-400',
    pulsing: false
  }
}

export const displayState = (session: SessionInfo, now: number): SessionDisplayState =>
  displayStateOf(session, now)

export const toneOf = (session: SessionInfo, now: number): StateTone =>
  STATE_TONES[displayStateOf(session, now)]

export const SURFACE_LABELS = {
  terminal: 'Terminal',
  vscode: 'VS Code',
  desktop: 'Desktop',
  unknown: 'Unknown surface'
} as const

/** Short, glanceable age of the last write to the transcript. */
export const relativeTime = (timestamp: number, now: number): string => {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export const shortId = (id: string): string => id.slice(0, 8)

export const projectName = (cwd: string | null): string | null =>
  cwd?.split('/').filter(Boolean).pop() ?? null

/** One line of context under the title: the open question wins over the reply. */
export const preview = (session: SessionInfo, limit = 110): string | null => {
  const text = (session.question ?? session.lastMessage ?? '').replace(/\s+/g, ' ').trim()
  return text ? truncate(text, limit) : null
}
