// The memory endpoints behind the drawer's Memories tab. Same private-link gate as /api/turn; every query is parameterised (see db.ts).
//   GET    /api/memories        the newest memories first
//   DELETE /api/memories/:id    forget one

import { env } from 'cloudflare:workers'
import { isAuthorized } from './auth'
import { MEMORIES_IN_LIST, deleteMemory, listMemories } from './db'
import { json } from './http'

async function guarded(request: Request, work: () => Promise<Response>): Promise<Response> {
  if (!(await isAuthorized(request, env.APP_TOKEN))) return json({ error: 'locked' }, 401)
  try {
    return await work()
  } catch (error) {
    console.error('[memories] database error', error)
    return json({ error: 'Database error' }, 500)
  }
}

export function handleListMemories(request: Request): Promise<Response> {
  return guarded(request, async () => json({ memories: await listMemories(env.DB, MEMORIES_IN_LIST) }))
}

export function handleDeleteMemory(request: Request, rawId: string): Promise<Response> {
  return guarded(request, async () => {
    if (!/^[1-9]\d{0,15}$/.test(rawId)) return json({ error: 'Invalid memory id' }, 400)
    return (await deleteMemory(env.DB, Number(rawId))) ? json({ ok: true }) : json({ error: 'Not found' }, 404)
  })
}
