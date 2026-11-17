// The shapes of the session API, shared by the Worker (src/server/db.ts) and the browser (src/client/api.ts).
// They are the D1 columns as they are (snake_case), so there is one vocabulary from the table to the screen.

export type Practice = 'off' | 'zh'

export const PRACTICE_VALUES: readonly Practice[] = ['off', 'zh']

export function parsePractice(value: unknown): Practice {
  return value === 'zh' ? 'zh' : 'off'
}

/** How fast the voice talks: "brisk" (the default) asks Eleven v4 for a quicker delivery, "natural" leaves it alone. */
export type Pace = 'natural' | 'brisk'

export const PACE_VALUES: readonly Pace[] = ['brisk', 'natural']

export function parsePace(value: unknown): Pace {
  return value === 'natural' ? 'natural' : 'brisk'
}

/** One row of GET /api/sessions. */
export interface SessionSummary {
  id: string
  title: string | null
  practice: Practice
  updated_at: number
  message_count: number
}

/** The session row inside GET /api/sessions/:id. */
export interface SessionRecord {
  id: string
  title: string | null
  practice: Practice
  created_at: number
  updated_at: number
}

/** A web page a reply cited (from the model's native web search). */
export interface SourceLink {
  title: string
  url: string
}

/** One saved memory (GET /api/memories). */
export interface MemoryRecord {
  id: number
  content: string
  created_at: number
}

/** One message of GET /api/sessions/:id (oldest first). */
export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  language: string | null
  interrupted: number
  tts_model: string | null
  stt_ms: number | null
  llm_first_ms: number | null
  tts_first_ms: number | null
  /** assistant: the links a web-searched reply cited. */
  sources: SourceLink[] | null
  created_at: number
}

export interface SessionDetail {
  session: SessionRecord
  messages: StoredMessage[]
}

/** The most links shown under one reply. */
export const MAX_SOURCES = 3

/** Keep only usable http(s) links, drop duplicates by URL, cap at 3, trim titles. Safe to run on anything (model output, stored JSON). */
export function cleanSources(items: ReadonlyArray<{ title?: unknown; url?: unknown }> | null | undefined): SourceLink[] {
  const out: SourceLink[] = []
  const seen = new Set<string>()
  for (const item of items ?? []) {
    if (typeof item?.url !== 'string') continue
    let url: URL
    try {
      url = new URL(item.url)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    const href = url.toString()
    if (seen.has(href)) continue
    seen.add(href)
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 140) : ''
    out.push({ title: title || url.hostname.replace(/^www\./, ''), url: href })
    if (out.length === MAX_SOURCES) break
  }
  return out
}

/** "www.skysports.com" becomes "skysports.com": the label a source link shows. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
