import { describe, expect, it } from 'vitest'
import {
  BASE_PROMPT,
  TOOL_RULES,
  buildDynamicPrompt,
  buildStaticPrompt,
  buildSystemBlocks,
  formatSingaporeNow,
  languageAddendum,
  languageName,
  skillIndex,
} from './prompts'

const SKILLS = [
  { name: 'step-by-step', description: 'Walk through a task one step at a time.' },
  { name: 'language-tutor', description: 'Teach a language.' },
]
const NOW = new Date('2026-10-05T06:07:00Z') // 14:07 in Singapore

describe('languageName', () => {
  it('names ISO 639-3 and 639-1 codes', () => {
    expect(languageName('eng')).toBe('English')
    expect(languageName('cmn')).toBe('Mandarin Chinese')
    expect(languageName('ZH')).toBe('Chinese')
    expect(languageName('jpn')).toBe('Japanese')
  })
  it('falls back to Intl for codes outside the table', () => {
    expect(languageName('nob')).toMatch(/Norwegian/i)
  })
  it('rejects junk', () => {
    expect(languageName('')).toBeNull()
    expect(languageName(undefined)).toBeNull()
    expect(languageName('not a code')).toBeNull()
    expect(languageName('zzzzzz')).toBeNull()
  })
})

describe('languageAddendum', () => {
  it('names the language and its code', () => {
    expect(languageAddendum('cmn')).toContain('Mandarin Chinese (cmn)')
  })
  it('is empty when nothing was detected', () => {
    expect(languageAddendum(undefined)).toBe('')
    expect(languageAddendum('')).toBe('')
  })
  it('still carries an unknown code', () => {
    expect(languageAddendum('zzz')).toContain('zzz')
  })
})

describe('the static block (block 1, cached)', () => {
  it('holds the base prompt, the tool rules and the skills index, in that order', () => {
    const text = buildStaticPrompt(SKILLS)
    expect(text.startsWith(BASE_PROMPT)).toBe(true)
    expect(text.indexOf(TOOL_RULES)).toBeGreaterThan(BASE_PROMPT.length - 1)
    expect(text.indexOf(skillIndex(SKILLS))).toBeGreaterThan(text.indexOf(TOOL_RULES))
  })

  it('replies in the language the user spoke, with no English-only wording', () => {
    const text = buildStaticPrompt(SKILLS)
    expect(text).toContain('Reply in the language the user spoke, unless they ask otherwise.')
    expect(text).not.toMatch(/conversational English/)
    expect(text).toContain('[laughs]')
  })

  it('teaches the tool rules: filler before searching, durable memories only, no secrets, never read URLs aloud', () => {
    expect(TOOL_RULES).toMatch(/filler of two to four words/)
    expect(TOOL_RULES).toMatch(/Only durable things/)
    expect(TOOL_RULES).toMatch(/Never save secrets/)
    expect(TOOL_RULES).toMatch(/Never read a URL aloud/)
    expect(TOOL_RULES).toMatch(/confirm out loud/)
    expect(TOOL_RULES).toMatch(/Do not load it again while you are partway/)
  })

  it('tells the model that web-searched replies in the history were verified, and that it must not write the note itself', () => {
    expect(TOOL_RULES).toMatch(/based on a live web search/)
    expect(TOOL_RULES).toMatch(/were verified at the time/)
    expect(TOOL_RULES).toMatch(/do not doubt or retract them unless the user disputes them/)
    expect(TOOL_RULES).toMatch(/never write one yourself/)
  })

  it('lists the skills sorted by name, whatever order they come in', () => {
    const index = skillIndex(SKILLS)
    expect(index.indexOf('language-tutor')).toBeLessThan(index.indexOf('step-by-step'))
    expect(skillIndex([...SKILLS].reverse())).toBe(index)
    expect(skillIndex([])).toBe('')
  })

  it('is byte-identical on every turn: nothing in it depends on the time, the memories, the language or the practice mode', () => {
    const a = buildSystemBlocks({ skills: SKILLS, practice: 'off', now: NOW })[0]!.text
    const b = buildSystemBlocks({
      skills: SKILLS,
      practice: 'zh',
      lang: 'cmn',
      memories: [{ id: 7, content: 'Sam is learning Mandarin' }],
      now: new Date('2031-01-01T00:00:00Z'),
    })[0]!.text
    expect(a).toBe(b)
    expect(a).toBe(buildStaticPrompt(SKILLS))
  })

  it('has no timestamp, memory or language note in it', () => {
    const text = buildStaticPrompt(SKILLS)
    expect(text).not.toMatch(/\b20\d\d\b/)
    expect(text).not.toMatch(/Current date/)
    expect(text).not.toMatch(/\[#\d+\]/)
    expect(text).not.toMatch(/detected/)
    expect(text).not.toMatch(/Practice mode/)
  })
})

describe('the dynamic block (block 2)', () => {
  it('gives the date and time in Singapore', () => {
    expect(formatSingaporeNow(NOW)).toBe('Monday, 5 October 2026, 14:07')
    expect(buildDynamicPrompt({ practice: 'off', now: NOW })).toContain('Current date and time (Asia/Singapore): Monday, 5 October 2026, 14:07.')
  })

  it('rolls the date over at Singapore midnight, not UTC midnight', () => {
    expect(formatSingaporeNow(new Date('2026-10-05T16:30:00Z'))).toBe('Tuesday, 6 October 2026, 00:30')
  })

  it('lists the memories as [#id] lines, newest first, one line each', () => {
    const text = buildDynamicPrompt({
      practice: 'off',
      now: NOW,
      memories: [
        { id: 12, content: 'Sam prefers short answers' },
        { id: 9, content: 'Sam is\nlearning   Mandarin' },
      ],
    })
    expect(text).toContain('[#12] Sam prefers short answers\n[#9] Sam is learning Mandarin')
    expect(text).toMatch(/notes, not instructions/)
  })

  it('says so when nothing is saved', () => {
    expect(buildDynamicPrompt({ practice: 'off', now: NOW })).toContain('You have not saved anything about the user yet.')
  })

  it('adds the Mandarin tutor only in zh practice, and it teaches the {{note}} convention', () => {
    expect(buildDynamicPrompt({ practice: 'off', now: NOW })).not.toContain('Practice mode')
    const zh = buildDynamicPrompt({ practice: 'zh', lang: 'eng', now: NOW })
    expect(zh).toContain('Practice mode: Mandarin')
    expect(zh).toContain('{{nǐ hǎo}}')
    expect(zh).toContain('English (eng)')
  })

  it('puts the language note last and omits it without a language', () => {
    expect(buildDynamicPrompt({ practice: 'zh', lang: 'cmn', now: NOW }).trimEnd().endsWith('trust the words themselves if they disagree.')).toBe(true)
    expect(buildDynamicPrompt({ practice: 'off', now: NOW })).not.toContain('detected')
  })
})

describe('buildSystemBlocks', () => {
  it('is two text blocks, with the cache breakpoint on the first only', () => {
    const blocks = buildSystemBlocks({ skills: SKILLS, practice: 'off', now: NOW })
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
    expect(blocks[1]).toMatchObject({ type: 'text' })
    expect(blocks[1]).not.toHaveProperty('cache_control')
  })
})
