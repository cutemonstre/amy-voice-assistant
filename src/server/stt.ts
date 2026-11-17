// Speech-to-text, two interchangeable providers (both take the browser's 16 kHz mono WAV):
// The spoken language is always auto-detected: no language is sent to either provider. Scribe reports what it heard as `language_code`
// (ISO 639-3, e.g. "eng" or "cmn"); MAI-Transcribe 2 reports nothing, so `language` is undefined on that path.
//   elevenlabs  Scribe v2: POST https://api.elevenlabs.io/v1/speech-to-text (multipart)       -- default
//   openrouter  MAI-Transcribe 2: POST https://openrouter.ai/api/v1/audio/transcriptions (JSON, base64 WAV)
// Each retries ONCE on HTTP 429/5xx after 500 ms. Web APIs only (runs on Workers).
//
// Note for the openrouter path: it accepts wav and mp3 but answers HTTP 400 to webm and m4a, which is why the browser builds WAV itself.

import { bytesToBase64 } from './base64'
import { UpstreamError, fetchRetryOnce, readSnippet } from './http'

export type SttProvider = 'elevenlabs' | 'openrouter'

export interface SttConfig {
  provider: SttProvider
  model: string
  apiKey: string
}

export interface Transcription {
  text: string
  /** The language the provider detected (ISO 639-3 from Scribe), if it says. */
  language?: string
}

export interface SttEnv {
  STT_PROVIDER?: string
  STT_MODEL_ELEVENLABS?: string
  STT_MODEL_OPENROUTER?: string
  OPENROUTER_API_KEY?: string
  ELEVENLABS_API_KEY?: string
}

const DEFAULT_MODELS: Record<SttProvider, string> = {
  elevenlabs: 'scribe_v2',
  openrouter: 'microsoft/mai-transcribe-2',
}

/**
 * Pick the provider and model from the Worker env. STT_PROVIDER=elevenlabs (the default) without an ELEVENLABS_API_KEY falls back to
 * openrouter and returns a warning to show the user.
 */
export function resolveSttConfig(env: SttEnv): { config: SttConfig; warn?: string } {
  const wanted: SttProvider = env.STT_PROVIDER?.trim().toLowerCase() === 'openrouter' ? 'openrouter' : 'elevenlabs'

  if (wanted === 'elevenlabs' && env.ELEVENLABS_API_KEY) {
    return {
      config: { provider: 'elevenlabs', model: env.STT_MODEL_ELEVENLABS || DEFAULT_MODELS.elevenlabs, apiKey: env.ELEVENLABS_API_KEY },
    }
  }
  return {
    config: { provider: 'openrouter', model: env.STT_MODEL_OPENROUTER || DEFAULT_MODELS.openrouter, apiKey: env.OPENROUTER_API_KEY ?? '' },
    warn:
      wanted === 'elevenlabs'
        ? 'No ELEVENLABS_API_KEY: using MAI-Transcribe 2 via OpenRouter for speech-to-text'
        : undefined,
  }
}

async function transcribeElevenLabs(wav: Uint8Array, cfg: SttConfig, signal: AbortSignal): Promise<Transcription> {
  const response = await fetchRetryOnce(
    'https://api.elevenlabs.io/v1/speech-to-text',
    () => {
      const form = new FormData()
      form.append('model_id', cfg.model)
      form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
      form.append('tag_audio_events', 'false')
      form.append('diarize', 'false')
      // No content-type header: fetch adds multipart/form-data with the boundary.
      return { method: 'POST', headers: { 'xi-api-key': cfg.apiKey }, body: form }
    },
    signal,
  )
  if (!response.ok) throw new UpstreamError(`ElevenLabs speech-to-text HTTP ${response.status}: ${await readSnippet(response)}`, response.status)
  const data = (await response.json()) as { text?: string; language_code?: string }
  return { text: (data.text ?? '').trim(), language: data.language_code?.trim().toLowerCase() || undefined }
}

async function transcribeOpenRouter(wav: Uint8Array, cfg: SttConfig, signal: AbortSignal): Promise<Transcription> {
  const body = JSON.stringify({
    model: cfg.model,
    input_audio: { data: bytesToBase64(wav), format: 'wav' },
    response_format: 'json',
  })
  const response = await fetchRetryOnce(
    'https://openrouter.ai/api/v1/audio/transcriptions',
    () => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'voice-chat' },
      body,
    }),
    signal,
  )
  if (!response.ok) throw new UpstreamError(`OpenRouter transcription HTTP ${response.status}: ${await readSnippet(response)}`, response.status)
  const data = (await response.json()) as { text?: string }
  return { text: (data.text ?? '').trim() }
}

/** Transcribe a WAV clip. Throws UpstreamError on failure and AbortError when `signal` aborts. */
export function transcribe(wav: Uint8Array, cfg: SttConfig, signal: AbortSignal): Promise<Transcription> {
  return cfg.provider === 'elevenlabs' ? transcribeElevenLabs(wav, cfg, signal) : transcribeOpenRouter(wav, cfg, signal)
}
