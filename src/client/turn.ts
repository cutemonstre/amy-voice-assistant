// Client side of POST /api/turn: upload the clip, read the NDJSON reply line by line, dispatch to callbacks.
// The server keeps the conversation (D1): the form carries the session id, not the history.

import type { Pace, Practice, SourceLink } from '../shared/api-types'
import { LockedError, authHeaders } from './api'

export interface TurnTiming {
  stt?: number
  llmFirst?: number
  ttsFirst?: number
}

/** One tool call (or the web search) as the server reports it: a line of the feed. */
export interface ToolEvent {
  id: string
  name: string
  status: 'start' | 'done' | 'error'
  label: string
}

export interface TurnHandlers {
  /** `lang` is the language the speech recognizer detected (e.g. 'eng', 'zho'), when it says. */
  onTranscript(text: string, lang?: string): void
  onDelta(text: string): void
  /** `pcm` is signed 16-bit mono at 24 kHz. `index` is the sentence index. */
  onAudio(index: number, pcm: Int16Array): void
  /** A tool started, finished or failed: web_search, remember, forget or load_skill. */
  onTool(event: ToolEvent): void
  /** The pages a web-searched reply cited (at most 3). */
  onSources(items: SourceLink[]): void
  onTiming(timing: TurnTiming): void
  onWarn(message: string): void
  onError(stage: 'stt' | 'llm' | 'tts', message: string): void
  onDone(): void
}

type ServerLine =
  | { t: 'transcript'; text: string; lang?: string }
  | { t: 'delta'; text: string }
  | { t: 'audio'; i: number; pcm: string }
  | ({ t: 'tool' } & ToolEvent)
  | { t: 'sources'; items: SourceLink[] }
  | ({ t: 'timing' } & TurnTiming)
  | { t: 'warn'; msg: string }
  | { t: 'error'; stage: 'stt' | 'llm' | 'tts'; msg: string }
  | { t: 'done' }

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
}

function dispatch(line: ServerLine, handlers: TurnHandlers) {
  switch (line.t) {
    case 'transcript':
      return handlers.onTranscript(line.text, line.lang)
    case 'delta':
      return handlers.onDelta(line.text)
    case 'audio':
      return handlers.onAudio(line.i, base64ToInt16(line.pcm))
    case 'tool':
      return handlers.onTool({ id: line.id, name: line.name, status: line.status, label: line.label })
    case 'sources':
      return handlers.onSources(Array.isArray(line.items) ? line.items : [])
    case 'timing':
      return handlers.onTiming({ stt: line.stt, llmFirst: line.llmFirst, ttsFirst: line.ttsFirst })
    case 'warn':
      return handlers.onWarn(line.msg)
    case 'error':
      return handlers.onError(line.stage, line.msg)
    case 'done':
      return handlers.onDone()
  }
}

/**
 * Run one turn. Resolves when the stream ends. Rejects with an AbortError if `signal` aborts (barge-in), a LockedError on HTTP 401 and an Error for an
 * HTTP failure or a dropped connection. The caller decides what to show in each case.
 */
export async function runTurn(
  params: { wav: Blob; sessionId: string; practice: Practice; ttsModel: string; pace: Pace; signal: AbortSignal },
  handlers: TurnHandlers,
): Promise<void> {
  const body = new FormData()
  body.append('audio', params.wav, 'audio.wav')
  body.append('sessionId', params.sessionId)
  body.append('practice', params.practice)
  body.append('ttsModel', params.ttsModel)
  body.append('pace', params.pace)

  const response = await fetch('/api/turn', { method: 'POST', body, headers: authHeaders(), signal: params.signal })
  if (response.status === 401) throw new LockedError()
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { error?: string }).error ?? ''
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  if (!response.body) throw new Error('The server sent no response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const flushLines = (final: boolean) => {
    let newline: number
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const text = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (text) handleLine(text)
    }
    if (final && buffered.trim()) handleLine(buffered.trim())
  }
  const handleLine = (text: string) => {
    let line: ServerLine
    try {
      line = JSON.parse(text) as ServerLine
    } catch {
      return // a corrupt line is skipped rather than failing the turn
    }
    dispatch(line, handlers)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    flushLines(false)
  }
  buffered += decoder.decode()
  flushLines(true)
}
