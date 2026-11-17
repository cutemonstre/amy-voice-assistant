import { createFileRoute } from '@tanstack/react-router'
import { handleListSessions } from '@/server/sessions'

export const Route = createFileRoute('/api/sessions/')({
  server: { handlers: { GET: ({ request }) => handleListSessions(request) } },
})
