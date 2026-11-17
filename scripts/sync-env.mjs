// Copies OPENROUTER_API_KEY and ELEVENLABS_API_KEY from ~/.env into .dev.vars (gitignored) so `wrangler`/vite can inject them
// into the Worker. Only those two keys are taken from ~/.env. Key values are never printed.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEYS = ['OPENROUTER_API_KEY', 'ELEVENLABS_API_KEY']
const source = join(homedir(), '.env')
const target = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars')

let text = ''
try {
  text = readFileSync(source, 'utf8')
} catch {
  console.log(`[sync-env] ${source} not found: .dev.vars not updated`)
  process.exit(0)
}

const found = {}
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
  if (!match || !KEYS.includes(match[1])) continue
  let value = match[2].trim()
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    value = value.slice(1, -1)
  }
  if (value) found[match[1]] = value
}

// Lines already in .dev.vars for other variables (for example APP_TOKEN, to try the private-link gate locally) are kept as they are.
let kept = []
try {
  kept = readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !KEYS.some((k) => line.trim().startsWith(`${k}=`)))
} catch {
  /* no .dev.vars yet */
}

const out = KEYS.filter((k) => found[k]).map((k) => `${k}=${found[k]}`)
writeFileSync(target, [...out, ...kept].join('\n') + '\n', { mode: 0o600 })

if (!found.OPENROUTER_API_KEY) console.log('[sync-env] OPENROUTER_API_KEY missing in ~/.env: the app cannot transcribe or reply')
if (!found.ELEVENLABS_API_KEY) console.log('[sync-env] ELEVENLABS_API_KEY missing in ~/.env: replies will be text-only')
console.log(`[sync-env] wrote .dev.vars (${out.length} of ${KEYS.length} keys)`)
