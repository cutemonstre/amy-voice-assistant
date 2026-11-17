// Gapless playback of streamed 24 kHz mono PCM with Web Audio: every chunk becomes an AudioBuffer scheduled right after the previous one.
// Chain: sources -> GainNode -> AnalyserNode -> destination (the analyser feeds the orb while the assistant speaks).

import { unlockAudio } from './audio'

export const PLAYBACK_RATE = 24_000

export class Player {
  private context: AudioContext | null = null
  private output: GainNode | null = null
  private outputAnalyser: AnalyserNode | null = null
  private nextTime = 0
  private sources = new Set<AudioBufferSourceNode>()
  private finishing = false
  private idleWaiters: Array<() => void> = []

  /** Create/resume the shared AudioContext and the playback chain. Call inside the press gesture so the browser allows audio later. */
  unlock(): AudioContext {
    const context = unlockAudio()
    if (this.context !== context || !this.output) {
      this.context = context
      this.output = context.createGain()
      this.outputAnalyser = context.createAnalyser()
      this.outputAnalyser.fftSize = 1024
      this.output.connect(this.outputAnalyser)
      this.outputAnalyser.connect(context.destination)
    }
    return context
  }

  /** Playback level source for the orb (null until unlock()). */
  get analyser(): AnalyserNode | null {
    return this.outputAnalyser
  }

  /** True while chunks are scheduled or playing. */
  get playing(): boolean {
    return this.sources.size > 0
  }

  /**
   * Schedule one chunk of signed 16-bit mono PCM (24 kHz). Returns the `performance.now()` timestamp at which this chunk will
   * actually start sounding (used for the "first sound" latency readout).
   */
  enqueue(pcm: Int16Array): number {
    const context = this.unlock()
    this.finishing = false
    const floats = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i]! / 32768
    const buffer = context.createBuffer(1, floats.length, PLAYBACK_RATE)
    buffer.copyToChannel(floats, 0)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.output!)
    const startAt = Math.max(context.currentTime + 0.05, this.nextTime)
    source.onended = () => {
      this.sources.delete(source)
      this.resolveIdleIfDone()
    }
    this.sources.add(source)
    source.start(startAt)
    this.nextTime = startAt + buffer.duration
    return performance.now() + (startAt - context.currentTime) * 1000
  }

  /** Resolves when all scheduled audio has really finished playing (immediately if nothing is playing). Call after the stream is done. */
  whenFinished(): Promise<void> {
    this.finishing = true
    if (this.sources.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Stop everything now (barge-in, new chat) and reset the schedule. Pending whenFinished() promises resolve. */
  stop() {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* never started or already stopped */
      }
      source.disconnect()
    }
    this.sources.clear()
    this.nextTime = 0
    this.finishing = false
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private resolveIdleIfDone() {
    if (this.sources.size > 0 || !this.finishing) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}
