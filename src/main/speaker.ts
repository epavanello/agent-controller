import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeBridge } from './nativeBridge'

const run = (
  executable: string,
  args: string[],
  timeoutMilliseconds: number
): Promise<{ success: boolean; message: string }> =>
  new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ success: false, message: `${executable} è scaduto.` })
    }, timeoutMilliseconds)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ success: false, message: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({
        success: code === 0,
        message: code === 0 ? 'Fatto.' : `${executable} è uscito con codice ${code}.`
      })
    })
  })

/**
 * Serialized text-to-speech through the wired DualSense speaker: `say`
 * renders an AIFF and the native bridge plays it over the USB speaker route.
 */
export class Speaker {
  private queue: Promise<void> = Promise.resolve()
  private announcing = false

  constructor(
    private readonly bridge: NativeBridge,
    private readonly onAnnouncingChanged: (announcing: boolean) => void
  ) {}

  get isAnnouncing(): boolean {
    return this.announcing
  }

  speak(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.speakOne(text))
    return this.queue
  }

  private async speakOne(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    console.info(`[speaker] speaking: "${trimmed}"`)
    const directory = await mkdtemp(join(tmpdir(), 'agent-controller-tts-'))
    const file = join(directory, 'announcement.aiff')
    try {
      const rendered = await run('/usr/bin/say', ['-o', file, trimmed], 20_000)
      if (!rendered.success) {
        console.warn(`[speaker] TTS generation failed: ${rendered.message}`)
        return
      }
      this.announcing = true
      this.onAnnouncingChanged(true)
      try {
        const played = await this.bridge.request('speaker.play', { path: file }, 60_000)
        if (!played.success) console.warn(`[speaker] Playback failed: ${played.message}`)
        else console.info('[speaker] playback done')
      } finally {
        this.announcing = false
        this.onAnnouncingChanged(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
