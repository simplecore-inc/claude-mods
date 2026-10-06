/**
 * The session's status as the band draws it: pure helpers the
 * hooks module feeds with what the engine, git and the transcript say.
 */

/** A model id as Claude Code names it on screen: `claude-opus-5-5` as `Opus 5.5`; anything else as given. */
export function displayModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model)
  if (!match) return model
  const [, family = '', major, minor] = match

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`
}

/**
 * Lines added and removed between two versions of a file, counted as a diff
 * stat counts them when the lines kept are matched as a multiset: each line
 * the new text holds more often than the old is added, each it holds less
 * often is removed. A missing file counts as empty.
 */
export function lineChanges(before: string | null, after: string | null): { added: number; removed: number } {
  const counts = new Map<string, number>()
  const lines = (text: string | null) => (text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n'))
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) - 1)
  for (const line of lines(after)) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  let removed = 0
  for (const delta of counts.values()) {
    if (delta > 0) added += delta
    else removed -= delta
  }

  return { added, removed }
}

/** The tools whose calls change a file named by `file_path` (`notebook_path` for a notebook). */
export const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The file a file-changing tool call names, or null. */
export function editedPath(tool: string, input: unknown): string | null {
  if (!FILE_EDIT_TOOLS.has(tool) || typeof input !== 'object' || input === null) return null
  const fields = input as { file_path?: unknown; notebook_path?: unknown }
  const path = fields.file_path ?? fields.notebook_path

  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * Whether ultracode is on after the transcript lines given (lines that hold
 * the marker, as grep finds them), starting from `active`. Only an attachment
 * record switches it: `ultra_effort_enter` on, `ultra_effort_exit` off. A
 * line that merely mentions the words, in a message or a tool result, does not.
 */
export function ultracodeAfter(lines: string, active: boolean): boolean {
  let state = active
  for (const line of lines.split('\n')) {
    if (line === '') continue
    try {
      const record = JSON.parse(line) as { type?: unknown; attachment?: { type?: unknown } }
      const kind = record.type === 'attachment' ? record.attachment?.type : undefined
      if (kind === 'ultra_effort_enter') state = true
      else if (kind === 'ultra_effort_exit') state = false
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }

  return state
}

/** What a transcript line must contain to be one that may switch ultracode. */
export const ULTRA_MARKER = '"type":"ultra_effort_'

/** The in-progress task's active form in a todo list file's text, or `''`. */
export function inProgressTask(text: string): string {
  try {
    const todos = JSON.parse(text) as { status?: unknown; activeForm?: unknown }[]
    if (!Array.isArray(todos)) return ''
    const doing = todos.find(todo => todo.status === 'in_progress')

    return typeof doing?.activeForm === 'string' ? doing.activeForm : ''
  } catch (error) {
    if (error instanceof SyntaxError) return ''
    throw error
  }
}

/** The session's todo list files, newest first: `<session>-agent-*.json`. */
export function todoFilesOf(entries: readonly { name: string; mtimeMs: number }[], session: string): string[] {
  return entries
    .filter(entry => entry.name.startsWith(session) && entry.name.includes('-agent-') && entry.name.endsWith('.json'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => entry.name)
}

/** The PR of the current branch as `gh pr view --json number,reviewDecision` prints it, or null. */
export function parsePr(text: string): { number: number; reviewState: string | null } | null {
  try {
    const raw = JSON.parse(text) as { number?: unknown; reviewDecision?: unknown }
    if (typeof raw.number !== 'number') return null
    const decision = typeof raw.reviewDecision === 'string' && raw.reviewDecision !== '' ? raw.reviewDecision.toLowerCase() : null

    return { number: raw.number, reviewState: decision === 'review_required' ? null : decision }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** The effort keys of one settings source. */
export type EffortSettings = { effortLevel?: unknown; modelSettings?: unknown }

/** The settings sources, the one that wins first. */
const SOURCES_FIRST_WINS = ['policy', 'flag', 'local', 'project', 'user'] as const

/** The levels a settings file can hold; `max` is kept to a session and never saved. */
const SAVED_LEVELS = new Set(['low', 'medium', 'high', 'xhigh'])

function savedLevel(value: unknown): string | null {
  return typeof value === 'string' && SAVED_LEVELS.has(value) ? value : null
}

/** The `modelSettings.<model>.effortLevel` of one source, as given: undefined when the source names none. */
function modelLevel(settings: EffortSettings, modelId: string): unknown {
  const models = settings.modelSettings as Record<string, { effortLevel?: unknown } | undefined> | undefined

  return models?.[modelId.replace(/\[1m\]$/, '')]?.effortLevel
}

/**
 * The effort a session starts at, from each settings source as Claude Code
 * reads them: the first source, the highest first, that names a level for the
 * model or one for every model wins; the user's level for every model counts
 * only where no other source names one. None means the model's own default,
 * which no setting says.
 */
export function startingEffort(sources: Partial<Record<(typeof SOURCES_FIRST_WINS)[number], EffortSettings>>, modelId: string): string | null {
  for (const source of SOURCES_FIRST_WINS) {
    const settings = sources[source]
    if (!settings) continue
    const perModel = modelLevel(settings, modelId)
    if (perModel !== undefined) return savedLevel(perModel)
    if (source !== 'user' && settings.effortLevel !== undefined) return savedLevel(settings.effortLevel)
  }

  return savedLevel(sources.user?.effortLevel)
}

/** The level `/effort` saved for the model, where it saves one: the user's settings, under the model. */
export function savedModelEffort(user: EffortSettings, modelId: string): string | null {
  return savedLevel(modelLevel(user, modelId))
}
