import type { DiffFile, WorktreeRow } from '../types'
import { countChanged, parseDiffFiles, parseLeftRight, parseWorktrees } from './git'

/** Runs a command by argv and resolves its exit code and output; the hooks module passes one over `$.process.run`. */
export type Run = (
  argv: readonly string[],
  init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export class GitError extends Error {}

/** An identity for checkpoint commits, so a repository with no user.email still takes them. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'sc checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@sc.invalid',
  GIT_COMMITTER_NAME: 'sc checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@sc.invalid',
}

async function git(run: Run, root: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { exitCode, stdout, stderr } = await run(['git', ...args], { cwd: root, env, timeoutMs: 60_000 })
  if (exitCode !== 0) throw new GitError(`git ${args[0]} exited ${exitCode}: ${stderr.trim().split('\n')[0] ?? ''}`)

  return stdout
}

async function hasHead(run: Run, root: string): Promise<boolean> {
  const { exitCode } = await run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root })

  return exitCode === 0
}

/** The repository's top directory, or null when `cwd` is in none. */
export async function repoRoot(run: Run, cwd: string): Promise<string | null> {
  const { exitCode, stdout } = await run(['git', 'rev-parse', '--show-toplevel'], { cwd })

  return exitCode === 0 ? stdout.trim() : null
}

/**
 * The working tree as a tree object: tracked and untracked files, ignored
 * ones left out. Built in an index of its own, so the user's staging area
 * is never touched.
 */
export async function snapshotTree(run: Run, root: string): Promise<string> {
  const indexPath = (await git(run, root, ['rev-parse', '--path-format=absolute', '--git-path', 'sc-snapshot.index'])).trim()
  const env = { GIT_INDEX_FILE: indexPath }
  if (await hasHead(run, root)) await git(run, root, ['read-tree', 'HEAD'], env)
  else await git(run, root, ['read-tree', '--empty'], env)
  await git(run, root, ['add', '--all'], env)

  return (await git(run, root, ['write-tree'], env)).trim()
}

/**
 * Takes a checkpoint: a snapshot of the working tree as a commit kept under
 * `ref`. `tree` is a snapshot already taken, to save taking it twice.
 */
export async function createCheckpoint(
  run: Run,
  root: string,
  ref: string,
  label: string,
  tree?: string,
): Promise<{ commit: string; tree: string }> {
  tree ??= await snapshotTree(run, root)
  const parent = (await hasHead(run, root)) ? ['-p', 'HEAD'] : []
  const commit = (await git(run, root, ['commit-tree', tree, ...parent, '-m', label], CHECKPOINT_IDENTITY)).trim()
  await git(run, root, ['update-ref', ref, commit])

  return { commit, tree }
}

export async function deleteRef(run: Run, root: string, ref: string): Promise<void> {
  await git(run, root, ['update-ref', '-d', ref])
}

/** Files, lines added and lines removed between two tree-ish objects. */
export async function diffSummary(run: Run, root: string, from: string, to: string): Promise<{ files: number; added: number; removed: number }> {
  const numstat = await git(run, root, ['diff', '--numstat', '-M', from, to])
  let files = 0
  let added = 0
  let removed = 0
  for (const line of numstat.split('\n')) {
    const [a, r] = line.split('\t')
    if (a === undefined || r === undefined) continue
    files += 1
    added += a === '-' ? 0 : Number(a)
    removed += r === '-' ? 0 : Number(r)
  }

  return { files, added, removed }
}

export async function diffFiles(run: Run, root: string, from: string, to: string): Promise<DiffFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(run, root, ['diff', '--name-status', '-M', from, to]),
    git(run, root, ['diff', '--numstat', '-M', from, to]),
  ])

  return parseDiffFiles(nameStatus, numstat)
}

export async function fileDiff(run: Run, root: string, from: string, to: string, path: string): Promise<string> {
  return git(run, root, ['diff', '-M', from, to, '--', path])
}

/**
 * Puts the working tree back to a checkpoint: every file it holds is written
 * back, and files made since it are removed. The caller takes a checkpoint of
 * the state it replaces first, so the restore can be undone.
 */
export async function restoreCheckpoint(run: Run, root: string, commit: string, tree: string, currentTree: string): Promise<number> {
  await git(run, root, ['restore', `--source=${commit}`, '--worktree', '--', ':/'])
  const made = (await git(run, root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', tree, currentTree]))
    .split('\n')
    .filter(Boolean)
  for (let start = 0; start < made.length; start += 100) {
    const { exitCode, stderr } = await run(['rm', '-f', '--', ...made.slice(start, start + 100)], { cwd: root })
    if (exitCode !== 0) throw new GitError(`rm exited ${exitCode}: ${stderr.trim()}`)
  }

  return made.length
}

/** The repository's worktrees: the main one first, each with its changes and its branch against the main branch. */
export async function listWorktrees(run: Run, root: string): Promise<WorktreeRow[]> {
  const entries = parseWorktrees(await git(run, root, ['worktree', 'list', '--porcelain'])).filter(entry => !entry.isBare)
  const mainBranch = entries[0]?.branch

  return Promise.all(
    entries.map(async (entry, index) => {
      const status = await run(['git', '-C', entry.path, 'status', '--porcelain'], { timeoutMs: 15_000 })
      let counts: { behind: number; ahead: number } | undefined
      if (index > 0 && mainBranch && entry.branch) {
        const range = await run(['git', 'rev-list', '--left-right', '--count', `${mainBranch}...${entry.branch}`], { cwd: root })
        counts = range.exitCode === 0 ? parseLeftRight(range.stdout) : undefined
      }

      return {
        path: entry.path,
        branch: entry.branch,
        isMain: index === 0,
        isLocked: entry.isLocked,
        changed: status.exitCode === 0 ? countChanged(status.stdout) : -1,
        ahead: counts?.ahead,
        behind: counts?.behind,
      }
    }),
  )
}

/** Removes a clean worktree, and its branch when the main branch already holds every commit of it. */
export async function removeWorktree(run: Run, root: string, row: WorktreeRow): Promise<void> {
  await git(run, root, ['worktree', 'remove', row.path])
  if (row.branch && row.ahead === 0) await git(run, root, ['branch', '-d', row.branch])
}
