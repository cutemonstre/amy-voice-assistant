/** Shared helpers for the upstream HTTP calls. */

export class UpstreamError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
  }
}

/** A JSON response. `no-store` because every body here is private and live. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')

/** Resolve after `ms`, or reject with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Read at most `limit` characters of a response body (for error messages). Never throws. */
export async function readSnippet(response: Response, limit = 300): Promise<string> {
  try {
    return (await response.text()).slice(0, limit)
  } catch {
    return ''
  }
}

/** fetch with ONE retry on HTTP 429 or 5xx after `delayMs`. `build` runs per attempt so a body is never reused. */
export async function fetchRetryOnce(
  url: string,
  build: () => RequestInit,
  signal: AbortSignal,
  delayMs = 500,
): Promise<Response> {
  const first = await fetch(url, { ...build(), signal })
  if (first.status !== 429 && first.status < 500) return first
  await first.body?.cancel().catch(() => {})
  await sleep(delayMs, signal)
  return fetch(url, { ...build(), signal })
}
