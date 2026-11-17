import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../shared/api-types'
import { itemsFromMessages, languageOfReply, titleOf, upsertTool, type FeedItem, type ToolLine } from './feed-model'

const message = (over: Partial<StoredMessage>): StoredMessage => ({
  id: 1, role: 'user', content: '', language: null, interrupted: 0, tts_model: null,
  stt_ms: null, llm_first_ms: null, tts_first_ms: null, sources: null, created_at: 0, ...over,
})

describe('itemsFromMessages', () => {
  it('maps saved rows to feed items', () => {
    const items = itemsFromMessages([
      message({ id: 1, role: 'user', content: '你好', language: 'zho' }),
      message({ id: 2, role: 'assistant', content: '你好{{nǐ hǎo}}！', tts_model: 'eleven_v4_turbo', stt_ms: 600, llm_first_ms: 1500, tts_first_ms: 2400 }),
      message({ id: 3, role: 'assistant', content: 'cut', interrupted: 1 }),
    ])
    expect(items[0]).toEqual({ key: 'm1', role: 'user', text: '你好', lang: 'zho' })
    expect(items[1]).toMatchObject({
      key: 'm2', role: 'assistant', text: '你好{{nǐ hǎo}}！', interrupted: false, ttsModel: 'eleven_v4_turbo',
      timing: { stt: 600, llmFirst: 1500, ttsFirst: 2400 },
    })
    expect(items[2]).toMatchObject({ interrupted: true, ttsModel: null })
    expect(items[1]!.sources).toBeUndefined()
  })

  it('carries the saved web sources of a reply', () => {
    const sources = [{ title: 'Sky Sports', url: 'https://www.skysports.com/f1/news/1' }]
    const [item] = itemsFromMessages([message({ id: 5, role: 'assistant', content: 'Max won.', sources })])
    expect(item!.sources).toEqual(sources)
  })
})

describe('upsertTool', () => {
  const line = (over: Partial<ToolLine>): ToolLine => ({ id: 'a', name: 'remember', status: 'start', label: 'Remembering…', ...over })
  it('adds a line, then updates it in place when the same call finishes', () => {
    let lines = upsertTool(undefined, line({}))
    expect(lines).toEqual([line({})])
    lines = upsertTool(lines, line({ status: 'done', label: 'Remembered: x' }))
    expect(lines).toEqual([line({ status: 'done', label: 'Remembered: x' })])
  })
  it('keeps the order calls first appeared in', () => {
    let lines = upsertTool(undefined, line({ id: 'a' }))
    lines = upsertTool(lines, line({ id: 'b', name: 'forget' }))
    lines = upsertTool(lines, line({ id: 'a', status: 'error', label: 'failed' }))
    expect(lines.map((l) => [l.id, l.status])).toEqual([['a', 'error'], ['b', 'start']])
  })
  it('does not change the list it was given', () => {
    const original = [line({})]
    upsertTool(original, line({ id: 'z' }))
    expect(original).toHaveLength(1)
  })
})

describe('languageOfReply and titleOf', () => {
  const items: FeedItem[] = [
    { key: 'a', role: 'user', text: ' hello   there ', lang: 'eng' },
    { key: 'b', role: 'assistant', text: 'hi' },
    { key: 'c', role: 'user', text: '你好', lang: 'zho' },
    { key: 'd', role: 'assistant', text: '你好' },
    { key: 'e', role: 'assistant', text: 'orphan' },
  ]
  it('finds the language of the user message a reply answers', () => {
    expect(languageOfReply(items, 1)).toBe('eng')
    expect(languageOfReply(items, 3)).toBe('zho')
    expect(languageOfReply(items, 4)).toBe('zho')
    expect(languageOfReply(items, 0)).toBeNull()
  })
  it('titles a chat by its first user message', () => {
    expect(titleOf(items)).toBe('hello there')
    expect(titleOf([])).toBeNull()
    expect(titleOf([{ key: 'x', role: 'assistant', text: 'only a reply' }])).toBeNull()
  })
})
