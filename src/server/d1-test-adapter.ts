// A thin D1-shaped adapter over node:sqlite, so the tests can run the real SQL and the real migrations without Cloudflare.
// Test support only: nothing in the Worker imports this file.

import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

type Params = Array<string | number | null>

export function d1From(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, params: Params = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values as Params),
    run: async () => {
      const r = sqlite.prepare(sql).run(...params)
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } } as never
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...params).map((row) => ({ ...row })), success: true, meta: {} }) as never,
    first: async () => {
      const row = sqlite.prepare(sql).get(...params)
      return (row ? { ...row } : null) as never
    },
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec('BEGIN')
      try {
        const out = []
        for (const s of statements) out.push(await s.run())
        sqlite.exec('COMMIT')
        return out as never
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/** An in-memory database with every file of /migrations applied, in order. */
export function migratedDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  const dir = new URL('../../migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  return d1From(sqlite)
}
