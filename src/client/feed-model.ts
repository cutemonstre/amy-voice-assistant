// What the feed shows, and how a saved session becomes it. Pure (unit tested in feed-model.test.ts).

import type { SourceLink, StoredMessage } from '../shared/api-types'

export interface Latency {
  stt?: number
  llmFirst?: number
  ttsFirst?: number
  /** Measured in the browser: button release to the first audio chunk starting to play. */
  firstSound?: number
}

/** One small muted line above a reply: "Searched the web", "Remembered: …", "Using skill: step-by-step". */
export interface ToolLine {
  id: string
  name: string
  status: 'start' | 'done' | 'error'
  label: string
}

/** Add a tool line, or update the one with the same id (a call goes start, then done or error). Order of first appearance is kept. */
export function upsertTool(lines: ReadonlyArray<ToolLine> | undefined, line: ToolLine): ToolLine[] {
  const list = lines ?? []
  return list.some((l) => l.id === line.id) ? list.map((l) => (l.id === line.id ? line : l)) : [...list, line]
}

export interface FeedItem {
  key: string
  role: 'user' | 'assistant'
  text: string
  /** user: the clip was sent and the transcript has not arrived yet. */
  pending?: boolean
  /** assistant: still being produced. */
  live?: boolean
  /** assistant: cut off by a barge-in. */
  interrupted?: boolean
  error?: string | null
  /** assistant: what the model did besides talking (live turns only: tool lines are not saved). */
  tools?: ToolLine[]
  /** assistant: the pages a web-searched reply cited, shown as small links. */
  sources?: SourceLink[]
  /** user: the language the speech recognizer detected. */
  lang?: string | null
  /** assistant: the voice model that spoke it; null or absent for a text-only reply. */
  ttsModel?: string | null
  timing?: Latency
}

/** The saved messages of a session as feed items (oldest first). */
export function itemsFromMessages(messages: ReadonlyArray<StoredMessage>): FeedItem[] {
  return messages.map((m): FeedItem => {
    if (m.role === 'user') return { key: `m${m.id}`, role: 'user', text: m.content, lang: m.language }
    return {
      key: `m${m.id}`,
      role: 'assistant',
      text: m.content,
      interrupted: m.interrupted === 1,
      ttsModel: m.tts_model,
      sources: m.sources ?? undefined,
      timing: {
        stt: m.stt_ms ?? undefined,
        llmFirst: m.llm_first_ms ?? undefined,
        ttsFirst: m.tts_first_ms ?? undefined,
      },
    }
  })
}

/** The language of the user message a reply answers: the nearest user message before it. */
export function languageOfReply(items: ReadonlyArray<FeedItem>, index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role === 'user') return item.lang ?? null
  }
  return null
}

/** The title shown in the top bar: the first thing the user said, like the title the server saves. */
export function titleOf(items: ReadonlyArray<FeedItem>): string | null {
  const first = items.find((i) => i.role === 'user' && i.text.trim())
  return first ? first.text.replace(/\s+/g, ' ').trim() : null
}
