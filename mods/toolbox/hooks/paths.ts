/**
 * Path suggestions as a person types, and the output of a run as the log
 * dialog draws it. Pure: the hooks module lists folders and feeds output in.
 */
import { printable } from './shared/layout'

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

/** The most a run's log file keeps, in UTF-8 bytes: its newest part, well under the 4 MiB a write takes. */
export const LOG_FILE_BYTES = 3_000_000

/** The bytes a string takes in UTF-8. */
function utf8Size(text: string): number {
  let size = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) size += 1
    else if (code < 0x800) size += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      size += 4
      index += 1
    } else size += 3
  }

  return size
}

/**
 * The newest part of a log's text that fits `bytes` in UTF-8, from the start
 * of a line. Output in Korean takes three bytes a character, so a cut counted
 * in characters passes the engine's 4 MiB write limit, and the file is then
 * written no more.
 */
export function newestPart(text: string, bytes: number): string {
  if (utf8Size(text) <= bytes) return text
  let start = text.length
  let size = 0
  while (start > 0) {
    const from = text.lastIndexOf('\n', start - 2) + 1
    const lineSize = utf8Size(text.slice(from, start))
    if (size + lineSize > bytes) break
    size += lineSize
    start = from
  }

  return text.slice(start)
}

/**
 * A line as a terminal shows it once a program has rewritten it with carriage
 * returns (a progress bar): its newest form, the text after the last return
 * that has any.
 */
export function rewritten(line: string): string {
  const forms = line.split('\r')
  for (let index = forms.length - 1; index >= 0; index -= 1) if (forms[index] !== '') return forms[index] ?? ''

  return ''
}

/**
 * A run's output as it arrives, kept as whole lines: a piece that ends mid-line
 * waits for the rest. Each whole line is kept as a terminal would show it, its
 * escape sequences and control characters removed (cleaned whole, so a
 * sequence cut between two pieces leaves nothing behind). The newest
 * `LOG_LINES_KEPT` lines are kept to draw, and every line goes to `pending`
 * for the log file.
 */
export class LogBuffer {
  lines: string[] = []
  pending = ''
  private partial = ''

  /** Takes a piece of output as it came, in any size. */
  push(text: string): void {
    const parts = (this.partial + text).replace(/\r\n/g, '\n').split('\n')
    const rest = parts.pop() ?? ''
    // A line rewritten in place keeps only its newest form; a return at the end may be half of CRLF.
    this.partial = rest.endsWith('\r') ? `${rewritten(rest)}\r` : rewritten(rest)
    if (parts.length === 0) return
    const whole = parts.map(line => printable(rewritten(line)))
    this.lines.push(...whole)
    if (this.lines.length > LOG_LINES_KEPT) this.lines.splice(0, this.lines.length - LOG_LINES_KEPT)
    this.pending += `${whole.join('\n')}\n`
  }

  /** The line being written now, in its newest form: a progress bar before its newline comes. */
  get current(): string {
    return printable(rewritten(this.partial))
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

  /**
   * The lines to draw ending at `last` (the newest when absent), as many as fit
   * `limit` characters and `lines` lines. Ending at the newest, the line being
   * written now is drawn below them, so a progress bar shows as it moves.
   */
  window(limit: number, last?: number, lines = Infinity): { text: string; first: number; last: number } {
    const end = Math.min(this.lines.length, last ?? this.lines.length)
    const live = last === undefined || last >= this.lines.length ? this.current : ''
    let start = end
    let size = live === '' ? 0 : live.length + 1
    const room = live === '' ? lines : lines - 1
    while (start > 0 && end - start < room) {
      const line = this.lines[start - 1] ?? ''
      if (size + line.length + 1 > limit) break
      size += line.length + 1
      start -= 1
    }

    return { text: [...this.lines.slice(start, end), ...(live === '' ? [] : [live])].join('\n'), first: start, last: end }
  }
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
