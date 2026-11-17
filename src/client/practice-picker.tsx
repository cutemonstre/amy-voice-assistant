// The Practice pill in the top bar ("Practice: Off" / "中文 Practice") and the small menu it opens.
// The menu is anchored to the right edge of the top bar and never wider than the screen, so it cannot clip on a phone.

import { useEffect, useId, useRef, useState } from 'react'
import type { Practice } from '../shared/api-types'

const OPTIONS: { id: Practice; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Replies in the language you speak' },
  { id: 'zh', label: '中文 Practice', hint: 'A Mandarin tutor: corrections, tips, pinyin on screen' },
]

interface Props {
  value: Practice
  onChange: (value: Practice) => void
  /** Reports whether the menu is open (the Space bar must not talk while it is). */
  onOpenChange?: (open: boolean) => void
  /** Dev preview only: start with the menu open. */
  defaultOpen?: boolean
}

export function PracticePicker({ value, onChange, onOpenChange, defaultOpen = false }: Props) {
  const [open, setOpenState] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }

  // Dev preview only: open the menu once the preview flag is known.
  useEffect(() => {
    if (defaultOpen) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen only wraps state setters
  }, [defaultOpen])

  // Close on a tap anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen only wraps state setters
  }, [open])

  const active = value === 'zh'
  return (
    <div ref={rootRef} className="shrink-0">
      {/* The button is 44 px tall (the touch target); the pill drawn inside it is smaller. */}
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        className="flex h-11 items-center rounded-full px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
      >
        <span
          className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors ${
            active ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100' : 'border-white/12 bg-white/[0.04] text-white/60'
          }`}
        >
          {active ? '中文 Practice' : 'Practice: Off'}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="opacity-60">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="radiogroup"
          aria-label="Practice mode"
          className="fade-in absolute right-2 top-full z-50 mt-1 w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-white/10 bg-[#0d1019]/95 p-1.5 shadow-2xl backdrop-blur-xl"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={value === o.id}
              onClick={() => {
                onChange(o.id)
                setOpen(false)
              }}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  value === o.id ? 'border-cyan-300' : 'border-white/30'
                }`}
                aria-hidden="true"
              >
                {value === o.id && <span className="h-2 w-2 rounded-full bg-cyan-300" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] text-white/90">{o.label}</span>
                <span className="block text-[12px] leading-snug text-white/45">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
