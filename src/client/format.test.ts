import { describe, expect, it } from 'vitest'
import { formatMeta, formatMs, parseSpoken, relativeTime, shortLang, ttsModelLabel } from './format'

describe('formatMs', () => {
  it('uses ms under a second and seconds above', () => {
    expect(formatMs(820)).toBe('820 ms')
    expect(formatMs(999.4)).toBe('999 ms')
    expect(formatMs(1600)).toBe('1.6 s')
    expect(formatMs(2449)).toBe('2.4 s')
  })
})

describe('parseSpoken', () => {
  it('separates tags from text', () => {
    expect(parseSpoken('Why? [laughs] Because it can.')).toEqual([
      { kind: 'text', text: 'Why? ' },
      { kind: 'tag', text: 'laughs' },
      { kind: 'text', text: ' Because it can.' },
    ])
  })
  it('separates {{notes}} from text', () => {
    expect(parseSpoken('你好{{nǐ hǎo}}！')).toEqual([
      { kind: 'text', text: '你好' },
      { kind: 'note', text: 'nǐ hǎo' },
      { kind: 'text', text: '！' },
    ])
  })
  it('handles tags and notes together, a leading tag and no markup', () => {
    expect(parseSpoken('[softly] 谢谢{{xièxie}}')).toEqual([
      { kind: 'tag', text: 'softly' },
      { kind: 'text', text: ' 谢谢' },
      { kind: 'note', text: 'xièxie' },
    ])
    expect(parseSpoken('Just words.')).toEqual([{ kind: 'text', text: 'Just words.' }])
    expect(parseSpoken('')).toEqual([])
  })
  it('hides a tag or note that is still streaming in', () => {
    expect(parseSpoken('Hello [lau')).toEqual([{ kind: 'text', text: 'Hello ' }])
    expect(parseSpoken('Hello [laughs')).toEqual([{ kind: 'text', text: 'Hello ' }])
    expect(parseSpoken('你好{{nǐ')).toEqual([{ kind: 'text', text: '你好' }])
    expect(parseSpoken('你好{{nǐ hǎo}')).toEqual([{ kind: 'text', text: '你好' }])
    expect(parseSpoken('你好{')).toEqual([{ kind: 'text', text: '你好' }])
  })
  it('keeps a single brace that is followed by text', () => {
    expect(parseSpoken('a {b} c')).toEqual([{ kind: 'text', text: 'a {b} c' }])
  })
  it('never shows a note twice while it streams, at any split point', () => {
    const text = '你好{{nǐ hǎo}}，再见{{zàijiàn}}。'
    const done = parseSpoken(text).filter((p) => p.kind === 'note').length
    expect(done).toBe(2)
    for (let i = 0; i <= text.length; i++) {
      const visible = parseSpoken(text.slice(0, i)).map((p) => p.text).join('')
      expect(visible).not.toMatch(/[{}[\]]/)
    }
  })
})

describe('shortLang and ttsModelLabel', () => {
  it('shortens ISO 639-3 codes', () => {
    expect(shortLang('eng')).toBe('en')
    expect(shortLang('zho')).toBe('zh')
    expect(shortLang('cmn')).toBe('zh')
    expect(shortLang('xyz')).toBe('xyz')
    expect(shortLang(null)).toBeNull()
    expect(shortLang('')).toBeNull()
  })
  it('labels the voice models', () => {
    expect(ttsModelLabel('eleven_v4_turbo')).toBe('Turbo')
    expect(ttsModelLabel('eleven_v4')).toBe('v4')
    expect(ttsModelLabel(null)).toBeNull()
  })
})

describe('formatMeta', () => {
  it('formats time, language and voice', () => {
    expect(formatMeta({ firstSoundMs: 3500, lang: 'zho', ttsModel: 'eleven_v4_turbo' })).toBe('3.5 s · zh · Turbo')
  })
  it('prefers first sound, then the server first audio, then the first token', () => {
    expect(formatMeta({ firstSoundMs: 3500, ttsFirstMs: 2400, llmFirstMs: 1500 })).toBe('3.5 s')
    expect(formatMeta({ ttsFirstMs: 2400, llmFirstMs: 1500 })).toBe('2.4 s')
    expect(formatMeta({ llmFirstMs: 1500 })).toBe('1.5 s')
    expect(formatMeta({ ttsFirstMs: null, llmFirstMs: null })).toBe('')
  })
  it('says interrupted, with or without the rest', () => {
    expect(formatMeta({ ttsFirstMs: 800, lang: 'eng', ttsModel: 'eleven_v4', interrupted: true })).toBe('800 ms · en · v4 · interrupted')
    expect(formatMeta({ interrupted: true })).toBe('interrupted')
  })
  it('leaves out what is not known (a text-only reply has no voice)', () => {
    expect(formatMeta({ llmFirstMs: 1500, lang: 'eng' })).toBe('1.5 s · en')
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const ago = (ms: number) => relativeTime(now - ms, now)
  it('counts up from now', () => {
    expect(ago(5_000)).toBe('just now')
    expect(ago(5 * 60_000)).toBe('5 min ago')
    expect(ago(3 * 3_600_000)).toBe('3 h ago')
    expect(ago(30 * 3_600_000)).toBe('yesterday')
    expect(ago(4 * 86_400_000)).toBe('4 d ago')
  })
  it('switches to a short date after a week', () => {
    const ts = now - 10 * 86_400_000
    expect(relativeTime(ts, now)).toBe(new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' }))
  })
  it('never goes negative for a clock that is slightly ahead', () => {
    expect(relativeTime(now + 5_000, now)).toBe('just now')
  })
})
