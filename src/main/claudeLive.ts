import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { SessionState, SessionSurface } from '../shared/contracts'

const execFileAsync = promisify(execFile)

const CLAUDE_SESSIONS_ROOT = join(homedir(), '.claude', 'sessions')
const CONNECT_TIMEOUT_MILLISECONDS = 3_000
const SUPPORTED_PEER_PROTOCOL = 1

const LiveRecordSchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  cwd: z.string().optional(),
  startedAt: z.number().optional(),
  procStart: z.string().optional(),
  version: z.string().optional(),
  peerProtocol: z.number().int().optional(),
  entrypoint: z.string().optional(),
  name: z.string().optional(),
  updatedAt: z.number().optional(),
  status: z.string().optional(),
  statusUpdatedAt: z.number().optional(),
  messagingSocketPath: z.string().optional()
})

const MessagingKeySchema = z.object({
  peerToken: z.string().min(1),
  procStart: z.string().optional()
})

export interface ClaudeLiveOwner {
  pid: number
  sessionId: string
  cwd: string | null
  title: string | null
  updatedAt: number
  state: SessionState | null
  surface: SessionSurface
  socketPath: string | null
  recordPath: string
  procStart: string | null
  version: string | null
  peerProtocol: number | null
}

export type ClaudeSocketSendResult =
  { sent: true; owner: ClaudeLiveOwner } | { sent: false; message: string }

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const surfaceFromEntrypoint = (entrypoint: string | undefined): SessionSurface => {
  if (entrypoint === 'claude-vscode') return 'vscode'
  if (entrypoint === 'local-agent' || entrypoint === 'remote_desktop') return 'desktop'
  if (entrypoint === 'cli' || entrypoint === 'sdk-cli') return 'terminal'
  return 'unknown'
}

const stateFromLiveStatus = (status: string | undefined): SessionState | null => {
  if (status === 'busy') return 'working'
  if (status === 'idle' || status === 'waiting' || status === 'shell') return 'waiting'
  return null
}

export async function listClaudeLiveOwners(): Promise<ClaudeLiveOwner[]> {
  let entries
  try {
    entries = await readdir(CLAUDE_SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return []
  }

  const owners: ClaudeLiveOwner[] = []
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) return
      const recordPath = join(CLAUDE_SESSIONS_ROOT, entry.name)
      try {
        const parsed = LiveRecordSchema.safeParse(JSON.parse(await readFile(recordPath, 'utf8')))
        if (!parsed.success || !processExists(parsed.data.pid)) return
        const record = parsed.data
        const owner: ClaudeLiveOwner = {
          pid: record.pid,
          sessionId: record.sessionId,
          cwd: record.cwd ?? null,
          title: record.name ?? null,
          updatedAt: record.statusUpdatedAt ?? record.updatedAt ?? record.startedAt ?? 0,
          state: stateFromLiveStatus(record.status),
          surface: surfaceFromEntrypoint(record.entrypoint),
          socketPath: record.messagingSocketPath ?? null,
          recordPath,
          procStart: record.procStart ?? null,
          version: record.version ?? null,
          peerProtocol: record.peerProtocol ?? null
        }
        // A stale registry filename can survive a crash and its PID can later
        // be reused. procStart distinguishes the original Claude process from
        // an unrelated process that inherited the same number.
        if (await validateOwner(owner)) owners.push(owner)
      } catch {
        // Processes replace these small records in place; a concurrent read can
        // briefly see an incomplete JSON document.
      }
    })
  )
  return owners.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function currentProcessStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 1_000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function validateOwner(owner: ClaudeLiveOwner): Promise<boolean> {
  if (!processExists(owner.pid)) return false
  if (owner.procStart === null) return true
  return (await currentProcessStart(owner.pid)) === owner.procStart
}

const keyPathFor = (owner: ClaudeLiveOwner): string => {
  if (owner.socketPath === null) throw new Error('The session publishes no messaging socket.')
  const canonicalSocket = resolve(owner.socketPath)
  const hash = createHash('sha256').update(canonicalSocket).digest('hex')
  return join(CLAUDE_SESSIONS_ROOT, `${owner.pid}.${hash}.key`)
}

async function readPeerToken(owner: ClaudeLiveOwner): Promise<string> {
  const keyPath = keyPathFor(owner)
  await access(keyPath, constants.R_OK)
  const parsed = MessagingKeySchema.safeParse(JSON.parse(await readFile(keyPath, 'utf8')))
  if (!parsed.success) throw new Error('The Claude socket key is not valid.')
  if (parsed.data.procStart && owner.procStart && parsed.data.procStart !== owner.procStart) {
    throw new Error('The key belongs to an earlier Claude process.')
  }
  return parsed.data.peerToken
}

async function writeSocket(path: string, payload: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(path)
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolvePromise()
    }
    socket.setTimeout(CONNECT_TIMEOUT_MILLISECONDS, () => {
      settle(new Error('Timed out connecting to the Claude session socket.'))
    })
    socket.once('error', (error) => settle(error))
    socket.once('connect', () => {
      socket.end(payload, 'utf8', () => settle())
    })
  })
}

export async function sendToLiveClaudeSession(
  sessionId: string,
  text: string
): Promise<ClaudeSocketSendResult> {
  const matching = (await listClaudeLiveOwners()).filter((owner) => owner.sessionId === sessionId)
  if (matching.length === 0) return { sent: false, message: 'offline' }

  const routable = matching.filter((owner) => owner.socketPath !== null)
  if (routable.length === 0) {
    const version = matching[0]?.version
    return {
      sent: false,
      message: `The Claude session is live but exposes no messaging socket${version ? ` (Claude ${version})` : ''}. Update Claude Code and reopen it.`
    }
  }
  if (routable.length > 1) {
    return {
      sent: false,
      message: `Several Claude processes own session ${sessionId.slice(0, 8)} at once; delivery refused to avoid a split brain.`
    }
  }

  const owner = routable[0]
  if (!(await validateOwner(owner))) {
    return {
      sent: false,
      message: 'The process that owns this Claude session is no longer running.'
    }
  }
  if (owner.peerProtocol !== null && owner.peerProtocol !== SUPPORTED_PEER_PROTOCOL) {
    return {
      sent: false,
      message: `The session speaks Claude messaging protocol ${owner.peerProtocol}, but Agent Controller supports protocol ${SUPPORTED_PEER_PROTOCOL}.`
    }
  }

  try {
    const peerToken = await readPeerToken(owner)
    const lines = [
      JSON.stringify({ type: 'auth', token: peerToken }),
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        session_id: sessionId,
        priority: 'next',
        message: { role: 'user', content: text }
      })
    ]
    await writeSocket(owner.socketPath!, `${lines.join('\n')}\n`)
    console.info(
      `[senders] claude -> live session "${sessionId}" pid=${owner.pid} surface=${owner.surface}`
    )
    return { sent: true, owner }
  } catch (error) {
    return {
      sent: false,
      message: `Invio al socket Claude fallito: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
