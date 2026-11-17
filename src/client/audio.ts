// One AudioContext for the whole page, shared by the microphone graph and the playback graph. It is created and resumed
// SYNCHRONOUSLY inside a press handler (iOS Safari only allows audio to start from a user gesture), and it stays alive afterwards.

let context: AudioContext | null = null

/** Create (first call) or resume the shared AudioContext. Call it directly in a pointerdown/keydown handler. */
export function unlockAudio(): AudioContext {
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume().catch(() => {})
  return context
}

/** The shared context if it exists. */
export function currentAudioContext(): AudioContext | null {
  return context
}

/**
 * iOS Safari: tell the system this page both records and plays, so playback is not muted by the silent switch and the speaker is not
 * ducked while the mic is open. Harmless where `navigator.audioSession` does not exist. Call before getUserMedia.
 */
export function enableRecordAndPlay() {
  const nav = navigator as Navigator & { audioSession?: { type: string } }
  if (!nav.audioSession) return
  try {
    nav.audioSession.type = 'play-and-record'
  } catch {
    /* unsupported value: carry on */
  }
}
