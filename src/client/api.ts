// The session API from the browser: the list for the drawer, one session's messages, delete. Every call carries the private-link token.

import type { MemoryRecord, SessionDetail, SessionSummary } from '../shared/api-types'
import { getToken } from './token'

/** The server answered 401: the private link has not been opened in this browser (or its token is wrong). */
export class LockedError extends Error {
  constructor() {
    super('locked')
    this.name = 'LockedError'
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { 'x-app-token': token } : {}
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, headers: { ...authHeaders(), ...init.headers } })
  if (response.status === 401) throw new LockedError()
  return response
}

async function failure(response: Response): Promise<Error> {
  let detail = ''
  try {
    detail = ((await response.json()) as { error?: string }).error ?? ''
  } catch {
    /* not JSON */
  }
  return new Error(detail || `Request failed (HTTP ${response.status})`)
}

export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const response = await request('/api/sessions', { signal })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { sessions: SessionSummary[] }).sessions
}

/** One session with its messages, or null if it does not exist (a new chat has no row until its first turn). */
export async function loadSession(id: string, signal?: AbortSignal): Promise<SessionDetail | null> {
  const response = await request(`/api/sessions/${encodeURIComponent(id)}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw await failure(response)
  return (await response.json()) as SessionDetail
}

export async function removeSession(id: string): Promise<void> {
  const response = await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw await failure(response)
}

/** The saved memories, newest first. */
export async function listMemories(signal?: AbortSignal): Promise<MemoryRecord[]> {
  const response = await request('/api/memories', { signal })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { memories: MemoryRecord[] }).memories
}

export async function removeMemory(id: number): Promise<void> {
  const response = await request(`/api/memories/${id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw await failure(response)
}
