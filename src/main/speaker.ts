import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { speechSettings } from './config'
import type { SpeechSettings } from './config'
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
      resolve({ success: false, message: `${executable} timed out.` })
    }, timeoutMilliseconds)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ success: false, message: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({
        success: code === 0,
        message: code === 0 ? 'Done.' : `${executable} exited with code ${code}.`
      })
    })
  })

interface Voice {
  name: string
  /** As `say` prints it: `it_IT`, `en_US`. */
  locale: string
}

/**
 * `say -v '?'` prints `Name locale  # sample sentence`, one voice per line. The
 * name may hold spaces and brackets (`Eddy (English (UK)) en_GB`), so the line
 * is anchored on the locale that precedes the sample instead.
 */
const VOICE_LINE = /^(.+?)\s+([A-Za-z]{2,4}[_-][A-Za-z0-9]{2,4})\s+#/

const readVoices = (): Promise<Voice[]> =>
  new Promise((resolve) => {
    const child = spawn('/usr/bin/say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: string[] = []
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const voices: Voice[] = []
      for (const line of chunks.join('').split('\n')) {
        const match = VOICE_LINE.exec(line.trim())
        if (match) voices.push({ name: match[1].trim(), locale: match[2].replace('-', '_') })
      }
      resolve(voices)
    })
  })

/** The voice the user picked in System Settings, which `say` uses by default. */
const readSystemVoice = (): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn(
      '/usr/bin/defaults',
      ['read', 'com.apple.speech.voice.prefs', 'SelectedVoiceName'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const chunks: string[] = []
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const name = chunks.join('').trim()
      resolve(code === 0 && name ? name : null)
    })
  })

const systemLocale = (): string => Intl.DateTimeFormat().resolvedOptions().locale

/** Neither value changes while the app runs: read each one once. */
let voices: Promise<Voice[]> | null = null
let systemVoice: Promise<string | null> | null = null

const languageOf = (locale: string): string => locale.toLowerCase().replace('-', '_').split('_')[0]

/**
 * The voice named in the config wins. Otherwise the voice macOS already speaks
 * with, as long as it speaks the configured language: replacing the user's own
 * voice with an arbitrary same-language one would be a downgrade. Failing that,
 * the first installed voice for the exact locale, then for the language in any
 * region.
 */
const voiceFor = async (settings: SpeechSettings): Promise<string | null> => {
  if (settings.ttsVoice) return settings.ttsVoice
  const wanted = settings.ttsLanguage.replace('-', '_').toLowerCase()
  const language = languageOf(wanted)
  const installed = await (voices ??= readVoices())
  const preferred = await (systemVoice ??= readSystemVoice())
  // No voice chosen in System Settings: `say` speaks with the default for the
  // Mac's own language, which is the better voice whenever it fits.
  const spoken = installed.find((voice) => voice.name === preferred)?.locale ?? systemLocale()
  if (languageOf(spoken) === language) return null
  const exact = installed.find((voice) => voice.locale.toLowerCase() === wanted)
  if (exact) return exact.name
  return installed.find((voice) => languageOf(voice.locale) === language)?.name ?? null
}

/**
 * The locales this Mac can actually speak, which is what the HUD picker should
 * offer: a language with no installed voice would announce in the wrong one.
 */
export const installedSpeechLocales = async (): Promise<string[]> => {
  const installed = await (voices ??= readVoices())
  const tags = new Set(installed.map((voice) => voice.locale.replace('_', '-')))
  return [...tags].sort()
}

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
      const voice = await voiceFor(speechSettings())
      const arguments_ = voice ? ['-v', voice, '-o', file, trimmed] : ['-o', file, trimmed]
      const rendered = await run('/usr/bin/say', arguments_, 20_000)
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
