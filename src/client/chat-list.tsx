// The Chats tab of the drawer: the saved chats (title, how long ago, a 中文 badge for practice chats, delete with a confirm).

import { useEffect, useState } from 'react'
import type { SessionSummary } from '../shared/api-types'
import { LockedError, listSessions, removeSession } from './api'
import { relativeTime } from './format'
import { TrashIcon } from './icons'

interface Props {
  /** The chat that is open now (highlighted in the list). */
  currentId: string | null
  /** The drawer is open: the list loads (again) each time this turns true, and when `refreshKey` changes. */
  active: boolean
  /** Bumped when a turn finishes, so the list is fresh. */
  refreshKey: number
  onOpenSession: (id: string) => void
  onDeleted: (id: string) => void
  onLocked: () => void
  /** Close the drawer (after a chat was picked). */
  onClose: () => void
}

type Load = 'loading' | 'ready' | 'error' | 'locked'

export function ChatList({ currentId, active, refreshKey, onOpenSession, onDeleted, onLocked, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [load, setLoad] = useState<Load>('loading')
  const [now, setNow] = useState(() => Date.now())
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      setConfirmId(null)
      return
    }
    const controller = new AbortController()
    setNow(Date.now())
    listSessions(controller.signal)
      .then((list) => {
        setSessions(list)
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

  const confirmDelete = async (id: string) => {
    setBusyId(id)
    try {
      await removeSession(id)
      setSessions((all) => all.filter((s) => s.id !== id))
      onDeleted(id)
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
      {load === 'error' && <p className="px-3 py-6 text-sm text-red-300/70">Couldn&apos;t load your chats.</p>}
      {load === 'ready' && sessions.length === 0 && <p className="px-3 py-6 text-sm text-white/35">No saved chats yet.</p>}

      <ul className="space-y-0.5">
        {sessions.map((s) => {
          const current = s.id === currentId
          if (confirmId === s.id) {
            return (
              <li key={s.id} className="rounded-xl bg-white/[0.05] px-3 py-3">
                <p className="text-sm text-white/80">Delete this chat?</p>
                <p className="mt-0.5 truncate text-xs text-white/40">{s.title || 'Untitled'}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="min-h-11 flex-1 rounded-xl bg-white/[0.07] px-3 text-sm text-white/75 hover:bg-white/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busyId === s.id}
                    onClick={() => void confirmDelete(s.id)}
                    className="min-h-11 flex-1 rounded-xl bg-red-500/20 px-3 text-sm text-red-200 hover:bg-red-500/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300/70 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          }
          return (
            <li key={s.id} className={`flex items-stretch rounded-xl ${current ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  onOpenSession(s.id)
                  onClose()
                }}
                className="min-h-14 min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
              >
                <span className="block truncate text-[15px] text-white/85">{s.title || 'Untitled'}</span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-white/40">
                  <span>{relativeTime(s.updated_at, now)}</span>
                  {s.practice === 'zh' && (
                    <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-1.5 py-px text-[10px] leading-4 text-cyan-100/80">
                      中文
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete chat: ${s.title || 'Untitled'}`}
                onClick={() => setConfirmId(s.id)}
                className="flex w-11 shrink-0 items-center justify-center rounded-xl text-white/30 hover:text-red-300/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300/70"
              >
                <TrashIcon />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
