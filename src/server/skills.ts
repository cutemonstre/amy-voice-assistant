// Skills: markdown files in /skills (frontmatter `name` and `description`, then the instructions), bundled into the Worker at build time.
// The index (name: description) goes in the system prompt; the load_skill tool returns a skill's body. Parsing is pure (skills.test.ts).

export interface Skill {
  name: string
  description: string
  body: string
}

/**
 * Parse one skill file. Frontmatter is a `---` block of `key: value` lines (values may be quoted); the rest is the body.
 * Returns null when `name` or `description` is missing, or the body is empty: a broken skill is skipped, not half-loaded.
 */
export function parseSkill(raw: string): Skill | null {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(raw)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2]!.trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    fields[m[1]!.toLowerCase()] = value
  }
  const name = fields.name?.trim()
  const description = fields.description?.trim()
  const body = match[2]!.trim()
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !description || !body) return null
  return { name, description, body }
}

/** Parse every file, drop broken ones and duplicates (first wins), sort by name so the system prompt is the same on every turn. */
export function collectSkills(files: Record<string, string>): Skill[] {
  const byName = new Map<string, Skill>()
  for (const path of Object.keys(files).sort()) {
    const skill = parseSkill(files[path]!)
    if (skill && !byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The skills bundled at build time. */
const FILES = import.meta.glob('/skills/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
export const SKILLS: Skill[] = collectSkills(FILES)
