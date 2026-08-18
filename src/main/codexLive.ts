import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

const SOCKET_PATH = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
const REQUEST_TIMEOUT_MILLISECONDS = 15_000
const CODEX_DAEMON_ENVIRONMENT = 'CODEX_APP_SERVER_USE_LOCAL_DAEMON'
const EXTRA_BIN = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

const RpcEnvelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string()
    })
    .optional()
})

const ThreadResumeResponseSchema = z.object({
  thread: z.object({
    id: z.string(),
    canAcceptDirectInput: z.boolean().nullable().optional()
  })
})

const TurnStartResponseSchema = z.object({
  turn: z.object({ id: z.string() })
})

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type CodexLiveSendResult =
  { sent: true; turnId: string } | { sent: false; fallback: boolean; message: string }

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isStandaloneDesktopServer = (command: string): boolean =>
  /\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/codex(?:\s|$)/.test(command) &&
  /\sapp-server(?:\s|$)/.test(command) &&
  !/\sapp-server\s+daemon(?:\s|$)/.test(command)

async function desktopUsesPrivateServer(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'command='], { timeout: 5_000 })
    return stdout.split('\n').some(isStandaloneDesktopServer)
  } catch (error) {
    // Failure to inspect processes must not turn a diagnostic into an outage.
    console.warn(`[codex live] Could not inspect Codex Desktop mode: ${describeError(error)}`)
    return false
  }
}

const executableCandidates = (): string[] => [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  join(homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
  join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')
]

async function installedCodexBinary(): Promise<string> {
  for (const candidate of executableCandidates()) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Fall through to the next known application location.
    }
  }
  return 'codex'
}

/**
 * Codex Desktop normally owns an app-server over private stdio. In daemon mode
 * it and Agent Controller instead join this user-only Unix socket, so both see
 * the same turns and notifications.
 */
class CodexLiveClient {
  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private bootstrapPromise: Promise<void> | null = null
  private nextRequestId = 0
  private readonly pending = new Map<number, PendingRequest>()

  prepare(): Promise<void> {
    this.bootstrapPromise ??= this.bootstrap().catch((error) => {
      this.bootstrapPromise = null
      throw error
    })
    return this.bootstrapPromise
  }

  stop(): void {
    this.connectPromise = null
    this.socket?.close()
    this.socket = null
    this.rejectPending(new Error('Codex live connection closed.'))
  }

  async send(sessionId: string, text: string): Promise<CodexLiveSendResult> {
    try {
      // A Desktop instance started before the launchctl flag owns its thread via
      // private stdio. Sending through a second daemon would update the rollout
      // without notifying that window, which is the exact split-brain bug this
      // transport exists to prevent.
      if (await desktopUsesPrivateServer()) {
        return {
          sent: false,
          fallback: false,
          message:
            'Codex is still using its private connection. Quit Codex completely and reopen it, then retry.'
        }
      }
      await this.prepare()
      await this.connect()
      const resumed = ThreadResumeResponseSchema.parse(
        await this.request('thread/resume', { threadId: sessionId, excludeTurns: true })
      )
      if (resumed.thread.canAcceptDirectInput === false) {
        return {
          sent: false,
          fallback: false,
          message: 'This Codex thread is not accepting direct input right now.'
        }
      }
      const started = TurnStartResponseSchema.parse(
        await this.request('turn/start', {
          threadId: sessionId,
          input: [{ type: 'text', text, text_elements: [] }]
        })
      )
      console.info(`[senders] codex -> live daemon session "${sessionId}" turn=${started.turn.id}`)
      return { sent: true, turnId: started.turn.id }
    } catch (error) {
      const message = describeError(error)
      if (message.includes('already has an active writer')) {
        return {
          sent: false,
          fallback: false,
          message:
            'Codex was opened before live delivery was enabled. Quit Codex completely and reopen it, then retry.'
        }
      }
      const unavailable =
        message.includes('ENOENT') ||
        message.includes('ECONNREFUSED') ||
        message.includes('no rollout found') ||
        message.includes('failed to connect')
      console.warn(`[codex live] ${message}`)
      return {
        sent: false,
        fallback: unavailable,
        message: `Codex live delivery failed: ${message}`
      }
    }
  }

  private async bootstrap(): Promise<void> {
    const binary = await installedCodexBinary()
    const env = {
      ...process.env,
      PATH: [...EXTRA_BIN, process.env.PATH ?? ''].join(':')
    }
    // LaunchServices only passes this to applications opened after it is set.
    // A Codex window that was already open is detected later by the writer lock.
    try {
      await execFileAsync('/bin/launchctl', ['setenv', CODEX_DAEMON_ENVIRONMENT, '1'], {
        timeout: 5_000
      })
    } catch (error) {
      console.warn(
        `[codex live] Could not configure future Codex launches: ${describeError(error)}`
      )
    }
    await execFileAsync(binary, ['app-server', 'daemon', 'start'], {
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    })
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${SOCKET_PATH}:/rpc`, {
        handshakeTimeout: 5_000,
        maxPayload: 16 * 1024 * 1024,
        // The daemon intentionally implements the base WebSocket protocol only.
        // Advertising permessage-deflate makes it close during the handshake.
        perMessageDeflate: false
      })
      let settled = false
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true
          if (this.socket === socket) this.socket = null
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
            socket.terminate()
          }
          this.rejectPending(error)
          reject(error)
        }
      }
      socket.once('open', () => {
        this.socket = socket
        void this.initialize()
          .then(() => {
            settled = true
            resolve()
          })
          .catch(fail)
      })
      socket.on('message', (data) => this.handleMessage(data.toString()))
      socket.once('error', fail)
      socket.once('close', () => {
        if (this.socket === socket) this.socket = null
        this.connectPromise = null
        this.rejectPending(new Error('Codex live connection closed.'))
        fail(new Error('Codex live connection closed during startup.'))
      })
    }).finally(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) this.connectPromise = null
    })
    return this.connectPromise
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'agent-controller',
        title: 'Agent Controller',
        version: '1.0.0'
      },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    this.notify('initialized')
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex live socket is unavailable.'))
    }
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MILLISECONDS)
      this.pending.set(id, { method, resolve, reject, timer })
      socket.send(JSON.stringify({ method, id, params }), (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private notify(method: string): void {
    this.socket?.send(JSON.stringify({ method }))
  }

  private handleMessage(raw: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      console.warn('[codex live] Ignoring malformed JSON from app-server.')
      return
    }
    const parsed = RpcEnvelopeSchema.safeParse(decoded)
    if (!parsed.success || typeof parsed.data.id !== 'number') return
    const pending = this.pending.get(parsed.data.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(parsed.data.id)
    if (parsed.data.error) {
      pending.reject(new Error(`${pending.method}: ${parsed.data.error.message}`))
    } else {
      pending.resolve(parsed.data.result)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

const client = new CodexLiveClient()

export const prepareCodexLive = (): Promise<void> => client.prepare()

export const stopCodexLive = (): void => client.stop()

export const sendToLiveCodexSession = (
  sessionId: string,
  text: string
): Promise<CodexLiveSendResult> => client.send(sessionId, text)
