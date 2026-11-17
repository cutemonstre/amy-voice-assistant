// Bindings and variables for the Worker (see wrangler.jsonc). Hand-written on purpose: the generated `wrangler types` file pulls in the
// full workerd runtime types, which clash with the DOM types the client code needs.
// OPENROUTER_API_KEY, ELEVENLABS_API_KEY and APP_TOKEN are secrets: locally they live in .dev.vars (see .dev.vars.example), in production in `wrangler secret put`.

// The slice of the D1 API this app uses (the full types would come from @cloudflare/workers-types, which clashes with the DOM types).
interface D1Meta {
  changes?: number
  last_row_id?: number
}
interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: D1Meta
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
  first<T = unknown>(): Promise<T | null>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
  /** Runs the statements in order inside one transaction. */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

declare namespace Cloudflare {
  interface Env {
    LLM_MODEL: string
    LLM_EFFORT: string
    STT_PROVIDER: string
    STT_MODEL_ELEVENLABS: string
    STT_MODEL_OPENROUTER: string
    ELEVENLABS_MODEL: string
    ELEVENLABS_VOICE_ID: string
    /** D1 database with the chat sessions (migrations/0001_init.sql). */
    DB: D1Database
    OPENROUTER_API_KEY: string
    ELEVENLABS_API_KEY?: string
    /** Optional secret. When set, /api/turn requires a matching `x-app-token` header (the private link). Unset locally. */
    APP_TOKEN?: string
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env
  /** Keep the invocation alive until the promise settles (it must not reject). Used to save a chat message after the client has gone. */
  export function waitUntil(promise: Promise<unknown>): void
}
