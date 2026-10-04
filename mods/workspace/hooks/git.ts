import type { DiffFile, WorktreeRow } from '../types'

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
 * Joins `git diff --name-status -M` and `git diff --numstat -M` for the same
 * range into one row per file. A rename is keyed by its new path.
 */
export function parseDiffFiles(nameStatus: string, numstat: string): DiffFile[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [added = '', removed = '', ...rest] = parts
    // A rename in numstat is `old\tnew` with -z, or `old => new` / `pre{old => new}post` without.
    const path = rest.length === 2 ? (rest[1] ?? '') : renamedTo(rest.join('\t'))
    counts.set(path, { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) })
  }

  return nameStatus
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 2 && parts[0] !== '')
    .map(parts => {
      const code = (parts[0] ?? '').charAt(0)
      const path = (code === 'R' || code === 'C' ? parts[2] : parts[1]) ?? ''
      const from = code === 'R' || code === 'C' ? parts[1] : undefined
      const count = counts.get(path) ?? { added: null, removed: null }
      const status: DiffFile['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified'

      return { path, from, status, added: count.added, removed: count.removed }
    })
}

/** The new path of a numstat rename: `a => b`, or `dir/{a => b}/f`. */
export function renamedTo(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\//g, '/')
  const plain = / => /.exec(path)

  return plain ? path.slice(plain.index + 4) : path
}

/** The first line of a prompt, cut to `width` characters, for a checkpoint's label. */
export function promptLabel(text: string, width = 60): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
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

/**
 * The diff text cut to `limit` lines, saying how many were left out. The
 * trailing newline goes: a diff renderer reads the empty line after it as a
 * malformed hunk line.
 */
export function clipDiff(text: string, limit: number): { text: string; omitted: number } {
  const trimmed = text.replace(/\n+$/, '')
  const lines = trimmed.split('\n')
  if (lines.length <= limit) return { text: trimmed, omitted: 0 }

  return { text: lines.slice(0, limit).join('\n'), omitted: lines.length - limit }
}
