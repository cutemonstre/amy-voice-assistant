import { beforeEach, describe, expect, it } from 'vitest'
import { migratedDb } from './d1-test-adapter'
import { addMemory, getMemory, listMemories } from './db'
import { buildToolDefinitions, parseToolArguments, runTool, toolStartLabel, type ToolContext } from './tools'

const SKILLS = [
  { name: 'step-by-step', description: 'd1', body: 'STEP BODY' },
  { name: 'language-tutor', description: 'd2', body: 'TUTOR BODY' },
]
let ctx: ToolContext

beforeEach(() => {
  ctx = { db: migratedDb(), sessionId: '11111111-1111-4111-8111-111111111111', skills: SKILLS }
})

const call = (name: string, args: unknown) => ({ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })

describe('buildToolDefinitions', () => {
  it('defines remember, forget and load_skill (web search is the model\'s own, not a tool of ours)', () => {
    const defs = buildToolDefinitions(SKILLS)
    expect(defs.map((d) => d.function.name)).toEqual(['remember', 'forget', 'load_skill'])
    expect(defs.every((d) => d.type === 'function')).toBe(true)
  })
  it('limits load_skill to the real skill names, sorted', () => {
    const load = buildToolDefinitions(SKILLS)[2]!
    expect((load.function.parameters as any).properties.name.enum).toEqual(['language-tutor', 'step-by-step'])
  })
  it('is byte-identical every time (it is part of the cached prefix), whatever order the skills come in', () => {
    const a = JSON.stringify(buildToolDefinitions(SKILLS))
    expect(JSON.stringify(buildToolDefinitions([...SKILLS].reverse()))).toBe(a)
    expect(JSON.stringify(buildToolDefinitions(SKILLS))).toBe(a)
  })
})

describe('parseToolArguments', () => {
  it('parses an object, treats an empty string as no arguments, and rejects the rest', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('{"a":')).toBeNull()
    expect(parseToolArguments('[1,2]')).toBeNull()
    expect(parseToolArguments('"text"')).toBeNull()
  })
})

describe('toolStartLabel', () => {
  it('labels each tool for the feed', () => {
    expect(toolStartLabel(call('remember', { fact: 'x' }))).toBe('Remembering…')
    expect(toolStartLabel(call('forget', { id: 1 }))).toBe('Forgetting…')
    expect(toolStartLabel(call('load_skill', { name: 'step-by-step' }))).toBe('Using skill: step-by-step')
    expect(toolStartLabel(call('load_skill', '{bad'))).toBe('Using skill: …')
  })
})

describe('runTool: remember', () => {
  it('saves the fact with the session it was learned in', async () => {
    const out = await runTool(call('remember', { fact: " Sam is  learning Mandarin " }), ctx)
    expect(out).toEqual({ ok: true, result: 'Saved as #1.', label: 'Remembered: Sam is learning Mandarin' })
    const row = await getMemory(ctx.db, 1)
    expect(row?.content).toBe('Sam is learning Mandarin')
    const raw = await ctx.db.prepare('SELECT session_id FROM memories WHERE id = 1').first<{ session_id: string }>()
    expect(raw?.session_id).toBe(ctx.sessionId)
  })
  it('does not save a duplicate', async () => {
    await runTool(call('remember', { fact: 'Sam is learning Mandarin' }), ctx)
    const out = await runTool(call('remember', { fact: 'SAM is learning mandarin' }), ctx)
    expect(out.ok).toBe(true)
    expect(out.result).toMatch(/Already saved as #1/)
    expect(await listMemories(ctx.db)).toHaveLength(1)
  })
  it('refuses a secret, an empty fact and a missing fact, and tells the model why', async () => {
    const secret = await runTool(call('remember', { fact: 'My password is hunter2' }), ctx)
    expect(secret.ok).toBe(false)
    expect(secret.result).toMatch(/looks like a secret/)
    expect((await runTool(call('remember', { fact: '  ' }), ctx)).ok).toBe(false)
    expect((await runTool(call('remember', {}), ctx)).ok).toBe(false)
    expect(await listMemories(ctx.db)).toHaveLength(0)
  })
  it('shortens a long fact in the label only', async () => {
    const fact = 'Sam ' + 'really '.repeat(20) + 'likes tea'
    const out = await runTool(call('remember', { fact }), ctx)
    expect(out.label.length).toBeLessThan(100)
    expect(out.label.endsWith('…')).toBe(true)
    expect((await getMemory(ctx.db, 1))?.content).toBe(fact.replace(/\s+/g, ' '))
  })
})

describe('runTool: forget', () => {
  it('deletes a memory by id (a number, a numeric string or "#3")', async () => {
    for (const f of ['one', 'two', 'three']) await addMemory(ctx.db, { content: f })
    expect((await runTool(call('forget', { id: 1 }), ctx)).label).toBe('Forgot: one')
    expect((await runTool(call('forget', { id: '2' }), ctx)).ok).toBe(true)
    expect((await runTool(call('forget', { id: '#3' }), ctx)).ok).toBe(true)
    expect(await listMemories(ctx.db)).toHaveLength(0)
  })
  it('says so when there is no such memory, and rejects a bad id', async () => {
    const missing = await runTool(call('forget', { id: 42 }), ctx)
    expect(missing).toMatchObject({ ok: false, result: 'Error: there is no memory #42.' })
    for (const id of [0, -1, 1.5, 'abc', null, undefined]) expect((await runTool(call('forget', { id }), ctx)).ok, String(id)).toBe(false)
  })
})

describe('runTool: load_skill', () => {
  it('returns the skill body', async () => {
    const out = await runTool(call('load_skill', { name: 'step-by-step' }), ctx)
    expect(out).toEqual({ ok: true, result: 'STEP BODY', label: 'Using skill: step-by-step' })
  })
  it('lists the available skills for an unknown name', async () => {
    const out = await runTool(call('load_skill', { name: 'nope' }), ctx)
    expect(out.ok).toBe(false)
    expect(out.result).toMatch(/unknown skill "nope".*language-tutor, step-by-step/)
  })
})

describe('runTool: errors never throw', () => {
  it('answers unknown tools and unreadable arguments with an error result', async () => {
    expect((await runTool(call('web_search', { q: 'x' }), ctx)).ok).toBe(false)
    expect((await runTool(call('remember', '{"fact":'), ctx)).result).toMatch(/not valid JSON/)
  })
  it('survives a database failure', async () => {
    const broken = { ...ctx, db: { prepare: () => { throw new Error('boom') }, batch: async () => [] } as unknown as D1Database }
    const out = await runTool(call('remember', { fact: 'a fact' }), broken)
    expect(out.ok).toBe(false)
    expect(out.result).toMatch(/database/)
  })
})
