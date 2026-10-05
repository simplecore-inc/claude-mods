/**
 * The project's tools as `.toolbox/toolbox.json` keeps them, and a tool's
 * command with its parameters filled. Pure: the hooks module reads and writes
 * the file.
 */
import type { RunStatus, Tool, ToolboxSummary, ToolKind, ToolParam } from '../types'

/** The folder in the project that holds the toolbox, and its files. */
export const TOOLBOX_DIR = '.toolbox'
export const TOOLS_FILE = 'toolbox.json'
/** What the toolbox's own `.gitignore` keeps out when it is first made: the logs and the remembered values. */
export const DEFAULT_IGNORE = '# Run output and remembered values stay on this machine; delete a line to share it.\nlogs/\nstate.json\n'

const KINDS: readonly ToolKind[] = ['shell', 'claude', 'prompt']

/** Claude Code's commands that drop the conversation or reload what runs: added from the list, they ask before each run. */
export const CONFIRMED_COMMANDS: readonly string[] = ['clear', 'reload-plugins', 'exit', 'logout', 'rewind']

/** A `{{name}}` or `{{name|raw}}` in a command. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*(\|\s*raw\s*)?\}\}/g

/** The parameters a command names, in the order they first appear. */
export function paramNames(run: string): string[] {
  return [...new Set([...run.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))]
}

/** A value as one word of a POSIX shell command: in single quotes, a quote inside written `'\''`. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The command with each parameter's value in place of its `{{name}}`. In a
 * shell command a value is quoted as one word unless written `{{name|raw}}`;
 * a slash command or a prompt takes it as written.
 */
export function fill(tool: Pick<Tool, 'kind' | 'run'>, values: Record<string, string>): string {
  return tool.run.replace(PLACEHOLDER, (_, name: string, raw?: string) => {
    const value = values[name] ?? ''

    return tool.kind === 'shell' && !raw ? shellQuote(value) : value
  })
}

/** The parameters a run asks for: those marked `ask`, and any the command names without a setting. */
export function askedParams(tool: Pick<Tool, 'run' | 'params'>): string[] {
  return paramNames(tool.run).filter(name => (tool.params?.[name]?.mode ?? 'ask') === 'ask')
}

/** The values a run starts from: each fixed value, and for an asked one the remembered value or its default. */
export function startingValues(tool: Pick<Tool, 'run' | 'params'>, remembered: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    paramNames(tool.run).map(name => {
      const param = tool.params?.[name]
      const value = param?.mode === 'fixed' ? (param.value ?? '') : param?.remember !== false && remembered[name] !== undefined ? remembered[name] : (param?.value ?? '')

      return [name, value]
    }),
  )
}

/** Why a set of values cannot run: a choice not among its choices; null when they can. */
export function valuesProblem(tool: Pick<Tool, 'run' | 'params'>, values: Record<string, string>): string | null {
  for (const name of paramNames(tool.run)) {
    const param = tool.params?.[name]
    if (param?.type === 'choice' && param.choices && param.choices.length > 0 && !param.choices.includes(values[name] ?? '')) return name
  }

  return null
}

/** A short id for a new tool: its name in lowercase words, made unique among `taken`. */
export function toolId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tool'
  let id = base
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`

  return id
}

function asParam(value: unknown): ToolParam | null {
  const raw = value as Partial<ToolParam> | null
  if (!raw || typeof raw !== 'object') return null
  const type = raw.type === 'path' || raw.type === 'choice' ? raw.type : 'text'

  return {
    type,
    mode: raw.mode === 'fixed' ? 'fixed' : 'ask',
    ...(typeof raw.value === 'string' ? { value: raw.value } : {}),
    ...(Array.isArray(raw.choices) ? { choices: raw.choices.filter((one): one is string => typeof one === 'string') } : {}),
    ...(raw.pathKind === 'file' || raw.pathKind === 'dir' ? { pathKind: raw.pathKind } : {}),
    ...(typeof raw.glob === 'string' ? { glob: raw.glob } : {}),
    ...(raw.remember === false ? { remember: false } : {}),
  }
}

/**
 * The tools in a `toolbox.json` text, each checked: one without a name, a
 * known kind or a command is left out and named in `problems`.
 */
export function parseTools(text: string): { tools: Tool[]; problems: string[] } {
  const data = JSON.parse(text) as { tools?: unknown }
  const list = Array.isArray(data.tools) ? data.tools : []
  const tools: Tool[] = []
  const problems: string[] = []
  list.forEach((item, index) => {
    const raw = item as Partial<Tool> | null
    if (!raw || typeof raw.name !== 'string' || typeof raw.run !== 'string' || !KINDS.includes(raw.kind as ToolKind)) {
      problems.push(`tools[${index}]`)

      return
    }
    const params = Object.fromEntries(
      Object.entries(raw.params ?? {})
        .map(([name, value]) => [name, asParam(value)] as const)
        .filter((entry): entry is readonly [string, ToolParam] => entry[1] !== null),
    )
    tools.push({
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : toolId(raw.name, tools.map(tool => tool.id)),
      name: raw.name,
      kind: raw.kind as ToolKind,
      run: raw.run,
      ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(raw.submit === true ? { submit: true } : {}),
      ...(raw.confirm === true ? { confirm: true } : {}),
      ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    })
  })

  return { tools, problems }
}

/** The tools as `toolbox.json` text, two-space indented, for a person to read and edit too. */
export function toolsText(tools: Tool[]): string {
  return `${JSON.stringify({ version: 1, tools }, null, 2)}\n`
}

/**
 * A working folder for a shell command, from the project's root: refused when
 * it is absolute or climbs out of the project.
 */
export function workingFolder(root: string, cwd: string | undefined): string {
  if (!cwd || cwd === '.') return root
  if (cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd) || cwd.split(/[\\/]/).includes('..')) throw new Error(`cwd must stay inside the project: ${cwd}`)

  return `${root}/${cwd.replace(/^\.\//, '')}`
}

/**
 * The runs as a fresh load of the module finds them: a shell run it does not
 * hold was ended with the last load, so it is stopped; a Claude command it is
 * not waiting on was handed to Claude Code, which runs it whether or not the
 * module that asked is still there (`/reload-plugins` reloads this one), so
 * it is done. Runs it holds are left as they are.
 */
export function settleRuns(runs: Record<string, RunStatus>, held: (id: string) => boolean, now: number): Record<string, RunStatus> {
  return Object.fromEntries(
    Object.entries(runs).map(([id, run]) => {
      if (held(id)) return [id, run]
      if (run.state === 'running') return [id, { ...run, state: 'stopped' as const, endedAt: run.endedAt ?? now }]
      if (run.state === 'queued') return [id, { ...run, state: 'done' as const, endedAt: run.endedAt ?? now }]

      return [id, run]
    }),
  )
}

/** The runs as the band counts them: running, waiting for Claude, and failed after `seenAt`. */
export function summarize(runs: Record<string, RunStatus>, seenAt: number): ToolboxSummary {
  const all = Object.values(runs)

  return {
    running: all.filter(run => run.state === 'running').length,
    waiting: all.filter(run => run.state === 'queued').length,
    failed: all.filter(run => run.state === 'failed' && (run.endedAt ?? 0) > seenAt).length,
  }
}
