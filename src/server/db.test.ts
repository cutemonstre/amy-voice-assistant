// Runs the real SQL (every file in /migrations) against SQLite through a thin D1-shaped adapter.
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanSources } from '../shared/api-types'
import {
  addMemory,
  deleteMemory,
  deleteSession,
  getMemory,
  getSession,
  isUuid,
  listMemories,
  listSessions,
  loadHistory,
  parseStoredSources,
  saveAssistantMessage,
  saveUserMessage,
  titleFromMessage,
  toChatMessages,
  webSearchNote,
} from './db'
import { migratedDb } from './d1-test-adapter'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let db: D1Database
beforeEach(() => {
  db = migratedDb()
})

describe('pure helpers', () => {
  it('isUuid accepts UUIDs only', () => {
    expect(isUuid(A)).toBe(true)
    expect(isUuid(A.toUpperCase())).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(`${A}; DROP TABLE sessions`)).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(null)).toBe(false)
  })

  it('titleFromMessage trims, collapses whitespace and cuts at 60 characters', () => {
    expect(titleFromMessage('  What is\n a   fun fact? ')).toBe('What is a fun fact?')
    expect(titleFromMessage('x'.repeat(100))).toHaveLength(60)
    expect(Array.from(titleFromMessage('你'.repeat(100)))).toHaveLength(60)
    expect(titleFromMessage('😀'.repeat(70))).toBe('😀'.repeat(60)) // never cuts a surrogate pair in half
  })

  it('toChatMessages merges consecutive same-role rows and drops empty ones', () => {
    expect(
      toChatMessages([
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: 'three' },
        { role: 'user', content: 'four' },
      ]),
    ).toEqual([
      { role: 'user', content: 'one\ntwo' },
      { role: 'assistant', content: 'three' },
      { role: 'user', content: 'four' },
    ])
  })
})

describe('sessions in D1', () => {
  it('creates the session lazily with the first user message as its title', async () => {
    expect(await listSessions(db)).toEqual([])
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'Tell me about octopuses', language: 'eng', now: 1000 })
    const [session] = await listSessions(db)
    expect(session).toEqual({ id: A, title: 'Tell me about octopuses', practice: 'off', updated_at: 1000, message_count: 1 })
  })

  it('keeps the title, updates practice and updated_at on later turns', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'first', now: 1000 })
    await saveAssistantMessage(db, { sessionId: A, text: 'reply', interrupted: false, ttsModel: null, timing: {}, now: 1500 })
    await saveUserMessage(db, { sessionId: A, practice: 'zh', text: 'second', now: 2000 })
    const detail = await getSession(db, A)
    expect(detail?.session).toEqual({ id: A, title: 'first', practice: 'zh', created_at: 1000, updated_at: 2000 })
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('stores the assistant message with tags, notes, timings and the model', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'zh', text: '你好', language: 'cmn', now: 1 })
    await saveAssistantMessage(db, {
      sessionId: A,
      text: '[softly] 你好{{nǐ hǎo}}！',
      interrupted: true,
      ttsModel: 'eleven_v4_turbo',
      timing: { stt: 600, llmFirst: 2500, ttsFirst: 3400 },
      now: 2,
    })
    const { messages } = (await getSession(db, A))!
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好', language: 'cmn', interrupted: 0, tts_model: null })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '[softly] 你好{{nǐ hǎo}}！',
      interrupted: 1,
      tts_model: 'eleven_v4_turbo',
      stt_ms: 600,
      llm_first_ms: 2500,
      tts_first_ms: 3400,
    })
  })

  it('loads the last N messages, oldest first', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'm0', now: 1 })
    for (let i = 1; i <= 24; i++) {
      await saveAssistantMessage(db, { sessionId: A, text: `m${i}`, interrupted: false, ttsModel: null, timing: {}, now: 1 + i })
    }
    await saveUserMessage(db, { sessionId: B, practice: 'off', text: 'other session', now: 99 })
    const history = await loadHistory(db, A, 20)
    expect(history).toHaveLength(20)
    expect(history[0]!.content).toBe('m5')
    expect(history[19]!.content).toBe('m24')
    expect(history.every((m) => m.content !== 'other session')).toBe(true)
  })

  it('lists sessions newest first, with message counts', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'older', now: 1000 })
    await saveUserMessage(db, { sessionId: B, practice: 'zh', text: 'newer', now: 2000 })
    await saveAssistantMessage(db, { sessionId: B, text: 'reply', interrupted: false, ttsModel: null, timing: {}, now: 2500 })
    const list = await listSessions(db)
    expect(list.map((s) => s.id)).toEqual([B, A])
    expect(list.map((s) => s.message_count)).toEqual([2, 1])
    expect(list[0]!.practice).toBe('zh')
    expect(await listSessions(db, 1)).toHaveLength(1)
  })

  it('returns null for an unknown session', async () => {
    expect(await getSession(db, A)).toBeNull()
  })

  it('deletes a session and its messages', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'hi', now: 1 })
    await saveAssistantMessage(db, { sessionId: A, text: 'hello', interrupted: false, ttsModel: null, timing: {}, now: 2 })
    await saveUserMessage(db, { sessionId: B, practice: 'off', text: 'keep me', now: 3 })
    expect(await deleteSession(db, A)).toBe(true)
    expect(await getSession(db, A)).toBeNull()
    expect(await deleteSession(db, A)).toBe(false)
    expect((await getSession(db, B))?.messages).toHaveLength(1)
    const orphans = await db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).bind(A).first<{ n: number }>()
    expect(orphans?.n).toBe(0)
  })

  it('treats hostile input as data, not SQL', async () => {
    const evil = `'); DROP TABLE messages; --`
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: evil, now: 1 })
    expect((await getSession(db, A))?.messages[0]?.content).toBe(evil)
    expect(await getSession(db, evil)).toBeNull()
    expect(await listSessions(db)).toHaveLength(1)
  })
})

describe('web sources on a reply', () => {
  it('saves them as JSON and reads them back with the session', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'who won?', now: 1 })
    await saveAssistantMessage(db, {
      sessionId: A,
      text: 'Max won.',
      interrupted: false,
      ttsModel: 'eleven_v4_turbo',
      timing: {},
      sources: [{ title: 'Sky Sports', url: 'https://www.skysports.com/f1/news/1' }],
      now: 2,
    })
    await saveAssistantMessage(db, { sessionId: A, text: 'no search here', interrupted: false, ttsModel: null, timing: {}, now: 3 })
    const { messages } = (await getSession(db, A))!
    expect(messages[0]!.sources).toBeNull()
    expect(messages[1]!.sources).toEqual([{ title: 'Sky Sports', url: 'https://www.skysports.com/f1/news/1' }])
    expect(messages[2]!.sources).toBeNull()
  })

  it('treats unreadable stored sources as none', () => {
    expect(parseStoredSources(null)).toBeNull()
    expect(parseStoredSources('')).toBeNull()
    expect(parseStoredSources('{oops')).toBeNull()
    expect(parseStoredSources('"a string"')).toBeNull()
    expect(parseStoredSources('[{"url":"javascript:alert(1)","title":"x"}]')).toBeNull()
  })

  it('cleanSources keeps http(s) links, de-duplicates by URL, caps at 3 and names untitled links by domain', () => {
    const out = cleanSources([
      { title: ' A  title ', url: 'https://a.example/x' },
      { title: 'dupe', url: 'https://a.example/x' },
      { title: '', url: 'https://www.b.example/y' },
      { title: 'bad', url: 'ftp://c.example/z' },
      { title: 'bad', url: 'not a url' },
      { title: 'C', url: 'http://c.example/' },
      { title: 'D', url: 'https://d.example/' },
    ])
    expect(out).toEqual([
      { title: 'A title', url: 'https://a.example/x' },
      { title: 'b.example', url: 'https://www.b.example/y' },
      { title: 'C', url: 'http://c.example/' },
    ])
    expect(cleanSources(null)).toEqual([])
  })
})

describe('memories in D1', () => {
  it('saves a memory and lists the newest first', async () => {
    const a = await addMemory(db, { content: 'Sam is learning Mandarin', sessionId: A, now: 1 })
    const b = await addMemory(db, { content: 'Sam prefers short answers', sessionId: null, now: 2 })
    expect(a).toEqual({ id: 1, existing: false })
    expect(b.id).toBe(2)
    expect((await listMemories(db)).map((m) => m.content)).toEqual(['Sam prefers short answers', 'Sam is learning Mandarin'])
    expect(await listMemories(db, 1)).toHaveLength(1)
    expect(await getMemory(db, 1)).toMatchObject({ id: 1, content: 'Sam is learning Mandarin' })
  })

  it('does not save the same fact twice (any case)', async () => {
    const first = await addMemory(db, { content: 'Sam is learning Mandarin' })
    const again = await addMemory(db, { content: 'sam IS learning mandarin' })
    expect(again).toEqual({ id: first.id, existing: true })
    expect(await listMemories(db)).toHaveLength(1)
  })

  it('keeps the newest 50 for the prompt, newest first', async () => {
    for (let i = 1; i <= 60; i++) await addMemory(db, { content: `fact ${i}`, now: i })
    const top = await listMemories(db, 50)
    expect(top).toHaveLength(50)
    expect(top[0]!.content).toBe('fact 60')
    expect(top[49]!.content).toBe('fact 11')
  })

  it('deletes one memory', async () => {
    const { id } = await addMemory(db, { content: 'temporary' })
    expect(await deleteMemory(db, id)).toBe(true)
    expect(await deleteMemory(db, id)).toBe(false)
    expect(await getMemory(db, id)).toBeNull()
  })

  it('outlives the session it was learned in', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'hi', now: 1 })
    await addMemory(db, { content: 'learned in A', sessionId: A })
    await deleteSession(db, A)
    expect((await listMemories(db)).map((m) => m.content)).toEqual(['learned in A'])
  })

  it('treats hostile text as data', async () => {
    const evil = `x'); DROP TABLE memories; --`
    await addMemory(db, { content: evil })
    expect((await listMemories(db))[0]!.content).toBe(evil)
  })
})

describe('the model-only note on web-searched replies', () => {
  const sources = [
    { title: 'ABC', url: 'https://www.abc.net.au/news/2026-10-05/verstappen-wins/1' },
    { title: 'Sky', url: 'https://www.skysports.com/f1/news/13594860/bahrain-gp' },
  ]
  const NOTE = '\n\n(Note: this reply was based on a live web search. Sources: abc.net.au, skysports.com.)'

  it('names the domains, compactly', () => {
    expect(webSearchNote(sources)).toBe(NOTE)
  })

  it('lists each domain once, drops unusable links, and is empty without sources', () => {
    expect(
      webSearchNote([
        { url: 'https://www.abc.net.au/a' },
        { url: 'https://abc.net.au/b' },
        { url: 'https://abc.net.au/b' },
        { url: 'javascript:alert(1)' },
      ]),
    ).toBe('\n\n(Note: this reply was based on a live web search. Sources: abc.net.au.)')
    expect(webSearchNote(null)).toBe('')
    expect(webSearchNote(undefined)).toBe('')
    expect(webSearchNote([])).toBe('')
    expect(webSearchNote([{ url: 'not a url' }])).toBe('')
  })

  it('is appended to a searched assistant reply in the model history, and to nothing else', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'Who won the most recent F1 race?', sources },
      { role: 'assistant', content: 'Max Verstappen won.', sources },
      { role: 'user', content: 'Thanks' },
      { role: 'assistant', content: 'No search here.', sources: null },
      { role: 'user', content: 'ok', sources: undefined },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'Who won the most recent F1 race?' }, // a user message never gets the note
      { role: 'assistant', content: 'Max Verstappen won.' + NOTE },
      { role: 'user', content: 'Thanks' },
      { role: 'assistant', content: 'No search here.' },
      { role: 'user', content: 'ok' },
    ])
  })

  it('keeps the note after the trimmed text when replies are merged', () => {
    const messages = toChatMessages([
      { role: 'assistant', content: '  First.  ', sources },
      { role: 'assistant', content: 'Second.', sources: null },
    ])
    expect(messages).toEqual([{ role: 'assistant', content: 'First.' + NOTE + '\nSecond.' }])
  })

  it('comes through loadHistory from D1, while the stored text (what the feed shows) stays clean', async () => {
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'who won?', now: 1 })
    await saveAssistantMessage(db, { sessionId: A, text: 'Max Verstappen won.', interrupted: false, ttsModel: 'eleven_v4_turbo', timing: {}, sources, now: 2 })
    await saveUserMessage(db, { sessionId: A, practice: 'off', text: 'remember my latte', now: 3 })

    const history = await loadHistory(db, A)
    expect(history[1]!.sources).toEqual(sources)
    expect(history[0]!.sources).toBeNull()
    expect(toChatMessages(history)[1]).toEqual({ role: 'assistant', content: 'Max Verstappen won.' + NOTE })

    const stored = (await getSession(db, A))!.messages[1]!
    expect(stored.content).toBe('Max Verstappen won.')
    expect(stored.content).not.toMatch(/Note:/)
  })
})
