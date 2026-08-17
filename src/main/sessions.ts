import { homedir } from 'node:os'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { SessionStateSchema } from '../shared/contracts'
import type { AgentId, SessionInfo, SessionState } from '../shared/contracts'

const CODEX_ROOT = join(homedir(), '.codex', 'sessions')
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')
/** Codex keeps the name it shows in its own list out of the rollout file. */
const CODEX_INDEX = join(homedir(), '.codex', 'session_index.jsonl')

/** Bytes read from each end of a session file: enough for meta and tail state. */
const HEAD_LIMIT = 512 * 1024
const TAIL_LIMIT = 256 * 1024

/** Both agents write either a bare string or a list of typed blocks. */
const MessageContentSchema = z.union([
  z.string(),
  z.array(
    z.object({
      type: z.string(),
      text: z.string().optional()
    })
  )
])

type MessageContent = z.infer<typeof MessageContentSchema>

const contentText = (content: MessageContent | undefined): string => {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((block) => block.text ?? '').join(' ')
}

const CodexLineSchema = z.object({
  type: z.string(),
  payload: z.unknown()
})

const CodexSessionMetaSchema = z.object({
  id: z.string().optional(),
  cwd: z.string().optional()
})

const CodexMessageSchema = z.object({
  type: z.string(),
  role: z.string().optional(),
  content: MessageContentSchema.optional()
})

const CodexIndexEntrySchema = z.object({
  id: z.string(),
  thread_name: z.string().optional()
})

const CodexEventMsgSchema = z.object({
  type: z.string(),
  last_agent_message: z.string().optional()
})

const ClaudeLineSchema = z.object({
  type: z.string().optional(),
  message: z.unknown().optional(),
  cwd: z.string().optional(),
  summary: z.string().optional(),
  aiTitle: z.string().optional()
})

const ClaudeMessageSchema = z.object({
  role: z.string().optional(),
  content: MessageContentSchema.optional(),
  stop_reason: z.string().nullable().optional()
})

interface ParsedSession {
  /** The agent's closing message, spoken when a turn ends. */
  lastMessage: string | null
  id: string
  title: string
  cwd: string | null
  state: SessionState
  question: string | null
}

interface FileStamp {
  mtimeMs: number
  size: number
}

const isSessionLine = (line: string): boolean => {
  const parsed = JSON.parse(line) as unknown
  return typeof parsed === 'object' && parsed !== null
}

const truncate = (text: string, limit = 80): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

const fallbackTitle = (id: string, cwd: string | null): string => {
  const short = id.slice(0, 8)
  const base = cwd?.split('/').filter(Boolean).pop()
  return base ? `${base} · ${short}` : `Sessione ${short}`
}

const looksLikePath = (token: string): boolean =>
  token.length > 3 && token.includes('/') && /^[./~]?[\w@.-]*(?:\/[\w@.-]+)+$/.test(token)

const looksLikeUrl = (token: string): boolean =>
  /^[a-z][\w+.-]*:\/\//i.test(token) || token.startsWith('www.')

/**
 * Makes text safe to read aloud: path-like tokens (`/var/folders/…`,
 * `./src/…`) and URLs are dropped, or replaced when the meaning depends on
 * them. Read literally they bury the sentence they belong to.
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

/** A title short enough to be read aloud, or null when nothing usable is left. */
const speechTitle = (text: string | undefined): string | null => {
  if (!text) return null
  const sanitized = sanitizeForSpeech(text, 60)
  return sanitized.length >= 4 ? sanitized : null
}

const questionFrom = (text: string): string | null => {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 500) return null
  return trimmed.includes('?') ? trimmed : null
}
/**
 * Both agents inject their own preamble as the first "user" message — plugin
 * lists, AGENTS.md, environment context, IDE selection. Those are wrapped in a
 * tag or a heading, never how a person opens a prompt.
 */
const guessTitle = (text: string): boolean => {
  const trimmed = text.trim()
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('<') &&
    !trimmed.startsWith('#') &&
    !trimmed.includes('<INSTRUCTIONS>') &&
    !trimmed.includes('[Request interrupted by user]')
  )
}
async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, HEAD_LIMIT))
    await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_LIMIT)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Lines that parsed; a partial line at either boundary is skipped. */
function parseableLines(chunk: string): string[] {
  const lines = chunk.split('\n')
  const result: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      if (isSessionLine(line)) result.push(line)
    } catch {
      // A line cut by the bounded read is expected at either edge.
    }
  }
  return result
}

/**
 * The names Codex shows in its own session list, by session id. The file is
 * append-only and a rename adds a line, so the last entry for an id wins.
 */
async function readCodexNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  let content: string
  try {
    content = await readFile(CODEX_INDEX, 'utf8')
  } catch {
    return names
  }
  for (const line of parseableLines(content)) {
    const parsed = CodexIndexEntrySchema.safeParse(JSON.parse(line))
    if (!parsed.success || !parsed.data.thread_name) continue
    names.set(parsed.data.id, parsed.data.thread_name)
  }
  return names
}

function parseCodexSession(
  path: string,
  head: string,
  tail: string,
  names: Map<string, string>
): ParsedSession {
  const fallbackId = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(
    basename(path)
  )?.[1]

  let id = fallbackId ?? basename(path)
  let cwd: string | null = null
  let title: string | null = null

  for (const line of parseableLines(head)) {
    const parsed = CodexLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) continue
    if (parsed.data.type === 'session_meta') {
      const meta = CodexSessionMetaSchema.safeParse(parsed.data.payload)
      if (meta.success) {
        if (meta.data.id) id = meta.data.id
        if (meta.data.cwd) cwd = meta.data.cwd
      }
    } else if (parsed.data.type === 'response_item' && title === null) {
      const message = CodexMessageSchema.safeParse(parsed.data.payload)
      if (message.success && message.data.role === 'user' && message.data.type === 'message') {
        const text = contentText(message.data.content)
        if (guessTitle(text)) title = speechTitle(text)
      }
    }
  }

  let state: SessionState = 'unknown'
  let question: string | null = null
  let lastMessage: string | null = null
  for (const line of parseableLines(tail)) {
    const parsed = CodexLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success || parsed.data.type !== 'event_msg') continue
    const event = CodexEventMsgSchema.safeParse(parsed.data.payload)
    if (!event.success) continue
    if (event.data.type === 'task_started') state = 'working'
    else if (event.data.type === 'task_complete') {
      state = 'waiting'
      if (event.data.last_agent_message) {
        question = questionFrom(event.data.last_agent_message)
        lastMessage = event.data.last_agent_message
      }
    }
  }

  return {
    id,
    // The name from Codex's own list first, the opening prompt only when the
    // session has never been named.
    title: speechTitle(names.get(id)) ?? title ?? fallbackTitle(id, cwd),
    cwd,
    state,
    question,
    lastMessage
  }
}

function parseClaudeSession(path: string, head: string, tail: string): ParsedSession {
  const id = basename(path).replace(/\.jsonl$/, '')
  let cwd: string | null = null
  // Three title sources, best first: the name Claude generates for the session,
  // a compaction summary, the opening prompt.
  let generated: string | null = null
  let summary: string | null = null
  let prompt: string | null = null

  for (const line of parseableLines(head)) {
    const parsed = ClaudeLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) continue
    if (cwd === null && parsed.data.cwd) cwd = parsed.data.cwd
    if (parsed.data.type === 'ai-title') {
      // Claude rewrites the title as the session drifts: the last one is what
      // the user sees in their own list.
      generated = speechTitle(parsed.data.aiTitle) ?? generated
    } else if (parsed.data.type === 'summary') {
      summary = speechTitle(parsed.data.summary) ?? summary
    } else if (parsed.data.type === 'user' && prompt === null) {
      const decoded = ClaudeMessageSchema.safeParse(parsed.data.message)
      if (!decoded.success || decoded.data.role !== 'user') continue
      const text = contentText(decoded.data.content)
      if (guessTitle(text)) prompt = speechTitle(text)
    }
  }
  if (cwd === null) {
    // The project directory is encoded in the parent folder name: every `-`
    // stands for `/`.
    const encoded = basename(join(path, '..'))
    cwd = `/${encoded.slice(1).replace(/-/g, '/')}`
  }

  let state: SessionState = 'unknown'
  let question: string | null = null
  let lastMessage: string | null = null
  // A long session retitles itself past the head window, so the tail is read
  // for titles too. It runs second, which keeps "last one wins" true.
  for (const line of parseableLines(tail)) {
    const parsed = ClaudeLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) continue
    if (parsed.data.type === 'ai-title') {
      generated = speechTitle(parsed.data.aiTitle) ?? generated
      continue
    }
    if (parsed.data.type === 'summary') {
      summary = speechTitle(parsed.data.summary) ?? summary
      continue
    }
    if (parsed.data.type !== 'assistant') continue
    const decoded = ClaudeMessageSchema.safeParse(parsed.data.message)
    if (!decoded.success) continue
    const stopReason = decoded.data.stop_reason
    if (stopReason === 'tool_use') state = 'working'
    else if (stopReason === 'end_turn') {
      state = 'waiting'
      const text = contentText(decoded.data.content).trim()
      question = questionFrom(text)
      lastMessage = text || null
    }
  }

  return {
    id,
    title: generated ?? summary ?? prompt ?? fallbackTitle(id, cwd),
    cwd,
    state,
    question,
    lastMessage
  }
}

async function findSessionFiles(root: string): Promise<string[]> {
  const results: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(path)
    }
  }
  await walk(root, 0)
  return results
}

export class SessionStore {
  private readonly cache = new Map<string, { stamp: FileStamp; session: SessionInfo }>()
  private codexNames = new Map<string, string>()
  private codexNamesStamp: FileStamp = { mtimeMs: -1, size: -1 }

  async list(agent: AgentId): Promise<SessionInfo[]> {
    const root = agent === 'codex' ? CODEX_ROOT : CLAUDE_ROOT
    const names = agent === 'codex' ? await this.loadCodexNames() : new Map<string, string>()
    const files = await findSessionFiles(root)
    const sessions: SessionInfo[] = []
    for (const path of files) {
      sessions.push(await this.load(agent, path, names))
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Re-read only when Codex renamed or added a session. */
  private async loadCodexNames(): Promise<Map<string, string>> {
    let stamp: FileStamp
    try {
      const info = await stat(CODEX_INDEX)
      stamp = { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return this.codexNames
    }
    if (
      stamp.mtimeMs === this.codexNamesStamp.mtimeMs &&
      stamp.size === this.codexNamesStamp.size
    ) {
      return this.codexNames
    }
    this.codexNames = await readCodexNames()
    this.codexNamesStamp = stamp
    return this.codexNames
  }

  private async load(
    agent: AgentId,
    path: string,
    names: Map<string, string>
  ): Promise<SessionInfo> {
    let stamp: FileStamp
    try {
      const info = await stat(path)
      stamp = { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      stamp = { mtimeMs: 0, size: 0 }
    }
    const cached = this.cache.get(path)
    if (cached && cached.stamp.mtimeMs === stamp.mtimeMs && cached.stamp.size === stamp.size) {
      // A rename touches the index, not the rollout: re-title without re-parsing.
      const renamed = speechTitle(names.get(cached.session.id))
      if (renamed === null || renamed === cached.session.title) return cached.session
      const session = { ...cached.session, title: renamed }
      this.cache.set(path, { stamp, session })
      return session
    }
    let session: SessionInfo
    try {
      const [head, tail] = await Promise.all([readHead(path), readTail(path)])
      const parsed =
        agent === 'codex'
          ? parseCodexSession(path, head, tail, names)
          : parseClaudeSession(path, head, tail)
      const validated = SessionStateSchema.safeParse(parsed.state)
      session = {
        id: parsed.id,
        path,
        title: parsed.title,
        cwd: parsed.cwd,
        updatedAt: stamp.mtimeMs,
        state: validated.success ? validated.data : 'unknown',
        question: parsed.question,
        lastMessage: parsed.lastMessage
      }
    } catch {
      session = {
        id: basename(path).replace(/\.jsonl$/, ''),
        path,
        title: `Sessione ${basename(path).slice(0, 8)}`,
        cwd: null,
        updatedAt: stamp.mtimeMs,
        state: 'unknown',
        question: null,
        lastMessage: null
      }
    }
    this.cache.set(path, { stamp, session })
    return session
  }
}
