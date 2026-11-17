// Sessions and messages in D1. Parameterised queries only (plain `?` placeholders): no value is ever spliced into SQL.
// The helpers take the database as an argument, so the tests run the real SQL (migrations/0001_init.sql) against SQLite.

import { cleanSources, domainOf, type MemoryRecord, type Practice, type SessionDetail, type SessionRecord, type SessionSummary, type SourceLink, type StoredMessage } from '../shared/api-types'
import type { ChatMessage } from './llm'

export const HISTORY_LIMIT = 20
export const SESSION_LIST_LIMIT = 50
export const TITLE_MAX = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** The session title: the first user message, whitespace collapsed, at most 60 characters (counted as characters, not UTF-16 units). */
export function titleFromMessage(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX).join('')
}

/** A stored message as it is read back for the model's history. */
export interface HistoryRow {
  role: 'user' | 'assistant'
  content: string
  /** assistant: the links a web-searched reply cited. */
  sources?: ReadonlyArray<{ title?: string; url: string }> | null
}

/**
 * A short note, for the model only, that a stored reply came from a live web search. The search results themselves are not kept, so
 * without this the model sees an answer it has no basis for and may "correct" it in a later turn (seen live: it retracted a verified F1
 * result). It goes into the LLM history only: it is never saved, shown in the feed or spoken.
 */
export function webSearchNote(sources: HistoryRow['sources']): string {
  const domains: string[] = []
  for (const source of cleanSources(sources ? [...sources] : [])) {
    const domain = domainOf(source.url)
    if (!domains.includes(domain)) domains.push(domain)
  }
  return domains.length ? `\n\n(Note: this reply was based on a live web search. Sources: ${domains.join(', ')}.)` : ''
}

/**
 * Turn stored rows into chat messages for the model. A reply that was web-searched gets the model-only note above. Consecutive messages of
 * one role (a barge-in left a user turn unanswered) are merged.
 */
export function toChatMessages(rows: ReadonlyArray<HistoryRow>): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const row of rows) {
    const text = row.content.trim()
    if (!text) continue
    const content = row.role === 'assistant' ? text + webSearchNote(row.sources) : text
    const last = out[out.length - 1]
    if (last && last.role === row.role) last.content += '\n' + content
    else out.push({ role: row.role, content })
  }
  return out
}

/** The last `limit` messages of a session, oldest first (with the web sources of searched replies, for the model-only note). */
export async function loadHistory(db: D1Database, sessionId: string, limit = HISTORY_LIMIT): Promise<HistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT role, content, sources FROM (
         SELECT id, role, content, sources FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .bind(sessionId, limit)
    .all<{ role: 'user' | 'assistant'; content: string; sources: string | null }>()
  return results.map((row) => ({ role: row.role, content: row.content, sources: parseStoredSources(row.sources) }))
}

export interface UserMessageInput {
  sessionId: string
  practice: Practice
  text: string
  /** The language Scribe detected, e.g. 'eng' or 'cmn'. */
  language?: string | null
  now?: number
}

/** Create the session if needed (its title is the first user message) and add the user's message, in one transaction. */
export async function saveUserMessage(db: D1Database, input: UserMessageInput): Promise<void> {
  const now = input.now ?? Date.now()
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, title, practice, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(sessions.title, excluded.title),
           practice = excluded.practice,
           updated_at = excluded.updated_at`,
      )
      .bind(input.sessionId, titleFromMessage(input.text), input.practice, now, now),
    db
      .prepare(`INSERT INTO messages (session_id, role, content, language, created_at) VALUES (?, 'user', ?, ?, ?)`)
      .bind(input.sessionId, input.text, input.language ?? null, now),
  ])
}

export interface AssistantMessageInput {
  sessionId: string
  /** The full generated text: [tags] and {{notes}} included. */
  text: string
  interrupted: boolean
  /** 'eleven_v4' | 'eleven_v4_turbo', or null for a text-only reply. */
  ttsModel: string | null
  timing: { stt?: number; llmFirst?: number; ttsFirst?: number }
  /** The links a web-searched reply cited (stored as JSON; omitted or empty means none). */
  sources?: SourceLink[]
  now?: number
}

/** Add the assistant's reply with the turn's server timings and bump the session's updated_at, in one transaction. */
export async function saveAssistantMessage(db: D1Database, input: AssistantMessageInput): Promise<void> {
  const now = input.now ?? Date.now()
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (session_id, role, content, interrupted, tts_model, stt_ms, llm_first_ms, tts_first_ms, sources, created_at)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.sessionId,
        input.text,
        input.interrupted ? 1 : 0,
        input.ttsModel,
        input.timing.stt ?? null,
        input.timing.llmFirst ?? null,
        input.timing.ttsFirst ?? null,
        input.sources?.length ? JSON.stringify(input.sources) : null,
        now,
      ),
    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).bind(now, input.sessionId),
  ])
}

/** The latest sessions, most recently used first. */
export async function listSessions(db: D1Database, limit = SESSION_LIST_LIMIT): Promise<SessionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, s.practice, s.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<SessionSummary>()
  return results
}

/** One session with all its messages (oldest first), or null if it does not exist. */
export async function getSession(db: D1Database, id: string): Promise<SessionDetail | null> {
  const session = await db
    .prepare(`SELECT id, title, practice, created_at, updated_at FROM sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRecord>()
  if (!session) return null
  const { results } = await db
    .prepare(
      `SELECT id, role, content, language, interrupted, tts_model, stt_ms, llm_first_ms, tts_first_ms, sources, created_at
         FROM messages WHERE session_id = ? ORDER BY id ASC`,
    )
    .bind(id)
    .all<Omit<StoredMessage, 'sources'> & { sources: string | null }>()
  return { session, messages: results.map((row) => ({ ...row, sources: parseStoredSources(row.sources) })) }
}

/** Delete a session and its messages. Returns false when there was no such session. */
export async function deleteSession(db: D1Database, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).bind(id),
    db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id),
  ])
  return (results[1]?.meta.changes ?? 0) > 0
}

/** The `sources` column holds JSON; anything unreadable is treated as "no sources". */
export function parseStoredSources(raw: string | null | undefined): SourceLink[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const clean = Array.isArray(parsed) ? cleanSources(parsed) : []
    return clean.length ? clean : null
  } catch {
    return null
  }
}

// ---- memories (the remember / forget tools, and the list shown in the drawer) -----------------------------------------------------

export const MEMORIES_IN_PROMPT = 50
export const MEMORIES_IN_LIST = 200
export const MEMORY_MAX_CHARS = 200

/** The newest memories first (that is the order they go into the prompt, and into the drawer). */
export async function listMemories(db: D1Database, limit = MEMORIES_IN_PROMPT): Promise<MemoryRecord[]> {
  const { results } = await db
    .prepare(`SELECT id, content, created_at FROM memories ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<MemoryRecord>()
  return results
}

/** Save a memory. A fact that is already saved (same words, any case) is not saved twice: its existing id comes back. */
export async function addMemory(
  db: D1Database,
  input: { content: string; sessionId?: string | null; now?: number },
): Promise<{ id: number; existing: boolean }> {
  const content = input.content
  const existing = await db
    .prepare(`SELECT id FROM memories WHERE lower(content) = lower(?) LIMIT 1`)
    .bind(content)
    .first<{ id: number }>()
  if (existing) return { id: existing.id, existing: true }
  const result = await db
    .prepare(`INSERT INTO memories (content, session_id, created_at) VALUES (?, ?, ?)`)
    .bind(content, input.sessionId ?? null, input.now ?? Date.now())
    .run()
  return { id: Number(result.meta.last_row_id), existing: false }
}

export async function getMemory(db: D1Database, id: number): Promise<MemoryRecord | null> {
  return db.prepare(`SELECT id, content, created_at FROM memories WHERE id = ?`).bind(id).first<MemoryRecord>()
}

/** Delete one memory. Returns false when there was no such memory. */
export async function deleteMemory(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run()
  return (result.meta.changes ?? 0) > 0
}
