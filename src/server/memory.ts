// Pure helpers for the memory tool: validating a fact before it is saved.

import { MEMORY_MAX_CHARS } from './db'

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/i, // API-key style prefixes
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b[A-Za-z0-9+/_=-]{32,}\b/, // one long unbroken token
  /(?:\d[ -]?){13,19}/, // something shaped like a card number
  /\b(?:password|passcode|passphrase|api[ _-]?key|secret key|private key|access token|auth token|pin code)\b\s*(?:is|=|:)/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number shape
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

export type FactCheck = { ok: true; fact: string } | { ok: false; reason: string }

/** Clean up and check what the model wants to remember: one short line, not empty, not a secret. */
export function checkFact(raw: unknown): FactCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'fact must be a string' }
  const fact = raw.replace(/\s+/g, ' ').trim()
  if (!fact) return { ok: false, reason: 'fact is empty' }
  if (fact.length > MEMORY_MAX_CHARS) return { ok: false, reason: `fact is too long (max ${MEMORY_MAX_CHARS} characters): say it shorter` }
  if (looksLikeSecret(fact)) return { ok: false, reason: 'it looks like a secret (a key, password, token or card number), so it was not saved' }
  return { ok: true, fact }
}

/** "[#12] Sam is learning Mandarin" lines for the system prompt. */
export function memoryLines(memories: ReadonlyArray<{ id: number; content: string }>): string[] {
  return memories.map((m) => `[#${m.id}] ${m.content.replace(/\s+/g, ' ').trim()}`)
}
