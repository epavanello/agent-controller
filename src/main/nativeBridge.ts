import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import {
  BridgeAudioEventSchema,
  BridgeControllerEventSchema,
  BridgeMicButtonEventSchema
} from '../shared/contracts'
import type {
  BridgeAudioEvent,
  BridgeControllerEvent,
  BridgeMicButtonEvent
} from '../shared/contracts'

interface NativeCommand {
  id: string
  command: string
  payload?: unknown
}

interface NativeResponse {
  type: 'response'
  id: string
  success: boolean
  message: string
}

type BridgeEvent =
  | { type: 'controller'; payload: BridgeControllerEvent }
  | { type: 'micbutton'; payload: BridgeMicButtonEvent }
  | { type: 'audio'; payload: BridgeAudioEvent }
  | { type: 'error'; payload: { message: string } }
  | { type: 'log'; payload: { message: string } }

const defaultRestartDelays = [500, 2_000, 5_000] as const

/**
 * How much of an unterminated line either stream may hold.
 *
 * A child that writes without ever sending a newline — a Swift framework
 * dumping a stack trace, or a wedged writer — used to pin all of it in the main
 * process indefinitely. Past the cap the partial line is dropped and the next
 * newline resynchronises the stream; 64 KiB is far above any line the bridge
 * legitimately emits.
 */
const LINE_BUFFER_LIMIT = 64 * 1024

/** Splits a stream of chunks into whole lines, bounded. */
class LineBuffer {
  private text = ''
  private discarding = false

  take(chunk: string): { lines: string[]; dropped: boolean } {
    this.text += chunk
    const lines: string[] = []
    let newline = this.text.indexOf('\n')
    while (newline >= 0) {
      const line = this.text.slice(0, newline).trim()
      this.text = this.text.slice(newline + 1)
      if (this.discarding) this.discarding = false
      else if (line) lines.push(line)
      newline = this.text.indexOf('\n')
    }
    let dropped = false
    if (this.text.length > LINE_BUFFER_LIMIT) {
      dropped = !this.discarding
      this.text = ''
      this.discarding = true
    }
    return { lines, dropped }
  }

  reset(): void {
    this.text = ''
    this.discarding = false
  }
}

const defaultResolveBinaryPath = async (): Promise<string | null> => {
  const binary = app.isPackaged
    ? join(process.resourcesPath, 'native', 'AgentControllerBridge')
    : join(app.getAppPath(), 'native', '.build', 'debug', 'AgentControllerBridge')
  try {
    await access(binary)
    return binary
  } catch {
    return null
  }
}

const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Owns the Swift helper process.
 *
 * Every failure mode reaches listeners as an `error` bridge event rather than
 * as an uncaught exception in the main process: spawn errors, stdin errors,
 * malformed output, and unexpected exits. An unexpected exit also triggers a
 * bounded backoff respawn; each successful respawn asks the new child for a
 * fresh snapshot so controller and audio state stop being stale.
 *
 * Emits: `event` (BridgeEvent), `restarted`.
 * Never emits `error` — EventEmitter would throw that at an unlistening caller.
 */
export class NativeBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly stdoutLines = new LineBuffer()
  private readonly stderrLines = new LineBuffer()
  private available = false
  private pending = new Map<
    string,
    {
      command: string
      resolve: (value: { success: boolean; message: string }) => void
      timer: NodeJS.Timeout
    }
  >()
  private stopping = false
  private restartAttempt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private restartAwaitingReadiness = false
  private readonly resolveBinaryPath: () => Promise<string | null>
  private readonly spawnBridge: (binary: string) => ChildProcessWithoutNullStreams
  private readonly restartDelays: readonly number[]

  constructor(
    options: {
      resolveBinaryPath?: () => Promise<string | null>
      spawnBridge?: (binary: string) => ChildProcessWithoutNullStreams
      restartDelaysMilliseconds?: readonly number[]
    } = {}
  ) {
    super()
    this.resolveBinaryPath = options.resolveBinaryPath ?? defaultResolveBinaryPath
    this.spawnBridge =
      options.spawnBridge ?? ((binary) => spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }))
    this.restartDelays = options.restartDelaysMilliseconds ?? defaultRestartDelays
  }

  get isAvailable(): boolean {
    return this.available
  }

  reportError(message: string, diagnosticMessage = message): void {
    console.error(`[native bridge] ${diagnosticMessage}`)
    this.emit('event', {
      type: 'error',
      payload: { message }
    } satisfies BridgeEvent)
  }

  private reportLog(message: string): void {
    if (!message) return
    console.warn(`[native bridge] ${message}`)
    this.emit('event', {
      type: 'log',
      payload: { message }
    } satisfies BridgeEvent)
  }

  async start(): Promise<void> {
    console.info('[native bridge] Starting helper')
    this.stopping = false
    this.restartAttempt = 0
    this.restartAwaitingReadiness = false
    const outcome = await this.launch(false)
    if (outcome.status === 'missing') {
      console.warn(`[native bridge] ${outcome.message}`)
      this.emit('event', {
        type: 'error',
        payload: {
          message:
            'Bridge nativo non trovato: esegui `npm run native:build` prima di `npm run dev`.'
        }
      } satisfies BridgeEvent)
    } else if (outcome.status === 'failed') {
      this.reportError(outcome.message)
    }
  }

  stop(): void {
    console.info('[native bridge] Stopping helper')
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.child?.kill()
    this.child = null
    this.available = false
    this.restartAwaitingReadiness = false
  }

  send(command: string, payload?: unknown): boolean {
    const child = this.child
    if (!child || !this.available) return false
    const value: NativeCommand = {
      id: crypto.randomUUID(),
      command,
      payload
    }
    return this.write(child, value)
  }

  request(
    command: string,
    payload?: unknown,
    timeoutMilliseconds = 12_000
  ): Promise<{ success: boolean; message: string }> {
    const child = this.child
    if (!child || !this.available) {
      return Promise.resolve({
        success: false,
        message: 'Il bridge nativo non è disponibile.'
      })
    }
    const id = crypto.randomUUID()
    const value: NativeCommand = { id, command, payload }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        console.warn(`[native bridge] Command timed out: ${command}`)
        resolve({ success: false, message: 'Il comando nativo è scaduto.' })
      }, timeoutMilliseconds)
      this.pending.set(id, { command, resolve, timer })
      if (!this.write(child, value)) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ success: false, message: 'Il bridge nativo non è disponibile.' })
      }
    })
  }

  private write(child: ChildProcessWithoutNullStreams, value: NativeCommand): boolean {
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`)
      return true
    } catch (error) {
      this.reportError(`Il bridge nativo non ha accettato un comando: ${describeError(error)}`)
      return false
    }
  }

  private async launch(
    awaitingRestartReadiness: boolean
  ): Promise<{ status: 'started' } | { status: 'missing' | 'failed'; message: string }> {
    const binary = await this.resolveBinaryPath()
    if (binary === null) {
      this.available = false
      return { status: 'missing', message: 'Il binario del bridge nativo non esiste.' }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnBridge(binary)
    } catch (error) {
      this.available = false
      return {
        status: 'failed',
        message: `Il bridge nativo non parte: ${describeError(error)}`
      }
    }

    this.child = child
    this.available = true
    console.info('[native bridge] Helper process spawned', { restart: awaitingRestartReadiness })
    this.restartAwaitingReadiness = awaitingRestartReadiness
    this.stdoutLines.reset()
    this.stderrLines.reset()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(child, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.consumeStderr(child, chunk))

    let terminalHandled = false
    child.on('error', (error: Error) => {
      if (terminalHandled || this.child !== child || this.stopping) return
      terminalHandled = true
      this.available = false
      this.child = null
      this.restartAwaitingReadiness = false
      this.stdoutLines.reset()
      this.stderrLines.reset()
      this.failPending('Il bridge nativo si è fermato inaspettatamente.')
      this.handleFailure(`Il bridge nativo è fallito: ${describeError(error)}.`)
    })
    child.stdin.on('error', (error: Error) => {
      this.reportError(`Il bridge nativo non accetta più comandi: ${describeError(error)}`)
    })
    child.once('exit', (code, signal) => {
      if (terminalHandled) return
      terminalHandled = true
      this.handleChildExit(code, signal)
    })
    return { status: 'started' }
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.available = false
    this.child = null
    this.restartAwaitingReadiness = false
    this.stdoutLines.reset()
    this.stderrLines.reset()
    this.failPending('Il bridge nativo si è fermato inaspettatamente.')

    if (this.stopping) {
      console.info('[native bridge] Helper exited during shutdown', { code, signal })
      return
    }
    this.handleFailure(
      `Il bridge nativo si è fermato inaspettatamente (${describeExit(code, signal)}).`
    )
  }

  private handleFailure(message: string): void {
    const delay = this.restartDelays[this.restartAttempt]
    const willRestart = !this.stopping && delay !== undefined
    this.reportError(
      willRestart
        ? `${message} Riprovo (tentativo ${this.restartAttempt + 1} di ${this.restartDelays.length}).`
        : `${message} Resta offline fino al prossimo riavvio.`
    )
    if (!willRestart || delay === undefined) return

    this.restartAttempt += 1
    console.info('[native bridge] Restart scheduled', {
      attempt: this.restartAttempt,
      delayMilliseconds: delay
    })
    this.restartTimer = setTimeout(() => void this.attemptRestart(), delay)
    this.restartTimer.unref?.()
  }

  private async attemptRestart(): Promise<void> {
    this.restartTimer = null
    if (this.stopping) return

    console.info('[native bridge] Attempting helper restart', { attempt: this.restartAttempt })
    const outcome = await this.launch(true)
    if (outcome.status !== 'started') {
      this.handleFailure(outcome.message)
      return
    }
    // The replacement child knows nothing about the last snapshot: ask it to
    // publish controller + audio state again.
    this.send('system.refresh')
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ success: false, message })
      this.pending.delete(id)
    }
  }

  private consume(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return
    const { lines, dropped } = this.stdoutLines.take(chunk)
    for (const line of lines) this.consumeLine(line)
    if (dropped) {
      this.reportError('Il bridge nativo ha inviato un messaggio troppo grande, scartato.')
    }
  }

  private consumeLine(line: string): void {
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error()
      const type = (value as { type?: unknown }).type
      if (type === 'response') {
        const response = value as Partial<NativeResponse>
        if (
          typeof response.id !== 'string' ||
          typeof response.success !== 'boolean' ||
          typeof response.message !== 'string'
        ) {
          throw new Error()
        }
      } else {
        if (!['controller', 'micbutton', 'audio', 'error', 'log'].includes(String(type))) {
          throw new Error()
        }
        const payload = (value as { payload?: unknown }).payload
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error()
        }
        if (
          (type === 'error' || type === 'log') &&
          typeof (payload as { message?: unknown }).message !== 'string'
        ) {
          throw new Error()
        }
      }
      // Well-formed output proves this child is healthy, so a later crash
      // gets the full restart budget instead of the tail of an old one.
      this.restartAttempt = 0
      if (this.restartAwaitingReadiness) {
        this.restartAwaitingReadiness = false
        console.info('[native bridge] Restarted helper is ready')
        this.emit('restarted')
      }
      if (type === 'response') {
        const response = value as NativeResponse
        const pending = this.pending.get(response.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(response.id)
          if (!response.success) {
            console.warn(`[native bridge] Command reported failure: ${pending.command}`)
          }
          pending.resolve({ success: response.success, message: response.message })
        }
      } else if (type === 'error') {
        console.error('[native bridge] Helper reported an operational error')
        this.emit('event', value as BridgeEvent)
      } else if (type === 'log') {
        this.emit('event', value as BridgeEvent)
      } else if (type === 'controller') {
        const parsed = BridgeControllerEventSchema.safeParse(
          (value as unknown as { payload: unknown }).payload
        )
        if (parsed.success) {
          this.emit('event', { type: 'controller', payload: parsed.data } satisfies BridgeEvent)
        }
      } else if (type === 'micbutton') {
        const parsed = BridgeMicButtonEventSchema.safeParse(
          (value as unknown as { payload: unknown }).payload
        )
        if (parsed.success) {
          this.emit('event', { type: 'micbutton', payload: parsed.data } satisfies BridgeEvent)
        }
      } else if (type === 'audio') {
        const parsed = BridgeAudioEventSchema.safeParse(
          (value as unknown as { payload: unknown }).payload
        )
        if (parsed.success) {
          this.emit('event', { type: 'audio', payload: parsed.data } satisfies BridgeEvent)
        }
      }
    } catch {
      this.reportError('Il bridge nativo ha restituito dati malformati.')
    }
  }

  private consumeStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return
    const { lines, dropped } = this.stderrLines.take(chunk)
    for (const line of lines) this.reportLog(line)
    if (dropped) this.reportLog('An oversized diagnostic line was discarded.')
  }
}
