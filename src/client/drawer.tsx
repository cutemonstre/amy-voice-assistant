// The ☰ drawer: two tabs at the top, Chats and Memories, and at the bottom the settings. On a phone it is a full-height panel that
// takes most of the width; the rest is a dimmed backdrop you can tap to close.

import { useEffect, useRef, useState } from 'react'
import type { Pace } from '../shared/api-types'
import { ChatList } from './chat-list'
import { CloseIcon } from './icons'
import { MemoryList } from './memory-list'
import type { TtsModel } from './prefs'

export type DrawerTab = 'chats' | 'memories'

interface Props {
  open: boolean
  onClose: () => void
  /** The chat that is open now (highlighted in the list). */
  currentId: string | null
  /** Bumped when a turn finishes, so the lists are fresh the next time the drawer opens. */
  refreshKey: number
  ttsModel: TtsModel
  onTtsModel: (model: TtsModel) => void
  pace: Pace
  onPace: (pace: Pace) => void
  onOpenSession: (id: string) => void
  onDeleted: (id: string) => void
  onLocked: () => void
  /** Dev preview only: the tab to open on. */
  initialTab?: DrawerTab
}

const MODELS: { id: TtsModel; label: string }[] = [
  { id: 'eleven_v4_turbo', label: 'Turbo' },
  { id: 'eleven_v4', label: 'v4' },
]

const PACES: { id: Pace; label: string }[] = [
  { id: 'brisk', label: 'Brisk' },
  { id: 'natural', label: 'Natural' },
]

/** One setting: a small label, a two-option segmented control (44 px tall buttons) and a one-line hint. */
function Setting<T extends string>({
  id,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div>
      <p id={`${id}-label`} className="text-[11px] uppercase tracking-[0.16em] text-white/40">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="mt-1.5 grid grid-cols-2 gap-1 rounded-xl bg-white/[0.05] p-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={`min-h-11 rounded-lg text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70 ${
              value === o.id ? 'bg-white/[0.14] text-white/90' : 'text-white/45 hover:text-white/70'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs leading-snug text-white/35">{hint}</p>
    </div>
  )
}

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'memories', label: 'Memories' },
]

export function Drawer({ open, onClose, currentId, refreshKey, ttsModel, onTtsModel, pace, onPace, onOpenSession, onDeleted, onLocked, initialTab }: Props) {
  const [tab, setTab] = useState<DrawerTab>('chats')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open} inert={!open}>
      {/* the dimmed page behind: a tap closes the drawer */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close menu"
        onClick={onClose}
        className={`absolute inset-0 bg-black/65 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`}
      />

      <aside
        role="dialog"
        aria-label="Chats and memories"
        className={`absolute inset-y-0 left-0 flex h-dvh w-[88vw] max-w-[22rem] flex-col border-r border-white/10 bg-[#0a0d16] shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))', paddingLeft: 'env(safe-area-inset-left, 0px)' }}
      >
        <div className="flex shrink-0 items-center gap-1 pl-2 pr-1">
          <div role="tablist" aria-label="Menu" className="grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-xl bg-white/[0.05] p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls="drawer-panel"
                onClick={() => setTab(t.id)}
                className={`min-h-11 rounded-lg text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70 ${
                  tab === t.id ? 'bg-white/[0.14] text-white/90' : 'text-white/45 hover:text-white/70'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/55 hover:bg-white/[0.07] hover:text-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
          >
            <CloseIcon />
          </button>
        </div>

        <div
          id="drawer-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="scroll-contain mt-2 min-h-0 flex-1 overflow-y-auto"
        >
          {tab === 'chats' ? (
            <ChatList
              currentId={currentId}
              active={open}
              refreshKey={refreshKey}
              onOpenSession={onOpenSession}
              onDeleted={onDeleted}
              onLocked={onLocked}
              onClose={onClose}
            />
          ) : (
            <MemoryList active={open} refreshKey={refreshKey} onLocked={onLocked} />
          )}
        </div>

        {/* settings */}
        <div
          className="shrink-0 space-y-3 border-t border-white/10 px-4 pt-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <Setting
            id="voice-model"
            label="Voice model"
            hint="Turbo answers sooner. v4 sounds richer."
            value={ttsModel}
            options={MODELS}
            onChange={onTtsModel}
          />
          <Setting id="pace" label="Pace" hint="Brisk talks a little faster." value={pace} options={PACES} onChange={onPace} />
        </div>
      </aside>
    </div>
  )
}
