import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'

/**
 * Spoken language is the one thing that cannot follow the interface: the HUD is
 * English, but the mic hears whoever is holding the controller and the speaker
 * reads back whatever the agent wrote — often neither in English.
 *
 * `language` covers both directions; the two overrides exist for the case where
 * they differ (dictating in Italian, hearing announcements in English).
 */
const SpeechConfigSchema = z.object({
  /** BCP-47 tag, e.g. `en-US`, `it-IT`. Used by both TTS and STT. */
  language: z.string().min(2),
  /** Overrides `language` for announcements only. */
  ttsLanguage: z.string().min(2).nullable(),
  /** A `say` voice name, e.g. `Samantha`. Null picks one matching the language. */
  ttsVoice: z.string().min(1).nullable(),
  /** Overrides `language` for dictation only. */
  sttLanguage: z.string().min(2).nullable()
})

export type SpeechConfig = z.infer<typeof SpeechConfigSchema>

const DEFAULT_SPEECH: SpeechConfig = {
  language: 'en-US',
  ttsLanguage: null,
  ttsVoice: null,
  sttLanguage: null
}

const ConfigSchema = z.object({
  speech: SpeechConfigSchema.default(DEFAULT_SPEECH)
})

export type Config = z.infer<typeof ConfigSchema>

const DEFAULT_CONFIG: Config = { speech: DEFAULT_SPEECH }

/** The overrides resolved against `language`, which is what callers need. */
export interface SpeechSettings {
  ttsLanguage: string
  ttsVoice: string | null
  sttLanguage: string
}

let current: Config = DEFAULT_CONFIG

export const configPath = (): string => join(app.getPath('userData'), 'config.json')

/**
 * Read once at startup. A missing file is written back with the defaults, so
 * the first launch leaves an editable file where the README says it is; an
 * unreadable or invalid one is reported and ignored rather than fatal.
 */
export async function loadConfig(): Promise<Config> {
  const path = configPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    current = DEFAULT_CONFIG
    try {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
      console.info(`[config] wrote defaults to ${path}`)
    } catch (error) {
      console.warn(`[config] could not write ${path}: ${String(error)}`)
    }
    return current
  }
  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      console.warn(`[config] ${path} is not valid, using defaults: ${parsed.error.message}`)
      current = DEFAULT_CONFIG
      return current
    }
    current = parsed.data
    console.info(
      `[config] ${path}: tts ${speechSettings().ttsLanguage}, stt ${speechSettings().sttLanguage}`
    )
  } catch (error) {
    console.warn(`[config] ${path} is not valid JSON, using defaults: ${String(error)}`)
    current = DEFAULT_CONFIG
  }
  return current
}

export const speechSettings = (): SpeechSettings => ({
  ttsLanguage: current.speech.ttsLanguage ?? current.speech.language,
  ttsVoice: current.speech.ttsVoice,
  sttLanguage: current.speech.sttLanguage ?? current.speech.language
})
