import { createFileRoute } from '@tanstack/react-router'
import { handleTurn } from '@/server/turn'

// A server route (not createServerFn): the reply is a streaming NDJSON Response. See src/server/turn.ts for the wire protocol.
export const Route = createFileRoute('/api/turn')({
  server: {
    handlers: {
      POST: ({ request }) => handleTurn(request),
    },
  },
})
