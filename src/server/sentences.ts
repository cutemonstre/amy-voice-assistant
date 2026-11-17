// Incremental sentence splitter for a streaming LLM reply. Pure and dependency free (unit tested in sentences.test.ts).
//
//   const splitter = createSentenceSplitter()
//   for each text delta:  splitter.push(delta)  -> finished sentences (possibly none)
//   at the end:           splitter.flush()      -> the unfinished tail, or null
//
// A sentence ends at . ! ? or … (plus any closing quotes/brackets) followed by whitespace, or at a newline. A terminator at the very
// end of the buffer is held back until the next character arrives, because "3." may still become "3.5". Output is stripped of
// markdown symbols, whitespace-collapsed and trimmed; pieces with no letter or digit are dropped (nothing worth sending to TTS).
//
// Display-only notes written {{like this}} (pinyin, mostly) are removed before anything else: they are shown in the feed but never
// spoken. They may arrive split across streamed deltas ("{{nǐ" then " hǎo}}"), so a small state machine drops them as the text flows
// through; an unfinished note at the end of the reply is dropped too.
//
// Eleven v4 performs inline delivery tags such as [laughs] or [whispers]. Square brackets are NOT stripped, and tags stay with their
// sentence. A piece that is only tags ("[laughs]") is never sent alone: mid-reply it is merged into the next sentence, and at the end
// of the reply it is merged into the previous one (so a sentence is held back while what follows it might still be a lone tag).

export interface SentenceSplitter {
  push(delta: string): string[]
  flush(): string | null
  /**
   * Call when no delta has arrived for a while (the model is waiting on a server-side tool such as web search). If the buffer ends in a
   * sentence terminator, the sentence is released now, so it can be spoken during the wait ("Let me check."). Otherwise null, and
   * everything stays buffered. A "." that may belong to a number or an abbreviation ("version 3." "Dr.") is not released.
   */
  stall(): string | null
}

/** How long the stream may stay quiet, after a sentence end, before the sentence is released anyway (decision 28). */
export const STALL_MS = 250

/** Once the buffer holds more than this many characters without a boundary, force a split. */
export const MAX_SENTENCE_CHARS = 220

const TERMINATORS = new Set(['.', '!', '?', '…'])
// Full-width CJK sentence ends. Unlike ".", they are never part of a number or an abbreviation and they are not followed by a space,
// so they end a sentence on their own.
const CJK_TERMINATORS = new Set(['。', '！', '？', '｡'])
// Closers that may trail a terminator: quotes, brackets and the markdown emphasis marks (so "**bold.** Next" still splits).
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '*', '_', '`', '」', '』', '）', '】', '》'])

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'prof', 'sr', 'jr', 'mt', 'approx',
])

const isWhitespace = (ch: string) => /\s/.test(ch)

/** True when the "." at `dot` belongs to an abbreviation, an initial or a list number rather than ending a sentence. */
function isAbbreviation(buf: string, dot: number): boolean {
  let start = dot
  while (start > 0 && !isWhitespace(buf[start - 1]!) && !'([{"“'.includes(buf[start - 1]!)) start--
  const token = buf.slice(start, dot)
  if (!token) return false
  if (ABBREVIATIONS.has(token.toLowerCase())) return true
  // A single-letter initial ("J. K. Rowling", "Plan B."), except the pronoun "I" ("so do I.").
  if (/^[A-Za-z]$/.test(token)) return token !== 'I'
  // Dotted initialisms: "U.S", "a.m", "p.m".
  if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(token)) return true
  // A list marker at the start of the buffer ("1. Apples"): not a sentence of its own.
  if (/^\d+$/.test(token) && buf.slice(0, start).trim() === '') return true
  return false
}

const TAG = /\[[^\]]*\]/g

/** True for a piece that holds tags and nothing speakable besides them, e.g. "[laughs]" or "[sighs] [softly]." */
function isTagsOnly(text: string): boolean {
  return text.includes('[') && !/[\p{L}\p{N}]/u.test(text.replace(TAG, ''))
}

/**
 * Could the text after a sentence boundary still turn out to be a lone tag piece, once more text arrives?
 * True when nothing follows yet, when it starts with a tag that is unfinished, or when finished tags run to the very end of the buffer.
 * False when words (or anything that decides the piece already) follow the tags.
 */
function mightBeLoneTag(rest: string): boolean {
  let t = rest.trimStart()
  if (t === '') return true // nothing after the boundary yet: undecided (costs at most one token of delay)
  if (!t.startsWith('[')) return false
  while (t.startsWith('[')) {
    const close = t.indexOf(']')
    if (close === -1) return true // the tag itself is still arriving
    t = t.slice(close + 1).replace(/^[ \t]+/, '')
  }
  return t === ''
}

interface Boundary {
  /** Exclusive end of the sentence text. */
  end: number
  /** Where the next sentence starts (skips a consumed newline). */
  next: number
}

/** The first sentence boundary in `buf`, or null if none can be decided yet. */
function findBoundary(buf: string): Boundary | null {
  const n = buf.length
  for (let i = 0; i < n; i++) {
    const ch = buf[i]!
    if (ch === '\n') return { end: i, next: i + 1 }
    const cjk = CJK_TERMINATORS.has(ch)
    if (!cjk && !TERMINATORS.has(ch)) continue

    let run = i + 1
    while (run < n && (TERMINATORS.has(buf[run]!) || CJK_TERMINATORS.has(buf[run]!))) run++
    let k = run
    while (k < n && CLOSERS.has(buf[k]!)) k++
    if (cjk) return { end: k, next: k } // decided at once: no space follows a full-width stop
    if (k >= n) return null // the terminator is at the end of the buffer: wait for the next character

    if (isWhitespace(buf[k]!)) {
      const singleDot = ch === '.' && run === i + 1
      if (!(singleDot && isAbbreviation(buf, i))) return { end: k, next: k }
    }
    i = run - 1 // not a boundary ("3.5", "e.g", "Mr."): continue after the terminator run
  }
  return null
}

/** Strip markdown symbols (not square brackets: they carry Eleven v4 tags), collapse whitespace, trim. Null when nothing speakable is left. */
function clean(text: string): string | null {
  const out = text
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,!?;:…。，！？、])/g, '$1') // the gap a removed {{note}} leaves before punctuation
    .trim()
  return /[\p{L}\p{N}]/u.test(out) ? out : null
}

/** Where to force a split of an over-long buffer: after the last comma in its second half, else at the last space. */
function forcedCut(buf: string): number {
  const head = buf.slice(0, MAX_SENTENCE_CHARS)
  const comma = Math.max(head.lastIndexOf(','), head.lastIndexOf('，'), head.lastIndexOf('、'))
  if (comma >= MAX_SENTENCE_CHARS / 2) return comma + 1
  const space = head.lastIndexOf(' ')
  if (space > 0) return space
  return MAX_SENTENCE_CHARS
}

export interface NoteStripper {
  /** Feed a streamed piece of text; get back the same text without any {{note}} (a note may start in one piece and end in another). */
  push(text: string): string
  /** End of the stream: returns text that was only being held back. An unfinished note is dropped. */
  flush(): string
}

/** Streaming remover of display-only {{notes}}. Single braces are ordinary text. */
export function createNoteStripper(): NoteStripper {
  let inNote = false
  let held = '' // outside a note: a "{" that may start "{{". Inside a note: a "}" that may end "}}".

  return {
    push(text: string): string {
      let out = ''
      for (const ch of text) {
        if (inNote) {
          if (ch === '}') {
            if (held === '}') {
              inNote = false
              held = ''
            } else held = '}'
          } else held = ''
        } else if (ch === '{') {
          if (held === '{') {
            inNote = true
            held = ''
          } else held = '{'
        } else {
          out += held + ch
          held = ''
        }
      }
      return out
    },
    flush(): string {
      const rest = inNote ? '' : held
      inNote = false
      held = ''
      return rest
    },
  }
}

/** True when the text, ignoring trailing whitespace and closers, ends at a sentence terminator that is certainly a sentence end. */
function endsAtSentenceEnd(text: string): boolean {
  let end = text.length
  while (end > 0 && isWhitespace(text[end - 1]!)) end--
  while (end > 0 && CLOSERS.has(text[end - 1]!)) end--
  if (end === 0) return false
  const last = text[end - 1]!
  if (!TERMINATORS.has(last) && !CJK_TERMINATORS.has(last)) return false
  if (last !== '.') return true
  if (end >= 2 && TERMINATORS.has(text[end - 2]!)) return true // "..." is an ellipsis
  if (end >= 2 && /\d/.test(text[end - 2]!)) return false // "version 3." may still become "3.5"
  return !isAbbreviation(text, end - 1)
}

export interface Spacer {
  /** The delta, with one space put in front of it when the text resumes straight after a marked boundary with no whitespace between. */
  fix(delta: string): string
  /**
   * Mark that the text may resume after a gap: a stall flush, the end of an LLM round (hard: a space is added wherever both sides lack
   * one), or a web citation (soft: only after a sentence end, so a citation can never split a word).
   */
  boundary(soft?: boolean): void
}

/**
 * Fixes "Let me check.Max Verstappen…": after a pause or a tool round the model can resume with no leading space. The same fixed text must
 * go to the voice, the screen and the database, so it is applied to the raw stream before anything else sees it.
 */
export function createSpacer(): Spacer {
  let tail = ''
  let pending: 'none' | 'soft' | 'hard' = 'none'
  return {
    boundary(soft = false) {
      if (pending !== 'hard') pending = soft ? 'soft' : 'hard'
    },
    fix(delta: string): string {
      if (!delta) return delta
      let out = delta
      const last = tail[tail.length - 1]
      if (pending !== 'none' && last && !isWhitespace(last) && !isWhitespace(delta[0]!)) {
        const cjk = CJK_TERMINATORS.has(last) || /^[\u3000-\u9fff\uff00-\uffef]/.test(delta)
        const afterSentenceEnd = /[.!?…]["'”’)\]}*_`]*$/.test(tail)
        if (!cjk && (pending === 'hard' || afterSentenceEnd)) out = ' ' + delta
      }
      pending = 'none'
      tail = (tail + out).slice(-8)
      return out
    },
  }
}

export function createSentenceSplitter(): SentenceSplitter {
  const notes = createNoteStripper()
  let buf = ''
  let carry = '' // lone tags waiting to be merged into the next sentence

  /** Route one finished piece: lone tags are carried forward, anything else goes out with the carried tags in front. */
  const emitPiece = (text: string | null, out: string[]) => {
    if (!text) return
    if (isTagsOnly(text)) {
      carry = carry ? `${carry} ${text}` : text
      return
    }
    out.push(carry ? `${carry} ${text}` : text)
    carry = ''
  }

  return {
    push(delta: string): string[] {
      buf += notes.push(delta)
      const out: string[] = []
      for (;;) {
        const boundary = findBoundary(buf)
        // Hold a sentence back while the text after it might still become a lone trailing tag (see mightBeLoneTag).
        const deferred = boundary !== null && mightBeLoneTag(buf.slice(boundary.next))
        if (boundary && !deferred && boundary.end <= MAX_SENTENCE_CHARS) {
          const piece = clean(buf.slice(0, boundary.end))
          buf = buf.slice(boundary.next)
          emitPiece(piece, out)
          continue
        }
        if (buf.length > MAX_SENTENCE_CHARS) {
          const cut = forcedCut(buf)
          const piece = clean(buf.slice(0, cut))
          buf = buf.slice(cut)
          emitPiece(piece, out)
          continue
        }
        break
      }
      return out
    },

    stall(): string | null {
      if (!endsAtSentenceEnd(buf)) return null
      const out: string[] = []
      const piece = clean(buf)
      buf = ''
      emitPiece(piece, out)
      return out[0] ?? null
    },

    flush(): string | null {
      buf += notes.flush()
      // The buffer may hold a held-back sentence plus its trailing lone tag: one string, so the tag rides with the sentence.
      const rest = clean(buf)
      buf = ''
      const pending = carry
      carry = ''
      if (!rest) return pending || null
      return pending ? `${pending} ${rest}` : rest
    },
  }
}
