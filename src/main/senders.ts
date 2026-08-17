import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { AgentId, SessionInfo } from '../shared/contracts'
import { sendToLiveClaudeSession } from './claudeLive'

/** Electron launched from Finder does not inherit the user's shell PATH. */
const EXTRA_BIN = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
const MAX_OUTPUT_CHUNKS = 40
const OUTPUT_LOG_LIMIT = 500

export type SendResult =
  { sent: true; mode: 'live-socket' | 'headless-resume' } | { sent: false; message: string }

const unreference = (stream: Readable | null): void => {
  ;(stream as (Readable & { unref?: () => void }) | null)?.unref?.()
}

const binaryFor: Record<AgentId, string> = {
  codex: 'codex',
  claude: 'claude'
}

const argumentsFor = (agent: AgentId, session: SessionInfo, text: string): string[] =>
  agent === 'codex' ? ['exec', 'resume', session.id, text] : ['-p', '--resume', session.id, text]

function spawnHeadless(agent: AgentId, session: SessionInfo, text: string): Promise<SendResult> {
  console.info(
    `[senders] ${agent} -> offline session "${session.id}" (${session.title}) ${session.path}: "${text}"`
  )
  return new Promise((resolve) => {
    const child = spawn(binaryFor[agent], argumentsFor(agent, session, text), {
      cwd: session.cwd ?? undefined,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: [...EXTRA_BIN, process.env.PATH ?? ''].join(':')
      }
    })
    const output: string[] = []
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_CHUNKS) output.push(chunk.toString())
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      console.error(`[senders] ${binaryFor[agent]} failed to start: ${error.message}`)
      resolve({ sent: false, message: `${binaryFor[agent]} non è partito: ${error.message}` })
    })
    child.once('spawn', () => {
      resolve({ sent: true, mode: 'headless-resume' })
    })
    child.on('exit', (code) => {
      const tail = output.join('').trim().slice(-OUTPUT_LOG_LIMIT)
      if (code === 0) console.info(`[senders] ${agent} answered: ${tail}`)
      else console.error(`[senders] ${agent} exited with code ${code}: ${tail}`)
    })
    child.unref()
    unreference(child.stdout)
    unreference(child.stderr)
  })
}

export async function sendToSession(
  agent: AgentId,
  session: SessionInfo,
  text: string
): Promise<SendResult> {
  if (agent === 'claude') {
    const live = await sendToLiveClaudeSession(session.id, text)
    if (live.sent) return { sent: true, mode: 'live-socket' }
    if (live.message !== 'offline') return live
  }
  return spawnHeadless(agent, session, text)
}
