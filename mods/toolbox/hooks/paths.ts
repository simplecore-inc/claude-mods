/**
 * Path suggestions as a person types, and the output of a run as the log
 * dialog draws it. Pure: the hooks module lists folders and feeds output in.
 */

/** A `*`/`?` glob as a test on a file name; every name passes an empty glob. */
export function globTest(glob: string | undefined): (name: string) => boolean {
  if (!glob) return () => true
  const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

  return name => pattern.test(name)
}

/** The folder to list for what was typed, and the start of the name being typed in it. */
export function splitTyped(typed: string): { folder: string; prefix: string } {
  const slash = typed.lastIndexOf('/')

  return slash === -1 ? { folder: '', prefix: typed } : { folder: typed.slice(0, slash), prefix: typed.slice(slash + 1) }
}

/** Names never offered: version control and dependency folders, which nobody means to pick. */
const SKIPPED = new Set(['.git', 'node_modules', 'target', '.gradle', '.idea', '.DS_Store'])

/**
 * The paths to offer for what was typed, from the folder's entries: those
 * starting with the name typed (ignoring case), folders with a `/` after them
 * so a pick goes on into them, files only when files may be picked and only
 * those matching the glob; folders first, then files, by name, at most `limit`.
 */
export function pathSuggestions(
  typed: string,
  entries: { name: string; kind: 'file' | 'dir' | 'other' }[],
  options: { pathKind?: 'file' | 'dir' | 'any'; glob?: string; limit?: number } = {},
): string[] {
  const { folder, prefix } = splitTyped(typed)
  const matches = globTest(options.glob)
  const start = prefix.toLowerCase()
  const base = folder === '' ? '' : `${folder}/`
  const shown = entries.filter(entry => !SKIPPED.has(entry.name) && entry.name.toLowerCase().startsWith(start) && (start.startsWith('.') || !entry.name.startsWith('.')))
  const dirs = shown.filter(entry => entry.kind === 'dir').map(entry => `${base}${entry.name}/`)
  const files = options.pathKind === 'dir' ? [] : shown.filter(entry => entry.kind === 'file' && matches(entry.name)).map(entry => `${base}${entry.name}`)

  return [...dirs.sort(), ...files.sort()].slice(0, options.limit ?? 8)
}

/** Lines of a run's output kept to draw: the log file holds every one. */
export const LOG_LINES_KEPT = 2_000

/**
 * A run's output as it arrives, kept as whole lines: a piece that ends mid-line
 * waits for the rest. The newest `LOG_LINES_KEPT` lines are kept to draw, and
 * every line goes to `pending` for the log file.
 */
export class LogBuffer {
  lines: string[] = []
  pending = ''
  private partial = ''

  /** Takes a piece of output as it came, in any size. */
  push(text: string): void {
    const parts = (this.partial + text.replace(/\r\n?/g, '\n')).split('\n')
    this.partial = parts.pop() ?? ''
    if (parts.length === 0) return
    this.lines.push(...parts)
    if (this.lines.length > LOG_LINES_KEPT) this.lines.splice(0, this.lines.length - LOG_LINES_KEPT)
    this.pending += `${parts.join('\n')}\n`
  }

  /** The line still being written, once the run has ended. */
  end(): void {
    if (this.partial === '') return
    this.push('\n')
  }

  /** The lines written to the log file since it was last written, and none after. */
  takePending(): string {
    const text = this.pending
    this.pending = ''

    return text
  }

  /** The lines to draw ending at `last` (the newest when absent), as many as fit `limit` characters and `lines` lines. */
  window(limit: number, last?: number, lines = Infinity): { text: string; first: number; last: number } {
    const end = Math.min(this.lines.length, last ?? this.lines.length)
    let start = end
    let size = 0
    while (start > 0 && end - start < lines) {
      const line = this.lines[start - 1] ?? ''
      if (size + line.length + 1 > limit) break
      size += line.length + 1
      start -= 1
    }

    return { text: this.lines.slice(start, end).join('\n'), first: start, last: end }
  }
}

/** Escape sequences a program writes for a terminal (colours, cursor moves): the log draws text alone. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '')
}

/** A share done in a line of output: `45%`, or `3/10` and `[3/10]` read as a count of a total. */
const PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s?%/g
const COUNT = /(?<![\w/.])(\d+)\s?\/\s?(\d+)(?![\w/.])/g

/**
 * How far a run has got, 0 to 100, from its newest lines that say so: the
 * last percentage or count of a total in the newest such line among the last
 * `lookBack`. Undefined when none says.
 */
export function progressOf(lines: readonly string[], lookBack = 5): number | undefined {
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - lookBack); index -= 1) {
    const line = lines[index] ?? ''
    const percents = [...line.matchAll(PERCENT)].map(match => Number(match[1])).filter(value => value <= 100)
    if (percents.length > 0) return percents[percents.length - 1]
    const counts = [...line.matchAll(COUNT)].map(match => [Number(match[1]), Number(match[2])] as const).filter(([done, total]) => total > 0 && done <= total)
    const count = counts[counts.length - 1]
    if (count) return Math.round((count[0] / count[1]) * 100)
  }

  return undefined
}
