// Our own function tools: remember(fact), forget(id), load_skill(name). (Web search is the model's built-in search, not a tool of ours.)
// Definitions are a pure function of the bundled skills, so the `tools` array is byte-identical on every request (it is part of the
// cached prompt prefix). Running a tool never throws: a bad call comes back as an error result the model can recover from.

import { addMemory, deleteMemory, getMemory } from './db'
import type { ToolCall, ToolDefinition, ToolOutcome } from './llm'
import { checkFact } from './memory'
import type { Skill } from './skills'

export type ToolName = 'remember' | 'forget' | 'load_skill'

export function buildToolDefinitions(skills: ReadonlyArray<Pick<Skill, 'name'>>): ToolDefinition[] {
  const names = skills.map((s) => s.name).sort()
  return [
    {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Save one short fact about the user so it is still known in future chats: a durable preference, an ongoing goal, a name, a long-term project. One short sentence about the user. Never a secret.',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: 'One short sentence, e.g. "Sam is learning Mandarin".' } },
          required: ['fact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: 'Delete a saved memory. Use the number from the [#id] list of saved memories.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'integer', description: 'The memory id, without the # sign.' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'load_skill',
        description: 'Load the full instructions of a skill listed in the system prompt, then follow them.',
        parameters: {
          type: 'object',
          properties: names.length
            ? { name: { type: 'string', enum: names, description: 'The skill name.' } }
            : { name: { type: 'string', description: 'The skill name.' } },
          required: ['name'],
        },
      },
    },
  ]
}

/** The model streams arguments as text. A call with unreadable arguments gets null (and an error result). */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {} // a tool with no arguments streams an empty string
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const shorten = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The label for the feed while a tool call is running. */
export function toolStartLabel(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  const args = parseToolArguments(call.arguments) ?? {}
  switch (call.name) {
    case 'remember':
      return 'Remembering…'
    case 'forget':
      return 'Forgetting…'
    case 'load_skill':
      return `Using skill: ${typeof args.name === 'string' ? args.name : '…'}`
    default:
      return `Using ${call.name}…`
  }
}

export interface ToolContext {
  db: D1Database
  sessionId: string
  skills: ReadonlyArray<Skill>
}

const fail = (message: string, label: string): ToolOutcome => ({ ok: false, result: `Error: ${message}`, label })

/** Run one tool call. Never throws. */
export async function runTool(call: Pick<ToolCall, 'name' | 'arguments'>, ctx: ToolContext): Promise<ToolOutcome> {
  const args = parseToolArguments(call.arguments)
  if (!args) return fail('the arguments were not valid JSON', `${call.name} failed`)

  try {
    switch (call.name) {
      case 'remember': {
        const check = checkFact(args.fact)
        if (!check.ok) return fail(check.reason, `Didn't remember: ${check.reason.startsWith('it looks like a secret') ? 'looks like a secret' : check.reason}`)
        const { id, existing } = await addMemory(ctx.db, { content: check.fact, sessionId: ctx.sessionId })
        return existing
          ? { ok: true, result: `Already saved as #${id}. Nothing changed.`, label: `Already remembered: ${shorten(check.fact)}` }
          : { ok: true, result: `Saved as #${id}.`, label: `Remembered: ${shorten(check.fact)}` }
      }
      case 'forget': {
        const id = typeof args.id === 'number' ? args.id : typeof args.id === 'string' ? Number(args.id.replace(/^#/, '')) : NaN
        if (!Number.isInteger(id) || id <= 0) return fail('id must be a positive integer', 'Forget failed')
        const memory = await getMemory(ctx.db, id)
        if (!memory) return { ok: false, result: `Error: there is no memory #${id}.`, label: `No memory #${id}` }
        await deleteMemory(ctx.db, id)
        return { ok: true, result: `Forgot #${id}.`, label: `Forgot: ${shorten(memory.content)}` }
      }
      case 'load_skill': {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        const skill = ctx.skills.find((s) => s.name === name)
        if (!skill) return fail(`unknown skill "${name}". Available: ${ctx.skills.map((s) => s.name).sort().join(', ') || 'none'}`, `No skill: ${name || '?'}`)
        return { ok: true, result: skill.body, label: `Using skill: ${skill.name}` }
      }
      default:
        return fail(`unknown tool "${call.name}"`, `Unknown tool: ${call.name}`)
    }
  } catch (error) {
    console.error(`[tools] ${call.name} failed`, error)
    return fail('the database is not available right now', `${call.name} failed`)
  }
}
