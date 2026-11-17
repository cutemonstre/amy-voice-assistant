// All the behaviour of the page: press/release, the turn lifecycle, barge-in, the chat feed, sessions and practice mode.
// The server keeps the conversation (D1): a turn sends the session id, and a session is reopened by loading its messages.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pace, Practice } from '../shared/api-types'
import { LockedError, loadSession } from './api'
import { itemsFromMessages, upsertTool, type FeedItem } from './feed-model'
import { Player } from './player'
import { DEFAULT_PACE, DEFAULT_TTS_MODEL, loadPace, loadPractice, loadTtsModel, savePace, savePractice, saveTtsModel, type TtsModel } from './prefs'
import { MIN_HOLD_MS, Recorder } from './recorder'
import { loadSessionId, newSessionId, saveSessionId } from './session'
import { captureTokenFromUrl } from './token'
import { runTurn } from './turn'

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'
type PressSource = 'pointer' | 'key'

export interface Notice {
  id: number
  kind: 'warn' | 'error' | 'info'
  text: string
}

/** A tool line still "running" when its turn ended or was cut off would pulse forever: drop it. */
const settled = (tools: FeedItem['tools']) => tools?.filter((t) => t.status !== 'start')

const STAGE_LABEL = { stt: 'Speech recognition', llm: 'Reply', tts: 'Voice' } as const
const HINT_MS = 4000

function micMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow it in the browser settings, then try again.'
  if (name === 'NotFoundError') return 'No microphone found.'
  return `Could not start the microphone: ${error instanceof Error ? error.message : String(error)}`
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

export function useVoiceChat({ spaceEnabled }: { spaceEnabled: boolean }) {
  const [{ recorder, player }] = useState(() => ({ recorder: new Recorder(), player: new Player() }))

  const [phase, setPhaseState] = useState<Phase>('idle')
  const [items, setItemsState] = useState<FeedItem[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [locked, setLocked] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [errorTick, setErrorTick] = useState(0) // bumps on every error, so the orb can flash red
  const [sessionId, setSessionIdState] = useState<string | null>(null)
  const [practice, setPracticeState] = useState<Practice>('off')
  const [ttsModel, setTtsModelState] = useState<TtsModel>(DEFAULT_TTS_MODEL)
  const [pace, setPaceState] = useState<Pace>(DEFAULT_PACE)

  const phaseRef = useRef<Phase>('idle')
  const itemsRef = useRef<FeedItem[]>([])
  const heldRef = useRef<PressSource | null>(null)
  const recordingRef = useRef(false) // the recorder is actually capturing
  const tokenRef = useRef(0) // bumped by every interrupt: callbacks of an older turn go quiet
  const activeRef = useRef<{ user: string; assistant: string } | null>(null)
  const nextIdRef = useRef(1)
  const abortRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const practiceRef = useRef<Practice>('off')
  const ttsModelRef = useRef<TtsModel>(DEFAULT_TTS_MODEL)
  const paceRef = useRef<Pace>(DEFAULT_PACE)
  const spaceEnabledRef = useRef(spaceEnabled)
  spaceEnabledRef.current = spaceEnabled

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])
  const updateItems = useCallback((fn: (items: FeedItem[]) => FeedItem[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItemsState(itemsRef.current)
  }, [])
  const patchItem = useCallback(
    (key: string, fn: (item: FeedItem) => FeedItem) => updateItems((all) => all.map((i) => (i.key === key ? fn(i) : i))),
    [updateItems],
  )
  const addNotice = useCallback((kind: Notice['kind'], text: string) => {
    setNotices((all) => (all.some((n) => n.text === text) ? all : [...all, { id: nextIdRef.current++, kind, text }]))
  }, [])
  const dismissNotice = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), [])
  const markLocked = useCallback(() => setLocked(true), [])
  const flagError = useCallback(() => setErrorTick((n) => n + 1), [])

  /** A short-lived hint (for example after a tap that was too short). It clears itself. */
  const showHint = useCallback(
    (text: string) => {
      const id = nextIdRef.current++
      setNotices((all) => [...all.filter((n) => n.kind !== 'info'), { id, kind: 'info', text }])
      setTimeout(() => setNotices((all) => all.filter((n) => n.id !== id)), HINT_MS)
    },
    [],
  )

  const setSession = useCallback((id: string) => {
    sessionIdRef.current = id
    setSessionIdState(id)
    saveSessionId(id)
  }, [])

  const setPractice = useCallback((next: Practice) => {
    practiceRef.current = next
    setPracticeState(next)
    savePractice(next)
  }, [])

  const setTtsModel = useCallback((model: TtsModel) => {
    ttsModelRef.current = model
    setTtsModelState(model)
    saveTtsModel(model)
  }, [])

  const setPace = useCallback((next: Pace) => {
    paceRef.current = next
    setPaceState(next)
    savePace(next)
  }, [])

  /** Stop the reply in progress: abort the request (and with it every upstream call), silence the audio, keep what was said. */
  const interrupt = useCallback(() => {
    tokenRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    player.stop()
    const active = activeRef.current
    activeRef.current = null
    if (!active) return
    // The server saves the user's message and the partial reply (marked interrupted); the feed just stops here.
    updateItems((all) =>
      all.flatMap((item) => {
        if (item.key === active.user) return item.text ? [{ ...item, pending: false }] : [] // never transcribed: nothing to show
        if (item.key === active.assistant) {
          if (!item.text && !item.error) return []
          return [{ ...item, live: false, interrupted: item.text.length > 0, tools: settled(item.tools) }]
        }
        return [item]
      }),
    )
  }, [player, updateItems])

  /** Load a saved session into the feed. A session without a row yet (a brand-new chat) is simply empty. */
  const loadInto = useCallback(
    async (id: string) => {
      setLoadingSession(true)
      try {
        const detail = await loadSession(id)
        if (sessionIdRef.current !== id) return // the user moved on while it loaded
        if (detail) {
          updateItems(() => itemsFromMessages(detail.messages))
          setPractice(detail.session.practice) // the mode this chat was last used in
        } else updateItems(() => [])
      } catch (error) {
        if (sessionIdRef.current !== id) return
        if (error instanceof LockedError) setLocked(true)
        else addNotice('warn', "Couldn't load this chat")
      } finally {
        if (sessionIdRef.current === id) setLoadingSession(false)
      }
    },
    [addNotice, setPractice, updateItems],
  )

  // Browser-only start-up: pick up ?token=<token> from the private link, the remembered settings, and resume the current chat.
  useEffect(() => {
    captureTokenFromUrl()
    setTtsModel(loadTtsModel())
    paceRef.current = loadPace()
    setPaceState(paceRef.current)
    practiceRef.current = loadPractice()
    setPracticeState(practiceRef.current)
    const saved = loadSessionId()
    const id = saved ?? newSessionId()
    setSession(id)
    if (saved) void loadInto(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, [])

  const startTurn = useCallback(
    async (wav: Blob, releasedAt: number, token: number) => {
      const id = nextIdRef.current++
      const userKey = `u${id}`
      const assistantKey = `a${id}`
      const abort = new AbortController()
      abortRef.current = abort
      activeRef.current = { user: userKey, assistant: assistantKey }
      if (!sessionIdRef.current) setSession(newSessionId())
      setLocked(false)
      updateItems((all) => [
        ...all,
        { key: userKey, role: 'user', text: '', pending: true },
        { key: assistantKey, role: 'assistant', text: '', live: true },
      ])

      const live = () => tokenRef.current === token
      let heardAudio = false
      try {
        await runTurn(
          { wav, sessionId: sessionIdRef.current!, practice: practiceRef.current, ttsModel: ttsModelRef.current, pace: paceRef.current, signal: abort.signal },
          {
            onTranscript: (text, lang) => live() && patchItem(userKey, (i) => ({ ...i, text, pending: false, lang: lang ?? null })),
            onDelta: (text) => live() && patchItem(assistantKey, (i) => ({ ...i, text: i.text + text })),
            onAudio: (_index, pcm) => {
              if (!live()) return
              const startsAt = player.enqueue(pcm)
              if (!heardAudio) {
                heardAudio = true
                setPhase('speaking')
                patchItem(assistantKey, (i) => ({ ...i, timing: { ...i.timing, firstSound: Math.max(0, startsAt - releasedAt) } }))
              }
            },
            onTool: (event) => live() && patchItem(assistantKey, (i) => ({ ...i, tools: upsertTool(i.tools, event) })),
            onSources: (items) => live() && patchItem(assistantKey, (i) => ({ ...i, sources: items })),
            onTiming: (timing) =>
              live() &&
              patchItem(assistantKey, (i) => ({
                ...i,
                timing: { ...i.timing, stt: timing.stt, llmFirst: timing.llmFirst, ttsFirst: timing.ttsFirst },
              })),
            onWarn: (message) => live() && addNotice('warn', message),
            onError: (stage, message) => {
              if (!live()) return
              flagError()
              // Nothing was understood: there is no user message to show.
              if (stage === 'stt') updateItems((all) => all.filter((i) => !(i.key === userKey && !i.text)))
              patchItem(assistantKey, (i) => ({ ...i, error: stage === 'stt' ? message : `${STAGE_LABEL[stage]}: ${message}` }))
            },
            onDone: () => {},
          },
        )
      } catch (error) {
        if (!live()) return // aborted by a barge-in or a new chat
        flagError()
        if (error instanceof LockedError) {
          updateItems((all) => all.filter((i) => i.key !== userKey && i.key !== assistantKey)) // nothing was processed
          setLocked(true)
        } else {
          const message = error instanceof Error ? error.message : String(error)
          patchItem(assistantKey, (i) => ({ ...i, error: i.error ?? `Connection problem: ${message}` }))
          updateItems((all) => all.filter((i) => !(i.key === userKey && !i.text)))
        }
      }
      if (!live()) return

      // The stream is complete; the last audio may still be playing.
      patchItem(userKey, (i) => ({ ...i, pending: false }))
      await player.whenFinished()
      if (!live()) return
      activeRef.current = null
      abortRef.current = null
      updateItems((all) =>
        all.flatMap((i) => {
          if (i.key !== assistantKey) return [i]
          if (!i.text && !i.error && !i.tools?.length) return []
          return [{ ...i, live: false, ttsModel: heardAudio ? ttsModelRef.current : null, tools: settled(i.tools) }]
        }),
      )
      setPhase('idle')
    },
    [addNotice, flagError, patchItem, player, setPhase, setSession, updateItems],
  )

  const release = useCallback(
    async (source?: PressSource) => {
      const held = heldRef.current
      if (!held || (source && held !== source)) return
      heldRef.current = null
      if (!recordingRef.current) return // still waiting for the mic: press() sees the release and cancels
      recordingRef.current = false

      const releasedAt = performance.now()
      setPhase('thinking')
      const token = ++tokenRef.current
      const recording = await recorder.stop()
      if (!recording || token !== tokenRef.current) return // a new press cancelled this clip
      if (recording.durationMs < MIN_HOLD_MS) {
        setPhase('idle')
        showHint('Hold the orb while you talk.')
        return
      }
      void startTurn(recording.wav, releasedAt, token)
    },
    [recorder, setPhase, showHint, startTurn],
  )

  const press = useCallback(
    (source: PressSource) => {
      if (heldRef.current) return
      heldRef.current = source
      recordingRef.current = false
      player.unlock() // inside the gesture, so the browser lets us play audio later
      if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') interrupt() // barge-in
      setPhase('listening')

      void (async () => {
        try {
          await recorder.start(() => void release())
        } catch (error) {
          heldRef.current = null
          setPhase('idle')
          flagError()
          addNotice('error', micMessage(error))
          return
        }
        if (!heldRef.current) {
          // Let go while the mic was still starting (the very first press, behind the permission prompt).
          recorder.cancel()
          setPhase('idle')
          showHint('Microphone ready. Press and hold the orb, then talk.')
          return
        }
        recordingRef.current = true
      })()
    },
    [addNotice, flagError, interrupt, player, recorder, release, setPhase, showHint],
  )

  /** Start a different chat: stop whatever is happening and clear the feed. */
  const switchTo = useCallback(
    (id: string, load: boolean) => {
      heldRef.current = null
      recordingRef.current = false
      recorder.cancel()
      interrupt()
      setPhase('idle')
      setLocked(false)
      setNotices([])
      updateItems(() => [])
      setSession(id)
      if (load) void loadInto(id)
      else setLoadingSession(false)
    },
    [interrupt, loadInto, recorder, setPhase, setSession, updateItems],
  )

  /** "+": a fresh chat. It is only saved once its first turn happens. */
  const newChat = useCallback(() => switchTo(newSessionId(), false), [switchTo])
  /** Reopen a saved chat and carry on with its context. */
  const openSession = useCallback(
    (id: string) => {
      if (id !== sessionIdRef.current) switchTo(id, true)
    },
    [switchTo],
  )
  /** A chat was deleted from the drawer: if it was the open one, start fresh. */
  const sessionDeleted = useCallback(
    (id: string) => {
      if (id === sessionIdRef.current) newChat()
    },
    [newChat],
  )

  // Space bar = the orb. Ignored while typing, while a menu is open, and for key repeat.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !spaceEnabledRef.current) return
      e.preventDefault() // no page scroll, no click on a focused button
      if (!e.repeat) press('key')
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return
      if (heldRef.current === 'key') e.preventDefault()
      void release('key')
    }
    const onBlur = () => void release()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [press, release])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      player.stop()
      recorder.cancel()
    },
    [player, recorder],
  )

  /** The analyser that tracks the sound the user should see right now: the mic while listening, the voice while speaking. */
  const getAnalyser = useCallback(
    (visual: string): AnalyserNode | null => (visual === 'listening' ? recorder.analyser : visual === 'speaking' ? player.analyser : null),
    [player, recorder],
  )

  return {
    phase,
    items,
    notices,
    locked,
    loadingSession,
    errorTick,
    sessionId,
    practice,
    ttsModel,
    pace,
    setPractice,
    setTtsModel,
    setPace,
    getAnalyser,
    press,
    release,
    newChat,
    openSession,
    sessionDeleted,
    dismissNotice,
    markLocked,
  }
}
