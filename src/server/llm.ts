// The language model through OpenRouter: one streamed request per "round", and a small tool loop on top (decision 20).
//
//   round 1: stream the reply. If the model asks for our function tools (remember, forget, load_skill), run them, append the results,
//            and stream again: at most 3 rounds. The last round runs with tool_choice "none", so it must answer.
//   Web search is NOT one of our tools: it is the model's own built-in search (the `web` plugin with engine "native"), which runs
//   server-side inside the same stream. The stream then goes quiet for a few seconds and the citations arrive as `annotations`.
//
// Text goes out as it arrives. One AbortSignal covers every request, and every tool run is checked against it.

import { UpstreamError, readSnippet } from './http'
import type { SystemBlock } from './prompts'

/** A plain chat turn, as stored in D1. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A function call the model made. `arguments` is the raw JSON text it streamed. */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** What running a tool gave back: `result` goes to the model, `label` goes to the feed. */
export interface ToolOutcome {
  ok: boolean
  result: string
  label: string
}

export type ExecuteTool = (call: ToolCall) => Promise<ToolOutcome>

/** The messages of the conversation inside the loop (the plain turns plus the tool calls and results of this turn). */
export type ApiMessage =
  | ChatMessage
  | {
      role: 'assistant'
      content: string | null
      tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface LlmConfig {
  apiKey: string
  model: string
  effort: string
}

export const MAX_ROUNDS = 3
/** Keepalive comments in a row, after text, that mean "the server is busy with something" (see the `pause` event). */
export const PAUSE_KEEPALIVES = 3

// ---- reading the stream ----------------------------------------------------------------------------------------------------------

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  /** USD, as OpenRouter bills it. */
  cost: number
  webSearchRequests: number
  /** Tokens the model spent thinking before it answered (they cost time, and they are not streamed to us as text). */
  reasoningTokens: number
}

export interface Citation {
  url: string
  title: string
}

export type SseItem =
  | { kind: 'skip' }
  | { kind: 'keepalive' } // ": OPENROUTER PROCESSING"
  | { kind: 'done' } // data: [DONE]
  | {
      kind: 'chunk'
      text: string
      toolCalls: ToolCallDelta[]
      citations: Citation[]
      finish: string | null
      usage: Usage | null
      /** How many characters of `delta.reasoning` this chunk carried (the reasoning itself is ignored). */
      reasoningChars: number
    }

interface RawChunk {
  provider?: string
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
      annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    server_tool_use_details?: { web_search_requests?: number }
  }
  error?: { message?: string; code?: number | string }
}

/**
 * Parse one SSE line. Blank lines and non-data lines are `skip`; `: OPENROUTER PROCESSING` comments are `keepalive`; `data: [DONE]` is
 * `done`. A data line gives the text delta, the tool-call fragments, the url_citation annotations, the finish reason and (on the last
 * chunk) the usage. `delta.reasoning` is ignored. An error chunk throws. `meta` receives the provider that served the stream.
 */
export function parseSseLine(rawLine: string, meta?: { provider?: string }): SseItem {
  const line = rawLine.trim()
  if (!line) return { kind: 'skip' }
  if (line.startsWith(':')) return { kind: 'keepalive' }
  if (!line.startsWith('data:')) return { kind: 'skip' }
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') return { kind: 'done' }
  let chunk: RawChunk
  try {
    chunk = JSON.parse(payload) as RawChunk
  } catch {
    return { kind: 'skip' } // a malformed or partial line is not worth failing the turn for
  }
  if (meta && typeof chunk.provider === 'string') meta.provider = chunk.provider
  if (chunk.error) throw new UpstreamError(`OpenRouter error: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 300)}`)

  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  const toolCalls: ToolCallDelta[] = (delta?.tool_calls ?? []).map((t, i) => ({
    index: typeof t.index === 'number' ? t.index : i,
    id: t.id || undefined,
    name: t.function?.name || undefined,
    arguments: t.function?.arguments || undefined,
  }))
  const citations: Citation[] = []
  for (const a of delta?.annotations ?? []) {
    if (a?.type === 'url_citation' && typeof a.url_citation?.url === 'string') {
      citations.push({ url: a.url_citation.url, title: typeof a.url_citation.title === 'string' ? a.url_citation.title : '' })
    }
  }
  const u = chunk.usage
  const usage: Usage | null = u
    ? {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens ?? 0,
        cost: u.cost ?? 0,
        webSearchRequests: u.server_tool_use_details?.web_search_requests ?? 0,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      }
    : null
  return {
    kind: 'chunk',
    text: typeof delta?.content === 'string' ? delta.content : '',
    toolCalls,
    citations,
    finish: choice?.finish_reason ?? null,
    usage,
    reasoningChars: typeof delta?.reasoning === 'string' ? delta.reasoning.length : 0,
  }
}

/** Collects function-call fragments (`delta.tool_calls`) by index: the id and name arrive first, the arguments in pieces. */
export class ToolCallAccumulator {
  private readonly parts = new Map<number, { id: string; name: string; args: string }>()

  push(deltas: ReadonlyArray<ToolCallDelta>) {
    for (const d of deltas) {
      let part = this.parts.get(d.index)
      if (!part) {
        part = { id: '', name: '', args: '' }
        this.parts.set(d.index, part)
      }
      if (d.id && !part.id) part.id = d.id
      if (d.name && !part.name) part.name = d.name
      if (d.arguments) part.args += d.arguments
    }
  }

  /** The finished calls in index order. A fragment that never got a name is dropped; a missing id is made up. */
  calls(): ToolCall[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, p]) => p.name)
      .map(([index, p]) => ({ id: p.id || `call_${index}`, name: p.name, arguments: p.args }))
  }
}

// ---- one round -------------------------------------------------------------------------------------------------------------------

export type LlmEvent =
  | { t: 'text'; text: string }
  /** A url_citation arrived: the native web search ran. */
  | { t: 'source'; url: string; title: string }
  /** The stream went quiet right after text (keepalives only): a server-side tool such as web search is probably running. */
  | { t: 'pause' }
  /** The end of an LLM round: the caller flushes its sentence splitter here. */
  | { t: 'round_end'; round: number }
  | { t: 'tool_start'; call: ToolCall }
  | { t: 'tool_end'; call: ToolCall; outcome: ToolOutcome }
  | { t: 'usage'; round: number; usage: Usage }

interface RoundResult {
  text: string
  toolCalls: ToolCall[]
  finish: string | null
}

interface RoundRequest {
  system: SystemBlock[]
  messages: ApiMessage[]
  tools: ToolDefinition[]
  /** The last round: the model may not call tools. */
  final: boolean
}

async function* streamRound(req: RoundRequest, cfg: LlmConfig, round: number, signal: AbortSignal): AsyncGenerator<LlmEvent, RoundResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    stream: true,
    reasoning: { effort: cfg.effort },
    // Straight to Anthropic: first token ~1.1 s, against 1.6-1.9 s (2.4-4.2 s live) on OpenRouter's default route.
    // allow_fallbacks keeps the turn working when that route is down.
    provider: { order: ['anthropic'], allow_fallbacks: true },
    usage: { include: true },
    // Claude's own web search. Sonnet decides when to search; the search runs inside this same stream.
    plugins: [{ id: 'web', engine: 'native', max_results: 3 }],
    max_tokens: 400,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
  }
  if (req.tools.length) {
    body.tools = req.tools
    // The tools stay in the request even on the last round: they are the first part of the cached prefix, so dropping them would turn a
    // cheap cache hit into a full-price miss (measured: $0.0013 against $0.0079). tool_choice "none" is what stops the model using them.
    if (req.final) body.tool_choice = 'none'
  }

  const tStart = Date.now()
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'voice-chat' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new UpstreamError(`OpenRouter chat HTTP ${response.status}: ${await readSnippet(response)}`, response.status)
  if (!response.body) throw new UpstreamError('OpenRouter chat returned no body')

  const tHeaders = Date.now() - tStart
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const accumulator = new ToolCallAccumulator()
  const meta: { provider?: string } = {}
  let buffer = ''
  let text = ''
  let finish: string | null = null
  let sawText = false
  let keepalives = 0
  let paused = false
  let finished = false
  // For the one-line debug summary of the round (where the time went, which provider, what the cache did).
  let tFirst = -1 // first visible output: text or the start of a tool call
  let tFirstReasoning = -1
  let reasoningChars = 0
  let usageSeen: Usage | null = null

  /** Turn one parsed line into events. */
  function* handle(line: string): Generator<LlmEvent> {
    const item = parseSseLine(line, meta)
    if (item.kind === 'done') {
      finished = true
      return
    }
    if (item.kind === 'keepalive') {
      if (sawText && !paused && ++keepalives >= PAUSE_KEEPALIVES) {
        paused = true
        yield { t: 'pause' }
      }
      return
    }
    if (item.kind !== 'chunk') return
    if (item.reasoningChars) {
      if (tFirstReasoning < 0) tFirstReasoning = Date.now() - tStart
      reasoningChars += item.reasoningChars
    }
    if ((item.text || item.toolCalls.length) && tFirst < 0) tFirst = Date.now() - tStart
    if (item.toolCalls.length) accumulator.push(item.toolCalls)
    for (const c of item.citations) yield { t: 'source', url: c.url, title: c.title }
    if (item.text) {
      sawText = true
      keepalives = 0
      paused = false
      text += item.text
      yield { t: 'text', text: item.text }
    }
    if (item.finish && !finish) finish = item.finish
    if (item.usage) {
      usageSeen = item.usage
      yield { t: 'usage', round, usage: item.usage }
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        yield* handle(line)
      }
    }
    if (!finished && buffer.trim()) yield* handle(buffer + decoder.decode())
  } finally {
    await reader.cancel().catch(() => {})
    console.debug(roundSummary(round, req.final, meta.provider, { tHeaders, tFirst, tFirstReasoning, tEnd: Date.now() - tStart }, reasoningChars, usageSeen))
  }
  return { text, toolCalls: accumulator.calls(), finish }
}

/** One line per round for the debug log: provider, timing (ms from sending the request), cache and reasoning. */
export function roundSummary(
  round: number,
  final: boolean,
  provider: string | undefined,
  ms: { tHeaders: number; tFirst: number; tFirstReasoning: number; tEnd: number },
  reasoningChars: number,
  usage: Usage | null,
): string {
  const t = (v: number) => (v < 0 ? '-' : `${v}`)
  const parts = [
    `[llm] round ${round}${final ? ' (final)' : ''}`,
    `provider ${provider ?? '?'}`,
    `headers ${t(ms.tHeaders)} ms, first output ${t(ms.tFirst)} ms, end ${t(ms.tEnd)} ms`,
  ]
  if (reasoningChars) parts.push(`reasoning stream ${reasoningChars} chars from ${t(ms.tFirstReasoning)} ms`)
  if (usage) {
    parts.push(
      `prompt ${usage.promptTokens} (cached ${usage.cachedTokens}, written ${usage.cacheWriteTokens})`,
      `completion ${usage.completionTokens} (reasoning ${usage.reasoningTokens})`,
      `searches ${usage.webSearchRequests}`,
      `cost $${usage.cost.toFixed(5)}`,
    )
  }
  return parts.join(', ')
}

// ---- the loop --------------------------------------------------------------------------------------------------------------------

export interface RunLlmOptions {
  system: SystemBlock[]
  /** The conversation so far, ending with the user's message. */
  messages: ChatMessage[]
  tools: ToolDefinition[]
  executeTool: ExecuteTool
  cfg: LlmConfig
  signal: AbortSignal
  maxRounds?: number
}

/**
 * Run the model, and its function tools, to a final answer. Yields text as it streams, `round_end` after every round, and the tool
 * start and end events around each tool run. Throws UpstreamError on failure and AbortError when `signal` aborts.
 */
export async function* runLlm(opts: RunLlmOptions): AsyncGenerator<LlmEvent> {
  const { system, tools, executeTool, cfg, signal } = opts
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  const messages: ApiMessage[] = [...opts.messages]

  for (let round = 1; round <= maxRounds; round++) {
    const final = round === maxRounds
    const result = yield* streamRound({ system, messages, tools, final }, cfg, round, signal)
    yield { t: 'round_end', round }
    if (final || result.toolCalls.length === 0) return

    // Run the tools it asked for, then go round again with the results.
    messages.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    })
    for (const call of result.toolCalls) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield { t: 'tool_start', call }
      const outcome = await executeTool(call)
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield { t: 'tool_end', call, outcome }
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result })
    }
  }
}
