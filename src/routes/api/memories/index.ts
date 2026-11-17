import { createFileRoute } from '@tanstack/react-router'
import { handleListMemories } from '@/server/memories'

export const Route = createFileRoute('/api/memories/')({
  server: { handlers: { GET: ({ request }) => handleListMemories(request) } },
})
