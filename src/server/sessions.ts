// The session endpoints behind the ☰ drawer. Same private-link gate as /api/turn; every query is parameterised (see db.ts).
//   GET    /api/sessions        the latest 50 sessions
//   GET    /api/sessions/:id    one session with its messages
//   DELETE /api/sessions/:id    delete a session and its messages

import { env } from 'cloudflare:workers'
import { isAuthorized } from './auth'
import { deleteSession, getSession, isUuid, listSessions } from './db'
import { json } from './http'

const locked = () => json({ error: 'locked' }, 401)

async function guarded(request: Request, work: () => Promise<Response>): Promise<Response> {
  if (!(await isAuthorized(request, env.APP_TOKEN))) return locked()
  try {
    return await work()
  } catch (error) {
    console.error('[sessions] database error', error)
    return json({ error: 'Database error' }, 500)
  }
}

export function handleListSessions(request: Request): Promise<Response> {
  return guarded(request, async () => json({ sessions: await listSessions(env.DB) }))
}

export function handleGetSession(request: Request, id: string): Promise<Response> {
  return guarded(request, async () => {
    if (!isUuid(id)) return json({ error: 'Invalid session id' }, 400)
    const detail = await getSession(env.DB, id)
    return detail ? json(detail) : json({ error: 'Not found' }, 404)
  })
}

export function handleDeleteSession(request: Request, id: string): Promise<Response> {
  return guarded(request, async () => {
    if (!isUuid(id)) return json({ error: 'Invalid session id' }, 400)
    return (await deleteSession(env.DB, id)) ? json({ ok: true }) : json({ error: 'Not found' }, 404)
  })
}
