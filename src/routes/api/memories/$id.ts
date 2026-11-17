import { createFileRoute } from '@tanstack/react-router'
import { handleDeleteMemory } from '@/server/memories'

export const Route = createFileRoute('/api/memories/$id')({
  server: { handlers: { DELETE: ({ request, params }) => handleDeleteMemory(request, params.id) } },
})
