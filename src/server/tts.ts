// ElevenLabs text-to-speech, one streaming request per sentence.
//
// POST https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=pcm_24000
//   header  xi-api-key
//   body    {"model_id": ..., "inputs": [{"text": sentence, "voice_id": ...}]}
//   reply   a chunked stream of raw signed 16-bit little-endian mono PCM at 24 kHz
// (eleven_v4 is documented on text-to-dialogue; the plain TTS WebSocket does not support it.)

import type { Pace } from '../shared/api-types'
import { UpstreamError, readSnippet } from './http'
import { EdgeTrimmer, trimEdges } from './trim'

export interface TtsConfig {
  apiKey: string
  model: string
  voiceId: string
}

/**
 * Re-chunk a byte stream so every piece has an even length (whole s16 samples). An odd trailing byte is carried into the next chunk.
 * A single dangling byte at the very end of the stream is dropped (half a sample cannot be played).
 */
export class S16Aligner {
  private carry: number | null = null

  push(chunk: Uint8Array): Uint8Array | null {
    let bytes = chunk
    if (this.carry !== null) {
      const joined = new Uint8Array(chunk.length + 1)
      joined[0] = this.carry
      joined.set(chunk, 1)
      bytes = joined
      this.carry = null
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes[bytes.length - 1]!
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    return bytes.length ? bytes : null
  }
}

/** The models the client may pick. Anything else falls back to the configured default. */
export const TTS_MODELS = ['eleven_v4', 'eleven_v4_turbo'] as const
export type TtsModel = (typeof TTS_MODELS)[number]

export function pickTtsModel(requested: unknown, fallback: string): string {
  return typeof requested === 'string' && (TTS_MODELS as readonly string[]).includes(requested) ? requested : fallback
}

/**
 * ElevenLabs can take ~16 s on the very first v4 request for a voice (a cold start on their side), so the wait for the first byte is
 * generous. Slow is not an error; only silence for this long is.
 */
export const TTS_FIRST_BYTE_TIMEOUT_MS = 30_000

/** Stream the PCM for one sentence, as even-length chunks. Throws UpstreamError (status + first 300 chars of the body) on non-200. */
export async function* streamTts(text: string, cfg: TtsConfig, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  // `inner` is `signal` plus our own first-byte timeout, so a timeout can be told apart from the turn being aborted.
  const inner = new AbortController()
  const onOuterAbort = () => inner.abort()
  if (signal.aborted) inner.abort()
  else signal.addEventListener('abort', onOuterAbort, { once: true })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true
    inner.abort()
  }, TTS_FIRST_BYTE_TIMEOUT_MS)
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=pcm_24000', {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: cfg.model, inputs: [{ text, voice_id: cfg.voiceId }] }),
      signal: inner.signal,
    })
    if (response.status !== 200) {
      throw new UpstreamError(`ElevenLabs TTS HTTP ${response.status}: ${await readSnippet(response, 300)}`, response.status)
    }
    if (!response.body) throw new UpstreamError('ElevenLabs TTS returned no body')

    reader = response.body.getReader()
    const aligner = new S16Aligner()
    for (;;) {
      const { done, value } = await reader.read()
      clearTimer() // the first byte is here: from now on only the turn's own abort ends this
      if (done) return
      if (!value?.length) continue
      const aligned = aligner.push(value)
      if (aligned) yield aligned
    }
  } catch (error) {
    if (timedOut && !signal.aborted) throw new UpstreamError(`ElevenLabs TTS sent nothing for ${TTS_FIRST_BYTE_TIMEOUT_MS / 1000} s`)
    throw error
  } finally {
    clearTimer()
    signal.removeEventListener('abort', onOuterAbort)
    await reader?.cancel().catch(() => {})
  }
}

/**
 * The delivery tag that makes Eleven v4 talk a little faster. Measured on Amy, eleven_v4_turbo, 3 sentences x 2 runs (2026-10-05): none 8.4 s,
 * [slightly faster] 7.4 s (-12%), [brisk] 7.1 s (-16%), [quickly] 6.7 s (-21%, too rushed). Chosen as the default pace.
 */
export const BRISK_TAG = '[slightly faster]'

/**
 * The text that goes to ElevenLabs. At the brisk pace every sentence gets BRISK_TAG in front, in front of any tag the model wrote
 * ("[slightly faster] [laughs] Oh no."). This is the TTS text only: the feed, the database and the model's history never see it.
 */
export function applyPace(text: string, pace: Pace): string {
  if (pace !== 'brisk' || text.startsWith(BRISK_TAG)) return text
  return `${BRISK_TAG} ${text}`
}

const SAMPLE_RATE = 24_000
const ms = (samples: number) => Math.round((samples / SAMPLE_RATE) * 1000)

/**
 * One sentence of speech, ready to play: the pace tag applied, the PCM streamed live, and the silence at both edges trimmed (see trim.ts).
 * Logs one debug line per sentence with the raw length and what the trim removed (that is how the dead air between sentences is measured).
 */
export async function* streamSpeech(sentence: string, cfg: TtsConfig, pace: Pace, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const trimmer = new EdgeTrimmer({ sampleRate: SAMPLE_RATE })
  try {
    yield* trimEdges(streamTts(applyPace(sentence, pace), cfg, signal), trimmer)
  } finally {
    const st = trimmer.stats
    if (st.inSamples > 0) {
      const text = sentence.length > 28 ? `${sentence.slice(0, 27)}…` : sentence
      console.debug(
        `[tts] "${text}" ${pace}: raw ${ms(st.inSamples)} ms (silence before ${ms(st.leadSilence)} ms, after ${ms(st.trailSilence)} ms), ` +
          `sent ${ms(st.outSamples)} ms (cut ${ms(st.leadDropped)} ms from the start and ${ms(st.trailDropped)} ms from the end)` +
          (st.sawSound ? '' : ', SILENT'),
      )
    }
  }
}
