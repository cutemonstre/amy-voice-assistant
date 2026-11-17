// One conversation turn: audio in, NDJSON out (transcript, text deltas, PCM audio chunks, timings).
//
//   request ──STT──▶ transcript ──LLM (stream + tool loop)──▶ deltas ──sentence splitter──▶ TTS (≤ 2 in flight) ──▶ audio chunks, in order
//
// One AbortController covers the whole turn. It is aborted by `request.signal` and by the response stream's cancel() (client disconnect
// or barge-in), and its signal goes to EVERY upstream fetch, so nothing keeps running (or spending credits) after the client leaves.
//
// D1 is the source of truth for the conversation: the turn loads the last 20 messages of the session, saves the user's message right
// after speech-to-text, and saves the assistant's reply when the turn ends. When the client leaves early (barge-in), the partial reply is
// still saved, marked interrupted. Every write goes through waitUntil, so it finishes even though the response stream is gone.
//
// The model can search the web (its own built-in search, inside the same stream) and call our tools (remember, forget, load_skill).
// Voice-first: the sentence splitter is flushed at the end of every LLM round and after 250 ms of silence, so a filler such as
// "Let me check." is spoken while the search runs. Only the final concatenated reply text is saved, never the tool plumbing.

import { env, waitUntil } from 'cloudflare:workers'
import { isAuthorized } from './auth'
import { bytesToBase64 } from './base64'
import { MEMORIES_IN_PROMPT, isUuid, listMemories, loadHistory, saveAssistantMessage, saveUserMessage, toChatMessages } from './db'
import { isAbortError, json } from './http'
import { runLlm, type ExecuteTool } from './llm'
import { buildSystemBlocks } from './prompts'
import { STALL_MS, createSentenceSplitter, createSpacer } from './sentences'
import { SKILLS } from './skills'
import { resolveSttConfig, transcribe } from './stt'
import { buildToolDefinitions, runTool, toolStartLabel } from './tools'
import { pickTtsModel, streamSpeech, type TtsConfig } from './tts'
import { cleanSources, parsePace, parsePractice, type SourceLink } from '../shared/api-types'

const MAX_AUDIO_BYTES = 8 * 1024 * 1024 // 60 s of 16 kHz mono s16 is 1.9 MB; this is generous
const MAX_TTS_IN_FLIGHT = 2
const MAX_MERGED_CHUNK_BYTES = 32 * 1024

type Stage = 'stt' | 'llm' | 'tts'

type TurnEvent =
  | { t: 'transcript'; text: string; lang?: string }
  | { t: 'delta'; text: string }
  | { t: 'audio'; i: number; pcm: string }
  | { t: 'tool'; id: string; name: string; status: 'start' | 'done' | 'error'; label: string }
  | { t: 'sources'; items: SourceLink[] }
  | { t: 'timing'; stt?: number; llmFirst?: number; ttsFirst?: number }
  | { t: 'warn'; msg: string }
  | { t: 'error'; stage: Stage; msg: string }
  | { t: 'done' }

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A level-triggered wake-up: wait() resolves at the next notify(). Callers re-check their state in a loop. */
function createSignal() {
  let resolve: (() => void) | null = null
  let promise: Promise<void> | null = null
  return {
    wait(): Promise<void> {
      promise ??= new Promise<void>((r) => (resolve = r))
      return promise
    },
    notify() {
      const r = resolve
      resolve = null
      promise = null
      r?.()
    },
  }
}

/** ElevenLabs sends many tiny network chunks. When several are already waiting (a buffered sentence), send them as one event. */
function takeChunk(job: { chunks: Uint8Array[] }): Uint8Array | null {
  if (job.chunks.length <= 1) return job.chunks.shift() ?? null
  let size = 0
  let count = 0
  while (count < job.chunks.length && size + job.chunks[count]!.length <= MAX_MERGED_CHUNK_BYTES) size += job.chunks[count++]!.length
  if (count <= 1) return job.chunks.shift() ?? null
  const merged = new Uint8Array(size)
  let offset = 0
  for (const piece of job.chunks.splice(0, count)) {
    merged.set(piece, offset)
    offset += piece.length
  }
  return merged // every piece has an even length, so the merge stays sample-aligned
}

interface TtsJob {
  index: number
  text: string
  started: boolean
  finished: boolean
  error: unknown
  chunks: Uint8Array[]
}

export async function handleTurn(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const since = () => Date.now() - startedAt

  // ---- the private-link gate: before the body is read and before any upstream call ----
  if (!(await isAuthorized(request, env.APP_TOKEN))) return json({ error: 'locked' }, 401)

  // ---- request validation (plain JSON errors, before any stream exists) ----
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ error: 'Expected multipart/form-data with an "audio" field' }, 400)
  }
  const audio = form.get('audio')
  if (!audio || typeof audio === 'string' || audio.size === 0) return json({ error: 'Missing "audio" (a non-empty audio/wav file)' }, 400)
  if (audio.size > MAX_AUDIO_BYTES) return json({ error: 'Audio is too large' }, 413)
  const wav = new Uint8Array(await audio.arrayBuffer())
  const rawSessionId = form.get('sessionId')
  if (!isUuid(rawSessionId)) return json({ error: 'Missing or invalid "sessionId" (a UUID)' }, 400)
  const sessionId: string = rawSessionId // (a plain string for the closures below; narrowing does not reach function declarations)
  const practice = parsePractice(form.get('practice'))
  const ttsModel = pickTtsModel(form.get('ttsModel'), env.ELEVENLABS_MODEL)
  const pace = parsePace(form.get('pace')) // brisk unless the client asks for natural

  // ---- turn-wide abort ----
  const abort = new AbortController()
  const { signal } = abort
  if (request.signal.aborted) abort.abort()
  else request.signal.addEventListener('abort', () => abort.abort(), { once: true })

  // The conversation so far, loaded while speech-to-text runs. A database problem never stops the turn: it just has no context and a warning.
  let dbProblem: string | null = null
  const historyPromise = loadHistory(env.DB, sessionId).catch((error) => {
    console.error('[turn] could not load the chat history', error)
    dbProblem = "Couldn't load this chat's earlier messages"
    return []
  })

  // The saved memories (newest 50) go into the system prompt. Also loaded while speech-to-text runs; a failure just means none.
  const memoriesPromise = listMemories(env.DB, MEMORIES_IN_PROMPT).catch((error) => {
    console.error('[turn] could not load the memories', error)
    return []
  })

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false

  const emit = (event: TurnEvent) => {
    if (closed || signal.aborted || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
    } catch {
      closed = true // the consumer is gone
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    try {
      controllerRef?.close()
    } catch {
      /* already closed or cancelled */
    }
  }

  /** Run a database write so it completes even if the client has gone. Never rejects; a failure is logged and warned about if anyone is listening. */
  const persist = (label: string, work: () => Promise<void>): Promise<void> => {
    const done = work().catch((error) => {
      console.error(`[turn] could not save ${label}`, error)
      emit({ t: 'warn', msg: "Couldn't save this chat" })
    })
    waitUntil(done)
    return done
  }

  async function run() {
    const timing: { stt?: number; llmFirst?: number; ttsFirst?: number } = {}

    // 1. Speech to text.
    const { config: sttConfig, warn: sttWarn } = resolveSttConfig(env)
    if (!sttConfig.apiKey) {
      emit({ t: 'error', stage: 'stt', msg: 'No OPENROUTER_API_KEY or ELEVENLABS_API_KEY configured' })
      emit({ t: 'done' })
      return
    }
    let transcript: string
    let language: string | undefined
    try {
      ;({ text: transcript, language } = await transcribe(wav, sttConfig, signal))
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return
      emit({ t: 'error', stage: 'stt', msg: errorMessage(error) })
      emit({ t: 'done' })
      return
    }
    timing.stt = since()
    if (signal.aborted) return
    if (!transcript) {
      emit({ t: 'error', stage: 'stt', msg: "Didn't catch that" }) // nothing is saved for an empty transcript
      emit({ t: 'done' })
      return
    }
    emit({ t: 'transcript', text: transcript, ...(language ? { lang: language } : {}) })
    if (sttWarn) emit({ t: 'warn', msg: sttWarn })

    // The user's message is saved now (and the session is created on its first message). It runs alongside the LLM call.
    const userSaved = persist('your message', () => saveUserMessage(env.DB, { sessionId, practice, text: transcript, language }))
    const history = await historyPromise
    if (dbProblem) emit({ t: 'warn', msg: dbProblem })

    // 2. TTS setup. Without an ElevenLabs key the turn is text-only.
    const ttsConfig: TtsConfig | null = env.ELEVENLABS_API_KEY
      ? { apiKey: env.ELEVENLABS_API_KEY, model: ttsModel, voiceId: env.ELEVENLABS_VOICE_ID }
      : null
    if (!ttsConfig) emit({ t: 'warn', msg: 'No ELEVENLABS_API_KEY: text-only replies' })

    // TTS pipeline: jobs are started in order, at most MAX_TTS_IN_FLIGHT at once, but their audio is forwarded strictly in order:
    // the forwarder streams job i live and leaves job i+1's chunks buffered until job i is done.
    const jobs: TtsJob[] = []
    const wake = createSignal()
    const ttsAbort = new AbortController() // child of the turn: cancels in-flight TTS after a TTS failure
    signal.addEventListener('abort', () => {
      ttsAbort.abort()
      wake.notify()
    }, { once: true })
    let inFlight = 0
    let ttsFailed = false
    let noMoreJobs = false

    const pump = async (job: TtsJob) => {
      try {
        for await (const chunk of streamSpeech(job.text, ttsConfig!, pace, ttsAbort.signal)) {
          job.chunks.push(chunk) // forward() drains these in sentence order
          wake.notify()
        }
      } catch (error) {
        if (!ttsAbort.signal.aborted) {
          job.error = error
          ttsFailed = true
        }
      } finally {
        job.finished = true
        inFlight--
        schedule()
        wake.notify()
      }
    }
    const schedule = () => {
      for (const job of jobs) {
        if (ttsFailed || ttsAbort.signal.aborted) return
        if (inFlight >= MAX_TTS_IN_FLIGHT) return
        if (job.started) continue
        job.started = true
        inFlight++
        void pump(job)
      }
    }
    const enqueueSentence = (text: string) => {
      if (!ttsConfig) return
      jobs.push({ index: jobs.length, text, started: false, finished: false, error: null, chunks: [] })
      schedule()
    }

    const forward = async () => {
      let first = true
      for (let i = 0; ; i++) {
        // Wait for job i to exist (or for the LLM to finish with no more sentences).
        while (!jobs[i]) {
          if (signal.aborted || noMoreJobs) return
          await wake.wait()
        }
        const job = jobs[i]!
        for (;;) {
          if (signal.aborted) return
          const chunk = takeChunk(job)
          if (chunk) {
            if (first) {
              first = false
              timing.ttsFirst = since()
            }
            emit({ t: 'audio', i: job.index, pcm: bytesToBase64(chunk) })
            continue
          }
          if (job.finished) break
          await wake.wait()
        }
        if (job.error) {
          emit({ t: 'error', stage: 'tts', msg: errorMessage(job.error) })
          ttsAbort.abort() // text-only from here on: cancel any sibling still in flight
          return
        }
      }
    }
    const forwarding = forward()

    // 3. LLM, streamed with its tool loop: forward deltas, feed the splitter, hand finished sentences to TTS.
    const splitter = createSentenceSplitter()
    const spacer = createSpacer()
    let assistantText = '' // the full reply, [tags] and {{notes}} included: this is what is saved and shown
    const citations: Array<{ title: string; url: string }> = []
    let assistantSaved = false
    const saveAssistant = (interrupted: boolean): Promise<void> => {
      const text = assistantText.trim()
      if (assistantSaved || !text) return Promise.resolve()
      assistantSaved = true
      return persist('the reply', async () => {
        await userSaved // the user's row first, so the ids keep the conversation order
        await saveAssistantMessage(env.DB, {
          sessionId,
          text,
          interrupted,
          ttsModel: ttsConfig && timing.ttsFirst !== undefined ? ttsModel : null,
          timing,
          sources: cleanSources(citations),
        })
      })
    }

    // The stall flush: when the model goes quiet right after a sentence end (it is searching), speak that sentence now.
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = null
    }
    const armStall = () => {
      clearStall()
      stallTimer = setTimeout(() => {
        stallTimer = null
        const sentence = splitter.stall()
        if (sentence) {
          spacer.boundary() // whatever comes next may arrive with no leading space
          enqueueSentence(sentence)
        }
      }, STALL_MS)
    }

    // Web search is the model's own: the stream shows it only as a pause, then citations. One feed line for it per turn.
    let search: 'none' | 'started' | 'done' = 'none'
    let searchRan = false
    const searchLine = (status: 'start' | 'done' | 'error') =>
      emit({
        t: 'tool',
        id: 'web_search',
        name: 'web_search',
        status,
        label: status === 'start' ? 'Searching the web…' : status === 'done' ? 'Searched the web' : "The search didn't find anything",
      })

    const executeTool: ExecuteTool = (call) => {
      const work = runTool(call, { db: env.DB, sessionId, skills: SKILLS })
      waitUntil(work.then(() => undefined, () => undefined)) // a tool's database write finishes even if the client leaves
      return work
    }

    const messages = toChatMessages([...history, { role: 'user', content: transcript }])
    const system = buildSystemBlocks({ skills: SKILLS, practice, lang: language, memories: await memoriesPromise, now: new Date() })
    let llmFailed = false
    const toolStarted = new Map<string, number>()
    console.debug(`[turn] stt done at ${timing.stt} ms; the model request starts at ${since()} ms`)
    try {
      for await (const ev of runLlm({
        system,
        messages,
        tools: buildToolDefinitions(SKILLS),
        executeTool,
        cfg: { apiKey: env.OPENROUTER_API_KEY, model: env.LLM_MODEL, effort: env.LLM_EFFORT },
        signal,
      })) {
        switch (ev.t) {
          case 'text': {
            const text = spacer.fix(ev.text)
            if (timing.llmFirst === undefined) timing.llmFirst = since()
            assistantText += text
            emit({ t: 'delta', text })
            for (const sentence of splitter.push(text)) enqueueSentence(sentence)
            armStall()
            break
          }
          case 'pause':
            if (search === 'none') {
              search = 'started'
              searchLine('start')
            }
            break
          case 'source':
            searchRan = true
            spacer.boundary(true) // a citation marks where the text resumes after the search
            citations.push({ title: ev.title, url: ev.url })
            if (search !== 'done') {
              if (search === 'none') searchLine('start')
              search = 'done'
              searchLine('done')
            }
            break
          case 'usage':
            if (ev.usage.webSearchRequests > 0) searchRan = true
            break
          case 'round_end': {
            clearStall()
            spacer.boundary()
            const tail = splitter.flush() // speak what this round said before the tools (or the end) take over
            if (tail) enqueueSentence(tail)
            break
          }
          case 'tool_start':
            toolStarted.set(ev.call.id, since())
            console.debug(`[turn] tool ${ev.call.name} starts at ${since()} ms`)
            emit({ t: 'tool', id: ev.call.id, name: ev.call.name, status: 'start', label: toolStartLabel(ev.call) })
            break
          case 'tool_end':
            console.debug(`[turn] tool ${ev.call.name} took ${since() - (toolStarted.get(ev.call.id) ?? since())} ms (${ev.outcome.ok ? 'ok' : 'error'})`)
            emit({ t: 'tool', id: ev.call.id, name: ev.call.name, status: ev.outcome.ok ? 'done' : 'error', label: ev.outcome.label })
            break
        }
      }
    } catch (error) {
      clearStall()
      if (signal.aborted || isAbortError(error)) {
        void saveAssistant(true) // barge-in or disconnect: keep what was written so far
        return
      }
      llmFailed = true
      emit({ t: 'error', stage: 'llm', msg: errorMessage(error) })
    }
    clearStall()
    if (!llmFailed) {
      const tail = splitter.flush()
      if (tail) enqueueSentence(tail)
    }
    // The pause looked like a search but nothing confirmed it, or a search ran without any citations.
    if (search === 'started' && !searchRan) searchLine('error')
    else if (search !== 'done' && searchRan) {
      if (search === 'none') searchLine('start')
      searchLine('done')
    }
    const sources = cleanSources(citations)
    if (sources.length) emit({ t: 'sources', items: sources })

    // 4. Let TTS drain, then report.
    noMoreJobs = true
    wake.notify()
    await forwarding
    if (signal.aborted) {
      void saveAssistant(true) // the listener left while the voice was still being sent
      return
    }
    emit({ t: 'timing', ...timing })
    await saveAssistant(llmFailed) // a reply cut short by an LLM error is saved as interrupted too
    emit({ t: 'done' })
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      run()
        .catch((error) => {
          if (!signal.aborted && !isAbortError(error)) {
            console.error('[turn] unexpected failure', error)
            emit({ t: 'error', stage: 'llm', msg: 'Internal error' })
            emit({ t: 'done' })
          }
        })
        .finally(() => {
          abort.abort() // release everything still open; harmless after a normal finish
          close()
        })
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' },
  })
}
