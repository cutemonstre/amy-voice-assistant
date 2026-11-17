// Small pure helpers for the UI (unit tested in format.test.ts).

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

// ---- reply text: [delivery tags] and {{display-only notes}} ------------------------------------------------------------------------

export interface TextPart {
  kind: 'text' | 'tag' | 'note'
  text: string
}

const MARKUP = /\[([^\]\n]*)\]|\{\{([\s\S]*?)\}\}/g
// A tag or note that is still arriving while the reply streams: "[lau", "{{nǐ hǎo}", or a lone "{" that may become "{{".
const UNFINISHED = /(\[[^\]\n]*|\{\{(?:[^}]|\}(?!\}))*\}?|\{)$/

/**
 * Split reply text into plain text, Eleven v4 delivery tags ("[laughs]" becomes {kind: 'tag', text: 'laughs'}) and display-only notes
 * ("{{nǐ hǎo}}" becomes {kind: 'note', text: 'nǐ hǎo'}), so the feed can show them as muted italics and small muted text instead of raw
 * brackets. Markup that is still streaming in is left out until it closes. The raw text (brackets and all) is what stays saved.
 */
export function parseSpoken(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(MARKUP)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) })
    const tag = match[1]?.trim()
    const note = match[2]?.trim()
    if (tag) parts.push({ kind: 'tag', text: tag })
    else if (note) parts.push({ kind: 'note', text: note })
    last = match.index + match[0].length
  }
  const rest = text.slice(last).replace(UNFINISHED, '')
  if (rest) parts.push({ kind: 'text', text: rest })
  return parts
}

// ---- languages ---------------------------------------------------------------------------------------------------------------------

// Scribe reports ISO 639-3 codes. The feed shows the short, familiar form.
const SHORT_LANG: Record<string, string> = {
  eng: 'en', cmn: 'zh', zho: 'zh', yue: 'yue', jpn: 'ja', kor: 'ko', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
  ara: 'ar', hin: 'hi', ind: 'id', msa: 'ms', zsm: 'ms', tha: 'th', vie: 'vi', nld: 'nl', tur: 'tr', pol: 'pl', ukr: 'uk', tam: 'ta',
  ben: 'bn', swe: 'sv',
}

export function shortLang(code: string | null | undefined): string | null {
  const key = code?.trim().toLowerCase()
  if (!key) return null
  return SHORT_LANG[key] ?? key
}

// ---- the meta line under a reply ---------------------------------------------------------------------------------------------------

export function ttsModelLabel(model: string | null | undefined): string | null {
  if (model === 'eleven_v4_turbo') return 'Turbo'
  if (model === 'eleven_v4') return 'v4'
  return null
}

export interface MetaInput {
  /** Measured in the browser: button release to the first audio chunk starting to play. */
  firstSoundMs?: number
  /** The server's timings (all that is known for a reloaded message). */
  ttsFirstMs?: number | null
  llmFirstMs?: number | null
  lang?: string | null
  ttsModel?: string | null
  interrupted?: boolean
}

/** "3.5 s · zh · Turbo", with "· interrupted" when cut off. The time is the first sound if known, else the server's first audio, else its first token. */
export function formatMeta(meta: MetaInput): string {
  const parts: string[] = []
  const ms = meta.firstSoundMs ?? meta.ttsFirstMs ?? meta.llmFirstMs
  if (ms !== undefined && ms !== null) parts.push(formatMs(ms))
  const lang = shortLang(meta.lang)
  if (lang) parts.push(lang)
  const model = ttsModelLabel(meta.ttsModel)
  if (model) parts.push(model)
  if (meta.interrupted) parts.push('interrupted')
  return parts.join(' · ')
}

// ---- the drawer --------------------------------------------------------------------------------------------------------------------

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", then a short date. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} d ago`
  return new Date(timestamp).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}
