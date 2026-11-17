// Microphone capture for push-to-talk. Output: a 16 kHz mono 16-bit WAV (what both speech-to-text providers accept).
//
// The first start() asks for the mic and builds the audio graph on the page's shared AudioContext (see audio.ts). The stream and the
// context then stay alive, so later presses start instantly. Samples are only kept while a recording is active.

import { currentAudioContext, enableRecordAndPlay, unlockAudio } from './audio'

export interface Recording {
  wav: Blob
  /** How long the button was held, in ms (the 200 ms tail is not counted). */
  durationMs: number
}

export const TAIL_MS = 200
export const MIN_HOLD_MS = 300
export const MAX_RECORDING_MS = 60_000
const TARGET_RATE = 16_000

// Runs on the audio rendering thread. Batches the 128-sample render quanta into 1024-sample Float32 blocks.
const WORKLET_SOURCE = `
class VoiceChatCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(1024)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i]
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}
registerProcessor('voice-chat-capture', VoiceChatCapture)
`

/** Downsample mono Float32 to 16 kHz: box-filter averaging when shrinking, linear interpolation otherwise. */
export function downsample(input: Float32Array, inputRate: number, outputRate = TARGET_RATE): Float32Array {
  if (inputRate === outputRate) return input
  const ratio = inputRate / outputRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  if (ratio > 1) {
    for (let j = 0; j < length; j++) {
      const start = Math.floor(j * ratio)
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((j + 1) * ratio)))
      let sum = 0
      for (let k = start; k < end; k++) sum += input[k]!
      out[j] = sum / (end - start)
    }
  } else {
    for (let j = 0; j < length; j++) {
      const position = j * ratio
      const k = Math.floor(position)
      const frac = position - k
      out[j] = input[k]! * (1 - frac) + (input[Math.min(k + 1, input.length - 1)] ?? input[k]!) * frac
    }
  }
  return out
}

/** Encode mono Float32 samples as a 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export class Recorder {
  private context: AudioContext | null = null
  private micAnalyser: AnalyserNode | null = null
  private preparing: Promise<void> | null = null

  private capturing = false
  private frames: Float32Array[] = []
  private sampleCount = 0
  private heldSince = 0
  private onLimit: (() => void) | null = null
  private limitFired = false

  private tailTimer: ReturnType<typeof setTimeout> | null = null
  private pendingStop: ((recording: Recording | null) => void) | null = null

  /** Mic level source for the orb (null until the first press has built the graph). */
  get analyser(): AnalyserNode | null {
    return this.micAnalyser
  }

  /** Ask for the mic and build the audio graph, once. Later calls return immediately. */
  private prepare(): Promise<void> {
    this.preparing ??= this.build().catch((error) => {
      this.preparing = null // let the next press retry (e.g. after the user allows the mic)
      throw error
    })
    return this.preparing
  }

  private async build() {
    // Everything that needs the user gesture happens synchronously, before the first await: the shared AudioContext is created and
    // resumed, the iOS audio session is switched to play-and-record, and getUserMedia is called.
    const context = unlockAudio()
    enableRecordAndPlay()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'voice-chat-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onFrame(event.data)
      // Some browsers only run a worklet whose output reaches the destination; a zero-gain node keeps it silent.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node).connect(mute).connect(context.destination)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.micAnalyser = analyser
      this.context = context
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      throw error
    }
  }

  private onFrame(frame: Float32Array) {
    if (!this.capturing) return
    this.frames.push(frame)
    this.sampleCount += frame.length
    const rate = this.context?.sampleRate ?? currentAudioContext()?.sampleRate ?? 48_000
    if (!this.limitFired && this.sampleCount / rate * 1000 >= MAX_RECORDING_MS) {
      this.limitFired = true
      this.onLimit?.()
    }
  }

  /**
   * Begin recording. The first call prompts for the mic and resolves once recording has started. `onLimit` fires if the 60 s cap is hit
   * (the caller should then behave as if the button were released).
   */
  async start(onLimit?: () => void): Promise<void> {
    await this.prepare()
    if (this.context?.state === 'suspended') await this.context.resume()
    // A new press during the previous clip's tail cancels that clip.
    if (this.tailTimer) clearTimeout(this.tailTimer)
    this.tailTimer = null
    this.pendingStop?.(null)
    this.pendingStop = null

    this.frames = []
    this.sampleCount = 0
    this.limitFired = false
    this.onLimit = onLimit ?? null
    this.heldSince = performance.now()
    this.capturing = true
  }

  /** Release: keep capturing a 200 ms tail, then return the clip as a 16 kHz WAV. Resolves null if a new start() cancels it. */
  stop(): Promise<Recording | null> {
    if (!this.capturing) return Promise.resolve(null)
    const durationMs = performance.now() - this.heldSince
    return new Promise((resolve) => {
      this.pendingStop = resolve
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null
        this.pendingStop = null
        this.capturing = false
        resolve(this.finish(durationMs))
      }, TAIL_MS)
    })
  }

  /** Drop the current recording without producing a clip. */
  cancel() {
    if (this.tailTimer) clearTimeout(this.tailTimer)
    this.tailTimer = null
    this.pendingStop?.(null)
    this.pendingStop = null
    this.capturing = false
    this.frames = []
    this.sampleCount = 0
  }

  private finish(durationMs: number): Recording {
    const rate = this.context?.sampleRate ?? 48_000
    const all = new Float32Array(this.sampleCount)
    let offset = 0
    for (const frame of this.frames) {
      all.set(frame, offset)
      offset += frame.length
    }
    this.frames = []
    this.sampleCount = 0
    return { wav: encodeWav(downsample(all, rate), TARGET_RATE), durationMs }
  }
}
