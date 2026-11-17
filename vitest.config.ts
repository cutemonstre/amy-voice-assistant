import { defineConfig } from 'vitest/config'

// Unit tests are pure TypeScript (no Worker runtime), so they run in plain Node, separate from vite.config.ts.
export default defineConfig({
  // db.test.ts runs the real SQL on node:sqlite; --no-warnings hides its "experimental" notice.
  test: { include: ['src/**/*.test.ts'], environment: 'node', execArgv: ['--no-warnings'] },
})
