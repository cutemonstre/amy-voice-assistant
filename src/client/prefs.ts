// Per-browser preferences, remembered in localStorage. Every access is wrapped: storage can throw or come back empty.

import { parsePace, parsePractice, type Pace, type Practice } from '../shared/api-types'

export type TtsModel = 'eleven_v4' | 'eleven_v4_turbo'
export const DEFAULT_TTS_MODEL: TtsModel = 'eleven_v4_turbo'

const TTS_KEY = 'voice-chat.ttsModel'

export function loadTtsModel(): TtsModel {
  try {
    const stored = localStorage.getItem(TTS_KEY)
    if (stored === 'eleven_v4' || stored === 'eleven_v4_turbo') return stored
  } catch {
    /* fall through */
  }
  return DEFAULT_TTS_MODEL
}

export function saveTtsModel(model: TtsModel) {
  try {
    localStorage.setItem(TTS_KEY, model)
  } catch {
    /* not remembered */
  }
}

const PRACTICE_KEY = 'voice-chat.practice'

/** The practice mode (off / Mandarin) last chosen. It carries over to new chats; opening an old chat restores that chat's own mode. */
export function loadPractice(): Practice {
  try {
    return parsePractice(localStorage.getItem(PRACTICE_KEY))
  } catch {
    return 'off'
  }
}

export function savePractice(practice: Practice) {
  try {
    localStorage.setItem(PRACTICE_KEY, practice)
  } catch {
    /* not remembered */
  }
}

const PACE_KEY = 'voice-chat.pace'
export const DEFAULT_PACE: Pace = 'brisk'

/** How fast the voice talks. Brisk unless the user chose natural. */
export function loadPace(): Pace {
  try {
    return parsePace(localStorage.getItem(PACE_KEY))
  } catch {
    return DEFAULT_PACE
  }
}

export function savePace(pace: Pace) {
  try {
    localStorage.setItem(PACE_KEY, pace)
  } catch {
    /* not remembered */
  }
}
