// Edge-silence trim for one sentence of streamed speech (16-bit mono PCM). Every sentence is its own TTS request, and ElevenLabs puts
// 60-120 ms of silence before the voice and 180-370 ms after it, so each sentence boundary had 0.27-0.49 s of dead air on top of the
// natural phrasing. This cuts the leading silence (keeping 30 ms of lead-in) and the trailing silence (keeping at most 120 ms).
//
// It works on the stream as it arrives:
//   - Leading: samples are dropped until the first 10 ms window that has a sample at or above -40 dBFS. The 30 ms before that window are kept
//     (a soft consonant must not lose its first moment). Nothing is added to the time to first audio: the first loud window goes out as soon
//     as it is complete, and the quiet audio before it is simply not sent.
//   - Trailing: audio is forwarded live up to the start of the current QUIET run. The quiet run is held back. If a loud window follows (a
//     pause inside the sentence), the held run is sent untouched, so a pause mid-sentence is never cut. When the stream ends, the held run is
//     the trailing silence: at most 120 ms of it is sent.
//
// "Loud" means a PEAK at or above the threshold, not an average: it keeps soft speech (a whisper, a fricative) that an average would drop.
// A clip with no sample above the threshold at all is silence and produces no output. Pure and dependency free (trim.test.ts).

export interface TrimOptions {
  sampleRate?: number
  /** Samples below this level (dBFS) are quiet. */
  thresholdDb?: number
  /** The analysis window. */
  windowMs?: number
  /** Lead-in kept before the first loud window. */
  leadKeepMs?: number
  /** The most trailing silence kept. */
  trailMaxMs?: number
}

export interface TrimStats {
  inSamples: number
  outSamples: number
  /** Leading samples dropped. */
  leadDropped: number
  /** Trailing samples dropped. */
  trailDropped: number
  /** How much silence the clip had before the sound began (to the start of the first loud window), before any trimming. */
  leadSilence: number
  /** How much silence the clip had after the sound ended, before any trimming. */
  trailSilence: number
  /** False for a clip that never rose above the threshold. */
  sawSound: boolean
}

export const DEFAULT_TRIM: Required<TrimOptions> = {
  sampleRate: 24_000,
  thresholdDb: -40,
  windowMs: 10,
  leadKeepMs: 30,
  trailMaxMs: 120,
}

function concat(parts: ReadonlyArray<Int16Array>): Int16Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Int16Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** s16le bytes to samples, without assuming the byte offset is even. A dangling odd byte is ignored. */
export function bytesToSamples(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = ((bytes[2 * i]! | (bytes[2 * i + 1]! << 8)) << 16) >> 16
  return out
}

/** Samples to s16le bytes (little-endian whatever the platform). */
export function samplesToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!
    out[2 * i] = v & 0xff
    out[2 * i + 1] = (v >> 8) & 0xff
  }
  return out
}

export class EdgeTrimmer {
  private readonly windowSamples: number
  private readonly threshold: number
  private readonly leadKeepSamples: number
  private readonly trailMaxSamples: number

  private carry: Int16Array = new Int16Array(0) // less than one window, waiting for more samples
  private started = false // a loud window has been seen
  private preroll: Int16Array = new Int16Array(0) // the last leadKeepSamples quiet samples before the sound
  private held: Int16Array[] = [] // the current quiet run after the sound began
  private inSamples = 0
  private outSamples = 0
  private leadDropped = 0
  private trailDropped = 0
  private leadSilence = 0
  private trailSilence = 0

  constructor(options: TrimOptions = {}) {
    const o = { ...DEFAULT_TRIM, ...options }
    this.windowSamples = Math.max(1, Math.round((o.sampleRate * o.windowMs) / 1000))
    this.threshold = Math.pow(10, o.thresholdDb / 20) * 32768
    this.leadKeepSamples = Math.round((o.sampleRate * o.leadKeepMs) / 1000)
    this.trailMaxSamples = Math.round((o.sampleRate * o.trailMaxMs) / 1000)
  }

  get stats(): TrimStats {
    return {
      inSamples: this.inSamples,
      outSamples: this.outSamples,
      leadDropped: this.leadDropped,
      trailDropped: this.trailDropped,
      leadSilence: this.leadSilence,
      trailSilence: this.trailSilence,
      sawSound: this.started,
    }
  }

  private isLoud(window: Int16Array): boolean {
    for (let i = 0; i < window.length; i++) {
      const v = window[i]!
      if ((v < 0 ? -v : v) >= this.threshold) return true
    }
    return false
  }

  private emit(parts: Int16Array[]): Uint8Array | null {
    const samples = concat(parts)
    this.outSamples += samples.length
    return samples.length ? samplesToBytes(samples) : null
  }

  /** One analysed window (or the short last one). Appends to `out` whatever is now safe to send. */
  private feed(window: Int16Array, out: Int16Array[]) {
    const loud = this.isLoud(window)
    if (!this.started) {
      if (!loud) {
        this.preroll = concat([this.preroll, window])
        if (this.preroll.length > this.leadKeepSamples) {
          const cut = this.preroll.length - this.leadKeepSamples
          this.leadDropped += cut
          this.preroll = this.preroll.slice(cut)
        }
        return
      }
      this.started = true
      this.leadSilence = this.leadDropped + this.preroll.length
      out.push(this.preroll, window)
      this.preroll = new Int16Array(0)
      return
    }
    if (loud) {
      // A quiet stretch inside the sentence: it goes out untouched, before the sound that ended it.
      out.push(...this.held, window)
      this.held = []
    } else {
      this.held.push(window)
    }
  }

  /** Feed the next chunk of s16le bytes. Returns the bytes that can be sent now (or null). */
  push(chunk: Uint8Array): Uint8Array | null {
    const samples = bytesToSamples(chunk)
    this.inSamples += samples.length
    const data = concat([this.carry, samples])
    const out: Int16Array[] = []
    let pos = 0
    while (pos + this.windowSamples <= data.length) {
      this.feed(data.subarray(pos, pos + this.windowSamples), out)
      pos += this.windowSamples
    }
    this.carry = data.slice(pos)
    return this.emit(out)
  }

  /** The stream ended: the held quiet run is the trailing silence, so send at most trailMax of it. */
  end(): Uint8Array | null {
    const out: Int16Array[] = []
    if (this.carry.length) {
      this.feed(this.carry, out)
      this.carry = new Int16Array(0)
    }
    if (this.started) {
      const quiet = concat(this.held)
      this.held = []
      this.trailSilence = quiet.length
      const keep = quiet.subarray(0, this.trailMaxSamples)
      this.trailDropped += quiet.length - keep.length
      out.push(keep)
    } else {
      this.leadDropped += this.preroll.length
      this.leadSilence = this.leadDropped
      this.preroll = new Int16Array(0)
    }
    return this.emit(out)
  }
}

/** Trim the edges of a stream of s16le chunks, forwarding audio live (see EdgeTrimmer). */
export async function* trimEdges(source: AsyncIterable<Uint8Array>, trimmer: EdgeTrimmer = new EdgeTrimmer()): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    const out = trimmer.push(chunk)
    if (out) yield out
  }
  const tail = trimmer.end()
  if (tail) yield tail
}
