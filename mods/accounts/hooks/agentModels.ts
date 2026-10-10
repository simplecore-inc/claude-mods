/**
 * Each Claude subagent's model and effort in Claude Code's agent list, as
 * ` · Opus 5.5 (high)` after its task. The agent list shows the spawn's
 * description, so the label is worked out before the subagent starts.
 *
 * Adapted from the agent-models plugin of alex2481kobe/claude-mods
 * (https://github.com/alex2481kobe/claude-mods), Apache License 2.0; see
 * THIRD_PARTY_NOTICES.md in this plugin.
 */

import { claudeDirectory } from './credentials'
import type { Io } from './io'
import { displayModel } from './status'

/** An agent file's frontmatter, as far as the label needs it. */
export type AgentDefinition = { name: string; model?: string; effort?: string }

/** What the engine says of a spawn, and the effort of the parent's latest request. */
export type AgentSpawn = {
  type: string
  /** The Agent tool's `model` parameter, when given. */
  model?: string
  fork: boolean
  isBuiltIn: boolean
  parentModel: string
  /** The effort of the parent's latest request, when its model takes one. */
  parentEffort?: string
}

/** Built-in types that run on the parent's model and effort. */
const INHERITS = new Set(['general-purpose'])

/** A YAML scalar as written on one line: a quoted value's inside, or a plain one without its ` # comment`. */
function scalarOf(raw: string): string {
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw)

  return quoted ? (quoted[2] ?? '') : raw.replace(/\s+#.*$/, '')
}

/**
 * The frontmatter of an agent file: its `name` (else the file's name), and
 * `model` and `effort` when set. A file without frontmatter is no agent.
 */
export function agentDefinitionOf(text: string, fileName: string): AgentDefinition | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return undefined
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line)
    if (field?.[1] !== undefined) fields[field[1]] = scalarOf(field[2] ?? '')
  }
  const name = fields.name || fileName.replace(/\.md$/, '')

  return { name, model: fields.model || undefined, effort: fields.effort || undefined }
}

/**
 * The label for the agent list, e.g. `Opus 5.5 (high)`, or undefined when
 * the model cannot be known before the agent starts. A plugin's type
 * (`codex:read`) labels itself. The effort shows only where it is known to
 * carry over: the definition sets it, or the agent runs on the parent's model.
 */
export function agentLabel(spawn: AgentSpawn, definition?: AgentDefinition): string | undefined {
  if (spawn.type.includes(':')) return undefined
  const chosen = spawn.fork ? undefined : (spawn.model ?? definition?.model)
  const inherits = spawn.fork || chosen === 'inherit' || (!chosen && spawn.isBuiltIn && INHERITS.has(spawn.type))
  // An alias of the parent's family (`opus` under Opus 5.5) is the parent's model.
  const isParentAlias = chosen !== undefined && /^[a-z]+$/.test(chosen) && spawn.parentModel.startsWith(`claude-${chosen}-`)
  const model = inherits || isParentAlias ? spawn.parentModel : chosen
  if (!model) return undefined
  const effort = definition?.effort ?? (model === spawn.parentModel ? spawn.parentEffort : undefined)

  return effort ? `${displayModel(model)} (${effort})` : displayModel(model)
}

/**
 * The agent file whose `name` is `type`: the project's `.claude/agents/`
 * first, then the person's (`CLAUDE_CONFIG_DIR/agents`, else
 * `~/.claude/agents`); only the person's for a user agent. A definition from
 * anywhere else (settings, a flag, policy, a subfolder) is not read.
 */
export async function agentDefinitionNamed(io: Io, projectRoot: string, type: string, provider: string): Promise<AgentDefinition | undefined> {
  const user = `${await claudeDirectory(io)}/agents`
  const folders = provider === 'user' ? [user] : [`${projectRoot}/.claude/agents`, user]
  for (const folder of folders) {
    if (!(await io.exists(folder))) continue
    for (const entry of await io.list(folder)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
      const definition = agentDefinitionOf(await io.read(`${folder}/${entry.name}`), entry.name)
      if (definition?.name === type) return definition
    }
  }

  return undefined
}
