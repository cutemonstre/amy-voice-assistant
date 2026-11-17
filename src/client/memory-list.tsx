// The Memories tab of the drawer: what the assistant has saved about you (newest first), each with a delete (and a confirm).

import { useEffect, useState } from 'react'
import type { MemoryRecord } from '../shared/api-types'
import { LockedError, listMemories, removeMemory } from './api'
import { relativeTime } from './format'
import { TrashIcon } from './icons'

interface Props {
  /** The drawer is open: the list loads (again) each time this turns true, and when `refreshKey` changes. */
  active: boolean
  /** Bumped when a turn finishes (it may have saved a memory). */
  refreshKey: number
  onLocked: () => void
}

type Load = 'loading' | 'ready' | 'error' | 'locked'

export function MemoryList({ active, refreshKey, onLocked }: Props) {
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [load, setLoad] = useState<Load>('loading')
  const [now, setNow] = useState(() => Date.now())
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      setConfirmId(null)
      return
    }
    const controller = new AbortController()
    setNow(Date.now())
    listMemories(controller.signal)
      .then((list) => {
        setMemories(list)
        setLoad('ready')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (error instanceof LockedError) {
          setLoad('locked')
          onLocked()
        } else setLoad('error')
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLocked is a stable callback
  }, [active, refreshKey])

  const confirmForget = async (id: number) => {
    setBusyId(id)
    try {
      await removeMemory(id)
      setMemories((all) => all.filter((m) => m.id !== id))
    } catch (error) {
      if (error instanceof LockedError) onLocked()
      else setLoad('error')
    } finally {
      setBusyId(null)
      setConfirmId(null)
    }
  }

  return (
    <div className="px-2 pb-3">
      {load === 'loading' && <p className="px-3 py-6 text-sm text-white/35">Loading…</p>}
      {load === 'locked' && <p className="px-3 py-6 text-sm text-amber-200/60">Locked. Open your private link.</p>}
      {load === 'error' && <p className="px-3 py-6 text-sm text-red-300/70">Couldn&apos;t load your memories.</p>}
      {load === 'ready' && memories.length === 0 && (
        <p className="px-3 py-6 text-sm leading-relaxed text-white/35">
          Nothing saved yet. Say &ldquo;remember that&hellip;&rdquo; and it will show up here.
        </p>
      )}
      {load === 'ready' && memories.length > 0 && (
        <p className="px-3 pb-2 pt-1 text-xs leading-snug text-white/35">What I remember about you. The newest 50 are used in every chat.</p>
      )}

      <ul className="space-y-0.5">
        {memories.map((m) =>
          confirmId === m.id ? (
            <li key={m.id} className="rounded-xl bg-white/[0.05] px-3 py-3">
              <p className="text-sm text-white/80">Forget this?</p>
              <p className="wrap-any mt-0.5 line-clamp-3 text-xs text-white/45">{m.content}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmId(null)}
                  className="min-h-11 flex-1 rounded-xl bg-white/[0.07] px-3 text-sm text-white/75 hover:bg-white/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
                >
                  Keep
                </button>
                <button
                  type="button"
                  disabled={busyId === m.id}
                  onClick={() => void confirmForget(m.id)}
                  className="min-h-11 flex-1 rounded-xl bg-red-500/20 px-3 text-sm text-red-200 hover:bg-red-500/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300/70 disabled:opacity-50"
                >
                  Forget
                </button>
              </div>
            </li>
          ) : (
            <li key={m.id} className="flex items-stretch rounded-xl hover:bg-white/[0.04]">
              <div className="min-h-14 min-w-0 flex-1 px-3 py-2.5">
                <p className="wrap-any text-[15px] leading-snug text-white/85">{m.content}</p>
                <p className="mt-0.5 text-xs text-white/35">{relativeTime(m.created_at, now)}</p>
              </div>
              <button
                type="button"
                aria-label={`Forget: ${m.content}`}
                onClick={() => setConfirmId(m.id)}
                className="flex w-11 shrink-0 items-center justify-center rounded-xl text-white/30 hover:text-red-300/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300/70"
              >
                <TrashIcon />
              </button>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
