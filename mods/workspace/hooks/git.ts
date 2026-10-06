import type { AgentRow, CheckpointRow, DiffFile, FinishedAgent, WorktreeRow } from '../types'
import { printable } from './shared/layout'

/** One worktree as `git worktree list --porcelain` describes it. */
export type WorktreeEntry = { path: string; head: string; branch?: string; isBare: boolean; isDetached: boolean; isLocked: boolean }

/** Parses `git worktree list --porcelain`: blank-line separated records of `key value` lines. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split(/\n\s*\n/)
    .map(block => block.split('\n').filter(Boolean))
    .filter(lines => lines.some(line => line.startsWith('worktree ')))
    .map(lines => {
      const value = (key: string) => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1)
      const branch = value('branch')

      return {
        path: value('worktree') ?? '',
        head: value('HEAD') ?? '',
        branch: branch?.replace(/^refs\/heads\//, ''),
        isBare: lines.includes('bare'),
        isDetached: lines.includes('detached'),
        isLocked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
      }
    })
}

/** `git rev-list --left-right --count main...branch` → commits only on main (behind), only on branch (ahead). */
export function parseLeftRight(output: string): { behind: number; ahead: number } | undefined {
  const match = /^(\d+)\s+(\d+)/.exec(output.trim())

  return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : undefined
}

/** Lines of `git status --porcelain`: one per changed or untracked path. */
export function countChanged(porcelain: string): number {
  return porcelain.split('\n').filter(line => line.trim() !== '').length
}

/** Whether a worktree can be removed without losing anything: clean, and nothing only on its branch. */
export function isRemovable(row: WorktreeRow): boolean {
  return !row.isMain && !row.isLocked && row.changed === 0 && (row.ahead ?? 1) === 0
}

/**
 * Joins `git diff -z --name-status -M` and `git diff -z --numstat -M` for the
 * same range into one row per file, a rename keyed by its new path. The NUL
 * form names every path as it is; the line form quotes a path holding a
 * non-ASCII byte, a quote, a backslash or a control character, and the quoted
 * name then matches no file to show, restore or delete.
 */
export function parseDiffFiles(nameStatus: string, numstat: string): DiffFile[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const stats = numstat.split('\0')
  for (let index = 0; index < stats.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[index] ?? '')
    if (!match) continue
    // A rename leaves the path empty here: its old and new paths follow as fields of their own.
    let path = match[3] ?? ''
    if (path === '') {
      path = stats[index + 2] ?? ''
      index += 2
    }
    counts.set(path, { added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) })
  }
  const files: DiffFile[] = []
  const fields = nameStatus.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const code = (fields[index] ?? '').charAt(0)
    if (code === '') continue
    const isMove = code === 'R' || code === 'C'
    const from = isMove ? fields[index + 1] : undefined
    const path = (isMove ? fields[index + 2] : fields[index + 1]) ?? ''
    index += isMove ? 2 : 1
    const count = counts.get(path) ?? { added: null, removed: null }
    const status: DiffFile['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified'
    files.push({ path, ...(from !== undefined ? { from } : {}), status, added: count.added, removed: count.removed })
  }

  return files
}

/** Blocks the harness wraps around text it sends as a prompt; none of it is what the person wrote. */
const HARNESS_BLOCK = /<(task-notification|system-reminder|local-command-[\w-]+|command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g
/** Text pasted into the prompt, wrapped by the harness. */
const PASTED_BLOCK = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g

/** The first non-empty line of `text` with any tag left in it removed, and anything a terminal would act on. */
function firstLine(text: string): string {
  for (const line of printable(text.replace(/<\/?[A-Za-z][\w-]*\b[^>]*>/g, ' ')).split('\n')) {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (clean !== '') return clean
  }

  return ''
}

/**
 * A checkpoint's label from the prompt it was taken before: the first line
 * the person wrote, cut to `width` characters. Harness blocks are left out;
 * pasted text stands in when nothing else was written, and a task
 * notification's summary when the prompt was only that. Empty when nothing
 * readable is left, so the caller names the checkpoint by its kind.
 */
export function promptLabel(text: string, width = 60): string {
  const pasted = [...text.matchAll(PASTED_BLOCK)].map(match => match[1] ?? '').join('\n')
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? ''
  const own = text.replace(HARNESS_BLOCK, '\n').replace(PASTED_BLOCK, '\n')
  // A label stored cut short keeps an opening tag whose block never closes: it reads as nothing.
  const line = firstLine(own) || firstLine(pasted) || firstLine(summary)
  if (line.length <= width) return line

  return `${line.slice(0, width - 1)}…`
}

/** A checkpoint's ref: per session, numbered so they sort in order. */
export function checkpointRef(sessionId: string, seq: number): string {
  return `refs/sc/checkpoints/${sessionId}/${String(seq).padStart(4, '0')}`
}

/** A path for display: inside `root` it is relative, under `home` it starts with `~`. */
export function shortPath(path: string, root: string, home: string | undefined): string {
  if (path === root) return '.'
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`

  return path
}

/** The longest diff line shown whole; past it the line is cut and marked `…`. */
export const DIFF_LINE_CHARS = 400

/**
 * The diff text cut to `limit` lines and to `chars` characters, each line to
 * `DIFF_LINE_CHARS` (a minified file or an SVG is one line of thousands),
 * saying how many lines were left out. The trailing newline goes: a diff
 * renderer reads the empty line after it as a malformed hunk line.
 */
export function clipDiff(text: string, limit: number, chars: number): { text: string; omitted: number } {
  const lines = text.replace(/\n+$/, '').split('\n')
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const shown = line.length > DIFF_LINE_CHARS ? `${line.slice(0, DIFF_LINE_CHARS)}…` : line
    if (kept.length === limit || size + shown.length + 1 > chars) break
    kept.push(shown)
    size += shown.length + 1
  }

  return { text: kept.join('\n'), omitted: lines.length - kept.length }
}

/** A hunk side's range as its header writes it: `start,count`, an empty side named by the line before it. */
function hunkRange(next: number, count: number): string {
  return count === 0 ? `${Math.max(0, next - 1)},0` : `${next},${count}`
}

/**
 * A file's diff cut into pages of at most `size` lines that the engine reads
 * as a diff. A page cut inside a hunk does not parse and is drawn as plain
 * code, so each piece of a hunk goes under a header of its own, its counts
 * those of the lines it holds and its starts where the piece begins (the
 * section heading stays on the first piece). The lines before the first hunk,
 * the file's own headers, open the first page; a diff with no hunk (a binary
 * file, a mode change) is cut by lines. A `\ No newline at end of file` line
 * stays with the line it follows.
 */
export function diffPages(text: string, size: number): string[] {
  const lines = text === '' ? [] : text.split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))
  const pages: string[][] = []
  let page: string[] = []
  const add = (piece: string[]) => {
    if (page.length > 0 && page.length + piece.length > size) {
      pages.push(page)
      page = []
    }
    page.push(...piece)
  }
  for (const line of first === -1 ? lines : lines.slice(0, first)) add([line])
  let index = first === -1 ? lines.length : first
  while (index < lines.length) {
    const header = lines[index] ?? ''
    let end = index + 1
    while (end < lines.length && !(lines[end] ?? '').startsWith('@@')) end += 1
    const body = lines.slice(index + 1, end)
    index = end
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header)
    if (!match) {
      for (const line of [header, ...body]) add([line])
      continue
    }
    // The next line of each side: an empty side's header names the line before it.
    let oldNext = Number(match[1]) + (match[2] === '0' ? 1 : 0)
    let newNext = Number(match[3]) + (match[4] === '0' ? 1 : 0)
    let heading = match[5] ?? ''
    let at = 0
    do {
      if (page.length > 0 && page.length + 2 > size) {
        pages.push(page)
        page = []
      }
      let take = Math.min(Math.max(1, size - page.length - 1), body.length - at)
      if ((body[at + take] ?? '').startsWith('\\')) take = take > 1 ? take - 1 : take + 1
      const piece = body.slice(at, at + take)
      const oldCount = piece.filter(line => line.startsWith(' ') || line.startsWith('-')).length
      const newCount = piece.filter(line => line.startsWith(' ') || line.startsWith('+')).length
      page.push(`@@ -${hunkRange(oldNext, oldCount)} +${hunkRange(newNext, newCount)} @@${heading}`, ...piece)
      oldNext += oldCount
      newNext += newCount
      heading = ''
      at += take
    } while (at < body.length)
  }
  if (page.length > 0) pages.push(page)

  return pages.length > 0 ? pages.map(one => one.join('\n')) : ['']
}

/**
 * Which checkpoints stay when one more is taken: every pinned one, every one
 * of `keep` (refs), and the newest `limit` of the rest; the others are
 * `gone`, their refs to delete.
 */
export function keptCheckpoints(all: CheckpointRow[], limit: number, keep: readonly string[] = []): { kept: CheckpointRow[]; gone: CheckpointRow[] } {
  const over = new Set(
    all
      .filter(one => !one.isPinned && !keep.includes(one.ref))
      .slice(limit)
      .map(one => one.ref),
  )

  return { kept: all.filter(one => !over.has(one.ref)), gone: all.filter(one => over.has(one.ref)) }
}

/**
 * The finished group after the engine's list is read again: the agents it
 * listed before and lists no more go first, with their answers, newest first;
 * an agent listed again leaves the group; at most `limit` are kept.
 */
export function finishAgents(
  before: AgentRow[],
  listed: AgentRow[],
  finished: FinishedAgent[],
  answers: Record<string, string>,
  now: number,
  limit: number,
): FinishedAgent[] {
  const ids = new Set(listed.map(row => row.id))
  const ended = before
    .filter(row => !ids.has(row.id))
    .map(row => ({ ...row, endedAt: now, ...(answers[row.id] !== undefined ? { answer: answers[row.id] } : {}) }))

  return [...ended, ...finished.filter(one => !ids.has(one.id) && !ended.some(row => row.id === one.id))].slice(0, limit)
}
