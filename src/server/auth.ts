// The private-link gate. The endpoint spends API credits, so a deployed Worker with APP_TOKEN set only answers requests that carry
// the same token in the `x-app-token` header. With APP_TOKEN unset (local development) there is no gate.

export const TOKEN_HEADER = 'x-app-token'

const encoder = new TextEncoder()

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/** Constant-time string equality: both sides are hashed to 32 bytes first, so neither the content nor the length leaks through timing. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!
  return diff === 0
}

/** True when no token is configured, or when the request's `x-app-token` header matches it. */
export async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return true
  const given = request.headers.get(TOKEN_HEADER)
  if (!given) return false
  return safeEqual(given, expected)
}
