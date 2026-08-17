import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { AgentId, SessionInfo } from '../shared/contracts'

/**
 * CLI paths are resolved explicitly: an Electron app launched from Finder has
 * none of the user's shell PATH, so `~/.local/bin` is prepended.
 */
const EXTRA_BIN = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

/** Enough of the agent's answer to tell a delivery from a refusal. */
const MAX_OUTPUT_CHUNKS = 40
const OUTPUT_LOG_LIMIT = 500

/** A piped stdio stream is a pipe at runtime, which `Readable` does not admit. */
const unreference = (stream: Readable | null): void => {
  ;(stream as (Readable & { unref?: () => void }) | null)?.unref?.()
}

const agentBinary: Record<AgentId, string> = {
  codex: 'codex',
  claude: 'claude'
}

const buildArguments = (agent: AgentId, session: SessionInfo, text: string): string[] =>
  agent === 'codex' ? ['exec', 'resume', session.id, text] : ['-p', '--resume', session.id, text]

/**
 * Sends a message to a CLI session headlessly. The child is detached so a
 * mid-turn agent survives this app quitting; the session watcher reports the
 * result from the session file.
 */
export function sendToSession(agent: AgentId, session: SessionInfo, text: string): void {
  console.info(
    `[senders] ${agent} -> session "${session.id}" (${session.title}) ${session.path}: "${text}"`
  )
  const child = spawn(agentBinary[agent], buildArguments(agent, session, text), {
    cwd: session.cwd ?? undefined,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: [...EXTRA_BIN, process.env.PATH ?? ''].join(':')
    }
  })
  // The headless turn is otherwise silent: a refused resume and a delivered
  // message look exactly the same from here.
  const output: string[] = []
  const collect = (chunk: Buffer): void => {
    if (output.length < MAX_OUTPUT_CHUNKS) output.push(chunk.toString())
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', (error) => {
    console.error(`[senders] ${agentBinary[agent]} failed to start: ${error.message}`)
  })
  child.on('exit', (code) => {
    const tail = output.join('').trim().slice(-OUTPUT_LOG_LIMIT)
    if (code === 0) console.info(`[senders] ${agent} answered: ${tail}`)
    else console.error(`[senders] ${agent} exited with code ${code}: ${tail}`)
  })
  // Unreferenced streams as well as the child: a mid-turn agent has to outlive
  // this app quitting.
  child.unref()
  unreference(child.stdout)
  unreference(child.stderr)
}
