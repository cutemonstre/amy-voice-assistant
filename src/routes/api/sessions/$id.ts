import { createFileRoute } from '@tanstack/react-router'
import { handleDeleteSession, handleGetSession } from '@/server/sessions'

export const Route = createFileRoute('/api/sessions/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleGetSession(request, params.id),
      DELETE: ({ request, params }) => handleDeleteSession(request, params.id),
    },
  },
})
