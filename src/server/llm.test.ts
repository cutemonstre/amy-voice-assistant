import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ROUNDS, ToolCallAccumulator, parseSseLine, roundSummary, runLlm, type LlmEvent, type ToolOutcome, type Usage } from './llm'
import { buildSystemBlocks } from './prompts'

// ---- parseSseLine ------------------------------------------------------------------------------------------------------------------

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}`
const delta = (d: unknown, extra: Record<string, unknown> = {}) => chunk({ choices: [{ delta: d, finish_reason: null }], ...extra })

describe('parseSseLine', () => {
  it('extracts delta.content', () => {
    expect(parseSseLine(delta({ content: 'Hi' }))).toMatchObject({ kind: 'chunk', text: 'Hi', toolCalls: [], citations: [], finish: null })
  })
  it('skips blanks and non-data lines, and reports keepalive comments', () => {
    expect(parseSseLine('')).toEqual({ kind: 'skip' })
    expect(parseSseLine('event: ping')).toEqual({ kind: 'skip' })
    expect(parseSseLine(': OPENROUTER PROCESSING')).toEqual({ kind: 'keepalive' })
  })
  it('ignores reasoning deltas and null content', () => {
    expect(parseSseLine(delta({ reasoning: 'hmm', content: null }))).toMatchObject({ kind: 'chunk', text: '' })
    expect(parseSseLine(delta({ reasoning: 'hmm' }))).toMatchObject({ kind: 'chunk', text: '' })
  })
  it('returns done on [DONE]', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ kind: 'done' })
  })
  it('throws on an error chunk', () => {
    expect(() => parseSseLine(chunk({ error: { message: 'rate limited', code: 429 } }))).toThrow(/rate limited/)
  })
  it('tolerates malformed JSON and CRLF', () => {
    expect(parseSseLine('data: {oops')).toEqual({ kind: 'skip' })
    expect(parseSseLine(delta({ content: 'ok' }) + '\r')).toMatchObject({ text: 'ok' })
  })
  it('reports the provider that served the stream', () => {
    const meta: { provider?: string } = {}
    parseSseLine(delta({ content: 'Hi' }, { provider: 'Anthropic' }), meta)
    expect(meta.provider).toBe('Anthropic')
  })
  it('reads tool-call fragments', () => {
    const item = parseSseLine(delta({ tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'remember', arguments: '' } }] }))
    expect(item).toMatchObject({ toolCalls: [{ index: 0, id: 'toolu_1', name: 'remember' }] })
  })
  it('reads url_citation annotations and ignores other kinds', () => {
    const item = parseSseLine(
      delta({
        annotations: [
          { type: 'url_citation', url_citation: { url: 'https://a.example/x', title: 'A', content: 'long snippet', start_index: 0, end_index: 0 } },
          { type: 'something_else', foo: 1 },
        ],
      }),
    )
    expect(item).toMatchObject({ citations: [{ url: 'https://a.example/x', title: 'A' }] })
  })
  it('reads the reasoning tokens from the usage, and counts the characters of a reasoning delta without keeping them', () => {
    const usage = parseSseLine(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 270, completion_tokens_details: { reasoning_tokens: 180 } } }))
    expect(usage).toMatchObject({ usage: { completionTokens: 270, reasoningTokens: 180 } })
    expect(parseSseLine(delta({ reasoning: 'hmm, let me think' }))).toMatchObject({ text: '', reasoningChars: 17 })
    expect(parseSseLine(delta({ content: 'Hi' }))).toMatchObject({ reasoningChars: 0 })
  })
  it('reads the usage: cached tokens, cache writes, cost, web searches', () => {
    const item = parseSseLine(
      chunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 3097,
          completion_tokens: 11,
          cost: 0.0009364,
          prompt_tokens_details: { cached_tokens: 2982, cache_write_tokens: 0 },
          server_tool_use_details: { web_search_requests: 1 },
        },
      }),
    )
    expect(item).toMatchObject({
      finish: 'stop',
      usage: { promptTokens: 3097, completionTokens: 11, cachedTokens: 2982, cacheWriteTokens: 0, cost: 0.0009364, webSearchRequests: 1 },
    })
  })
})

describe('roundSummary (the one-line debug log of a round)', () => {
  const usage: Usage = {
    promptTokens: 4403, completionTokens: 270, cachedTokens: 4035, cacheWriteTokens: 0, cost: 0.00424, webSearchRequests: 0, reasoningTokens: 180,
  }
  it('says where the time went, the provider, the cache and any reasoning', () => {
    const line = roundSummary(2, false, 'Anthropic', { tHeaders: 1207, tFirst: 4703, tFirstReasoning: 4696, tEnd: 4721 }, 275, usage)
    expect(line).toBe(
      '[llm] round 2, provider Anthropic, headers 1207 ms, first output 4703 ms, end 4721 ms, reasoning stream 275 chars from 4696 ms, ' +
        'prompt 4403 (cached 4035, written 0), completion 270 (reasoning 180), searches 0, cost $0.00424',
    )
  })
  it('marks the final round, and copes with a missing provider, no output and no usage', () => {
    const line = roundSummary(3, true, undefined, { tHeaders: 900, tFirst: -1, tFirstReasoning: -1, tEnd: 950 }, 0, null)
    expect(line).toBe('[llm] round 3 (final), provider ?, headers 900 ms, first output - ms, end 950 ms')
  })
})

// ---- ToolCallAccumulator -----------------------------------------------------------------------------------------------------------

describe('ToolCallAccumulator', () => {
  it('assembles a call whose arguments arrive in pieces (the shape OpenRouter streams)', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, id: 'toolu_01', name: 'remember' }])
    acc.push([{ index: 0 }]) // an empty fragment
    acc.push([{ index: 0, arguments: '{"fact": "User' }])
    acc.push([{ index: 0, arguments: ' is learning Mandarin' }])
    acc.push([{ index: 0, arguments: '."' }])
    acc.push([{ index: 0, arguments: '}' }])
    expect(acc.calls()).toEqual([{ id: 'toolu_01', name: 'remember', arguments: '{"fact": "User is learning Mandarin."}' }])
  })

  it('keeps several calls apart by index, in index order', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 1, id: 'b', name: 'forget' }])
    acc.push([{ index: 0, id: 'a', name: 'remember' }])
    acc.push([{ index: 1, arguments: '{"id":' }])
    acc.push([{ index: 0, arguments: '{"fact":"x"}' }])
    acc.push([{ index: 1, arguments: '3}' }])
    expect(acc.calls()).toEqual([
      { id: 'a', name: 'remember', arguments: '{"fact":"x"}' },
      { id: 'b', name: 'forget', arguments: '{"id":3}' },
    ])
  })

  it('does not let a repeated id or name overwrite the first', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, id: 'a', name: 'remember', arguments: '{}' }])
    acc.push([{ index: 0, id: 'zzz', name: 'forget' }])
    expect(acc.calls()).toEqual([{ id: 'a', name: 'remember', arguments: '{}' }])
  })

  it('drops a fragment that never got a name and makes up a missing id', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, arguments: '{"x":1}' }])
    acc.push([{ index: 1, name: 'load_skill', arguments: '{}' }])
    expect(acc.calls()).toEqual([{ id: 'call_1', name: 'load_skill', arguments: '{}' }])
  })

  it('is empty when there were no tool calls', () => {
    expect(new ToolCallAccumulator().calls()).toEqual([])
  })
})

// ---- runLlm, against a stubbed fetch -----------------------------------------------------------------------------------------------

const encoder = new TextEncoder()

/** A fetch Response whose body is the given SSE lines, with an optional gap between them. */
function sse(lines: string[], gapMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const text = (t: string) => delta({ content: t })
const finish = (reason: string) => chunk({ choices: [{ delta: {}, finish_reason: reason }] })
const DONE = 'data: [DONE]'

const SYSTEM = buildSystemBlocks({ skills: [{ name: 's', description: 'd' }], practice: 'off', now: new Date('2026-10-05T06:07:00Z') })
const TOOLS = [{ type: 'function' as const, function: { name: 'remember', description: 'd', parameters: { type: 'object' } } }]
const CFG = { apiKey: 'test-key', model: 'anthropic/claude-sonnet-5.5', effort: 'low' }
const OK: ToolOutcome = { ok: true, result: 'Saved as #1.', label: 'Remembered: x' }

type Body = Record<string, any>
let bodies: Body[] = []

function stubFetch(...responses: Array<Response | (() => Response)>) {
  bodies = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      const next = responses[Math.min(i++, responses.length - 1)]!
      return typeof next === 'function' ? next() : next
    }),
  )
}

async function collect(options: Partial<Parameters<typeof runLlm>[0]> = {}): Promise<LlmEvent[]> {
  const events: LlmEvent[] = []
  for await (const ev of runLlm({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    executeTool: async () => OK,
    cfg: CFG,
    signal: new AbortController().signal,
    ...options,
  })) {
    events.push(ev)
  }
  return events
}

const kinds = (events: LlmEvent[]) => events.map((e) => e.t)

afterEach(() => vi.unstubAllGlobals())

describe('runLlm: the request', () => {
  it('asks for a streamed reply with the native web search plugin, Anthropic routing, usage, tools and a cached static system block', async () => {
    stubFetch(sse([text('Hello'), finish('stop'), DONE]))
    await collect()
    const body = bodies[0]!
    expect(body).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      stream: true,
      reasoning: { effort: 'low' },
      provider: { order: ['anthropic'], allow_fallbacks: true },
      usage: { include: true },
      plugins: [{ id: 'web', engine: 'native', max_results: 3 }],
      max_tokens: 400,
    })
    expect(body.tools).toEqual(TOOLS)
    expect(body.tool_choice).toBeUndefined() // round 1 may call tools
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
    expect(body.messages[0].content[1].cache_control).toBeUndefined()
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('sends the same static block and tools bytes on every request (so the prompt cache hits)', async () => {
    stubFetch(sse([text('a'), DONE]))
    await collect()
    const second = { ...SYSTEM[1]!, text: 'Current date and time: later. [#1] something else' }
    stubFetch(sse([text('b'), DONE]))
    await collect({ system: [SYSTEM[0]!, second] })
    // (bodies was reset by the second stubFetch: compare against a fresh build of the first)
    expect(JSON.stringify(bodies[0]!.messages[0].content[0])).toBe(JSON.stringify(SYSTEM[0]))
    expect(JSON.stringify(bodies[0]!.tools)).toBe(JSON.stringify(TOOLS))
  })
})

describe('runLlm: one round', () => {
  it('streams the text, then ends the round', async () => {
    stubFetch(sse([text('Hello'), text(' there'), finish('stop'), DONE]))
    const events = await collect()
    expect(events).toEqual([
      { t: 'text', text: 'Hello' },
      { t: 'text', text: ' there' },
      { t: 'round_end', round: 1 },
    ])
  })

  it('reports usage', async () => {
    stubFetch(sse([text('Hi'), chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 } } }), DONE]))
    const events = await collect()
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ usage: { promptTokens: 100, cachedTokens: 90 } })
  })

  it('turns url_citation annotations into source events', async () => {
    stubFetch(sse([
      text('Let me check.'),
      delta({ annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.example/', title: 'A' } }] }),
      text('Max won.'),
      finish('stop'),
      DONE,
    ]))
    const events = await collect()
    expect(kinds(events)).toEqual(['text', 'source', 'text', 'round_end'])
    expect(events[1]).toEqual({ t: 'source', url: 'https://a.example/', title: 'A' })
  })

  it('signals a pause when keepalives follow text (a server-side search running), once', async () => {
    const keepalive = ': OPENROUTER PROCESSING'
    stubFetch(sse([text('Let me check.'), keepalive, keepalive, keepalive, keepalive, keepalive, text('Max won.'), finish('stop'), DONE]))
    const events = await collect()
    expect(kinds(events)).toEqual(['text', 'pause', 'text', 'round_end'])
  })

  it('does not signal a pause for keepalives before any text, or for fewer than three', async () => {
    const keepalive = ': OPENROUTER PROCESSING'
    stubFetch(sse([keepalive, keepalive, keepalive, text('Hi'), keepalive, keepalive, text(' there'), finish('stop'), DONE]))
    expect(kinds(await collect())).toEqual(['text', 'text', 'round_end'])
  })

  it('throws on an HTTP error with the status and a snippet of the body', async () => {
    stubFetch(new Response('{"error":{"message":"no credits"}}', { status: 402 }))
    await expect(collect()).rejects.toThrow(/HTTP 402.*no credits/)
  })

  it('throws on an error chunk in the stream', async () => {
    stubFetch(sse([text('Hi'), chunk({ error: { message: 'upstream blew up' } })]))
    await expect(collect()).rejects.toThrow(/upstream blew up/)
  })
})

const toolRound = (id: string, name: string, args: string[]) => [
  delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
  ...args.map((a) => delta({ tool_calls: [{ index: 0, function: { arguments: a } }] })),
  finish('tool_calls'),
  DONE,
]

describe('runLlm: the tool loop', () => {
  it('runs the tool the model asked for, appends the result, and streams again', async () => {
    stubFetch(
      sse(toolRound('toolu_1', 'remember', ['{"fact": "User', ' is learning Mandarin."}'])),
      sse([text("Got it, I'll remember that."), finish('stop'), DONE]),
    )
    const executed: unknown[] = []
    const events = await collect({
      executeTool: async (call) => {
        executed.push(call)
        return OK
      },
    })

    expect(executed).toEqual([{ id: 'toolu_1', name: 'remember', arguments: '{"fact": "User is learning Mandarin."}' }])
    expect(kinds(events)).toEqual(['round_end', 'tool_start', 'tool_end', 'text', 'round_end'])
    expect(events[2]).toMatchObject({ t: 'tool_end', outcome: OK })
    // the second request carries the assistant's tool call and the tool result
    expect(bodies).toHaveLength(2)
    const messages = bodies[1]!.messages.slice(1)
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'remember', arguments: '{"fact": "User is learning Mandarin."}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Saved as #1.' },
    ])
    expect(bodies[1]!.tool_choice).toBeUndefined() // round 2 of 3 may still call tools
  })

  it('keeps the text a round said before its tool call, in the assistant message and as events', async () => {
    stubFetch(sse([text('One moment.'), ...toolRound('t', 'load_skill', ['{"name":"step-by-step"}'])]), sse([text('Step one.'), finish('stop'), DONE]))
    const events = await collect()
    expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text)).toEqual(['One moment.', 'Step one.'])
    expect(bodies[1]!.messages[2]).toMatchObject({ role: 'assistant', content: 'One moment.' })
  })

  it('runs several tool calls of one round in order', async () => {
    stubFetch(
      sse([
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'remember', arguments: '{"fact":"x"}' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'forget', arguments: '{"id":2}' } }] }),
        finish('tool_calls'),
        DONE,
      ]),
      sse([text('Done.'), finish('stop'), DONE]),
    )
    const names: string[] = []
    await collect({ executeTool: async (c) => (names.push(c.name), OK) })
    expect(names).toEqual(['remember', 'forget'])
    expect(bodies[1]!.messages.filter((m: Body) => m.role === 'tool').map((m: Body) => m.tool_call_id)).toEqual(['a', 'b'])
  })

  it(`stops after ${MAX_ROUNDS} rounds: the last round has tool_choice "none", keeps the tools (cache), and its tool calls are not run`, async () => {
    stubFetch(sse(toolRound('t1', 'remember', ['{"fact":"1"}'])), sse(toolRound('t2', 'remember', ['{"fact":"2"}'])), sse(toolRound('t3', 'remember', ['{"fact":"3"}'])))
    let runs = 0
    const events = await collect({ executeTool: async () => (runs++, OK) })
    expect(bodies).toHaveLength(MAX_ROUNDS)
    expect(runs).toBe(MAX_ROUNDS - 1)
    expect(bodies.map((b) => b.tool_choice)).toEqual([undefined, undefined, 'none'])
    expect(bodies.every((b) => b.tools?.length === TOOLS.length)).toBe(true)
    expect(events.filter((e) => e.t === 'round_end')).toHaveLength(MAX_ROUNDS)
  })

  it('passes a failed tool run to the model as the result', async () => {
    stubFetch(sse(toolRound('t', 'forget', ['{"id": 99}'])), sse([text('There is no memory 99.'), finish('stop'), DONE]))
    const bad: ToolOutcome = { ok: false, result: 'Error: there is no memory #99.', label: 'No memory #99' }
    const events = await collect({ executeTool: async () => bad })
    expect(events.find((e) => e.t === 'tool_end')).toMatchObject({ outcome: bad })
    expect(bodies[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't', content: 'Error: there is no memory #99.' })
  })
})

describe('runLlm: abort', () => {
  it('stops with an AbortError when the signal aborts mid-stream, and runs no further round', async () => {
    const abort = new AbortController()
    bodies = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text('Let me check.') + '\n'))
            // then silence, like a search pause: the stream ends only when the request is aborted
            init.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
          },
        })
        return new Response(body, { status: 200 })
      }),
    )
    const seen: string[] = []
    const run = (async () => {
      for await (const ev of runLlm({ system: SYSTEM, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, executeTool: async () => OK, cfg: CFG, signal: abort.signal })) {
        seen.push(ev.t)
        if (ev.t === 'text') setTimeout(() => abort.abort(), 20)
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toEqual(['text'])
    expect(bodies).toHaveLength(1)
  })

  it('does not run a tool once the signal is aborted', async () => {
    const abort = new AbortController()
    stubFetch(sse(toolRound('t', 'remember', ['{"fact":"x"}'])))
    let ran = false
    const run = (async () => {
      for await (const ev of runLlm({ system: SYSTEM, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, executeTool: async () => ((ran = true), OK), cfg: CFG, signal: abort.signal })) {
        if (ev.t === 'round_end') abort.abort()
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(ran).toBe(false)
  })
})
