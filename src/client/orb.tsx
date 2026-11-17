// The orb dock: a ~96 px living orb at the bottom of the screen that IS the hold-to-talk control, with its status text above it and a
// soft glow that lights the bottom of the page.
//
// Look: stacked, blurred gradient layers inside a circular mask, rotating and drifting at different speeds, a bright core and an outer
// glow (styles.css, `.orb-*`). Sound: ONE requestAnimationFrame loop reads an AnalyserNode (the mic while listening, the TTS playback
// chain while speaking), smooths the RMS into a 0..1 `level` (fast attack, slow release) and writes CSS custom properties straight
// onto the scope element. There are NO React state updates per frame.

import { useEffect, useRef } from 'react'

export type Visual = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

interface OrbDockProps {
  visual: Visual
  /** Status text above the orb. */
  status: string
  /** Press/hold state for aria-pressed. */
  pressed: boolean
  getAnalyser: (visual: string) => AnalyserNode | null
  /** Fake a sound level (dev `?state=` preview only: there is no real audio to analyse). */
  synthetic?: boolean
  onPress: () => void
  onRelease: () => void
}

// Rotation speed of the first layer in degrees per second, per state.
const SPIN: Record<Visual, number> = { idle: 5, listening: 12, thinking: 70, speaking: 16, error: 12 }
const ATTACK_S = 0.06
const RELEASE_S = 0.25

export function OrbDock({ visual, status, pressed, getAnalyser, synthetic = false, onPress, onRelease }: OrbDockProps) {
  const scopeRef = useRef<HTMLDivElement>(null)
  // The animation loop reads the latest props through a ref instead of restarting on every change.
  const live = useRef({ visual, getAnalyser, synthetic })
  live.current = { visual, getAnalyser, synthetic }

  useEffect(() => {
    const scope = scopeRef.current
    if (!scope) return
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const samples = new Float32Array(1024)
    let raf = 0
    let last = performance.now()
    let t = 0
    let level = 0
    let scale = 1
    let spin = SPIN.idle
    let a1 = 0
    let a2 = 0
    let a3 = 0

    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
      last = now
      t += dt
      const { visual: state, getAnalyser: analyserFor, synthetic: fake } = live.current
      const reduce = reduceQuery.matches

      // 1. The sound level, smoothed.
      let target = 0
      if (fake) {
        if (state === 'listening' || state === 'speaking') target = 0.5 + 0.38 * Math.sin(t * 2.3) * Math.sin(t * 5.7 + 1)
      } else {
        const analyser = analyserFor(state)
        if (analyser) {
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
          const rms = Math.sqrt(sum / samples.length)
          target = Math.pow(Math.min(1, Math.max(0, (rms - 0.006) * 7)), 0.7)
        }
      }
      level += (target - level) * (1 - Math.exp(-dt / (target > level ? ATTACK_S : RELEASE_S)))

      // 2. Motion: size, spin, wobble, shimmer. With reduced motion nothing moves; only colour and opacity change.
      let wantScale = 1
      let wobble = 0
      let shimmer = 0
      if (!reduce) {
        if (state === 'idle') wantScale = 1 + 0.02 * Math.sin((t * 2 * Math.PI) / 4) // breathing, 4 s
        else if (state === 'thinking') {
          wantScale = 1 + 0.018 * Math.sin(t * 3.2)
          shimmer = 0.5 + 0.5 * Math.sin(t * 4.4)
          wobble = 0.008
        } else if (state === 'listening' || state === 'speaking') {
          wantScale = 1 + 0.12 * level
          wobble = 0.004 + 0.022 * level
        }
        spin += (SPIN[state] * (1 + level * 4) - spin) * (1 - Math.exp(-dt / 0.3))
        a1 += spin * dt
        a2 -= spin * 0.7 * dt
        a3 += spin * 1.7 * dt
      } else {
        a1 = a2 = a3 = 0
      }
      scale += (wantScale - scale) * (1 - Math.exp(-dt / 0.1))

      const w = Math.sin(t * 2.7)
      const style = scope.style
      style.setProperty('--level', level.toFixed(3))
      style.setProperty('--scale', scale.toFixed(4))
      style.setProperty('--shimmer', shimmer.toFixed(3))
      style.setProperty('--a1', `${a1.toFixed(2)}deg`)
      style.setProperty('--a2', `${a2.toFixed(2)}deg`)
      style.setProperty('--a3', `${a3.toFixed(2)}deg`)
      style.setProperty('--sx', (1 + wobble * w).toFixed(4))
      style.setProperty('--sy', (1 - wobble * Math.sin(t * 2.7 + 0.8)).toFixed(4))
      style.setProperty('--wr', `${(wobble * 90 * Math.sin(t * 1.3)).toFixed(3)}deg`)

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div ref={scopeRef} className="orb-scope" data-phase={visual}>
      {/* The light the orb casts on the bottom of the screen. It sits behind the feed. */}
      <div className="orb-light" aria-hidden="true" />

      <div className="orb-dock talk-surface">
        <p className="orb-status" aria-live="polite">
          {status}
        </p>
        <div className="orb-box">
          <div className="orb-glow" aria-hidden="true" />
          <button
            type="button"
            role="button"
            aria-label="Hold to talk"
            aria-pressed={pressed}
            className="orb talk-surface"
            onPointerDown={(e) => {
              if (e.button !== 0 && e.pointerType === 'mouse') return
              e.preventDefault()
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* the pointer is already gone */
              }
              onPress()
            }}
            onPointerUp={onRelease}
            onPointerCancel={onRelease}
            onLostPointerCapture={onRelease}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="orb-ball" aria-hidden="true">
              <span className="orb-layer orb-base" />
              <span className="orb-layer orb-a" />
              <span className="orb-layer orb-b" />
              <span className="orb-layer orb-c" />
              <span className="orb-core" />
              <span className="orb-spec" />
              <span className="orb-rim" />
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
