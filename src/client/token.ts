// The private-link token. Open https://<site>/?token=<token> once: it is saved in this browser, removed from the address bar, and sent as
// the x-app-token header on every turn. localStorage can be unavailable (private window, blocked data), so every access is guarded;
// without it the token still works for the current page view (kept in memory).

const STORAGE_KEY = 'voice-chat.token'
let memoryToken: string | null = null

function storageGet(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function storageSet(value: string) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* in-memory only */
  }
}

/** If the URL carries ?token=<token>: save it and strip it from the address bar (other query parameters stay). Safe to call repeatedly. */
export function captureTokenFromUrl() {
  try {
    const url = new URL(window.location.href)
    const k = url.searchParams.get('token')
    if (k === null) return
    if (k) {
      memoryToken = k
      storageSet(k)
    }
    url.searchParams.delete('token')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch {
    /* an odd URL is not worth breaking the page for */
  }
}

export function getToken(): string | null {
  return memoryToken ?? storageGet()
}
