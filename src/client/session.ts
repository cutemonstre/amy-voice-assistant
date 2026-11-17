// The id of the chat in progress. It lives in localStorage so a reload resumes it. A new chat is just a new UUID: the session row is
// created by the server on its first turn, so an empty chat is never saved.

const KEY = 'voice-chat.session'

/** A UUID v4. crypto.randomUUID needs a secure context (HTTPS or localhost), so there is a fallback for plain-http LAN testing. */
export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function loadSessionId(): string | null {
  try {
    const stored = localStorage.getItem(KEY)
    return stored && /^[0-9a-f-]{36}$/i.test(stored) ? stored : null
  } catch {
    return null
  }
}

export function saveSessionId(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* the chat still works; it just will not resume after a reload */
  }
}
