import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * A repository in memory beneath the workspace plugin, for the tests that
 * start a session: its files, the plugin store, and the git commands the
 * session runs answered as git answers them for a repository at `/repo`
 * whose git folder is `/repo/.git`. A test reads what landed where.
 */
export function fakeRepo(on: On, start: { store?: Record<string, unknown>; files?: Record<string, string>; now?: number; agents?: unknown[] } = {}) {
  const files: Record<string, string> = { ...start.files }
  const store: Record<string, unknown> = { ...start.store }
  const storeWrites: string[] = []
  const runs: string[][] = []
  /** The working tree as `git write-tree` names it: the same until a test changes it, or a new one at every snapshot. */
  const tree = { name: 'tree1', isChanging: false }
  let trees = 1
  let commits = 0
  const answer = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } as never })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const line = argv.join(' ')
    if (line === 'git rev-parse --show-toplevel') return answer('/repo\n')
    // The worktree at /repo-wip keeps its own files in the repository's git folder.
    if (line.startsWith('git rev-parse --path-format=absolute --git-path ')) {
      return answer(`/repo/.git/${e.init?.cwd === '/repo-wip' ? 'worktrees/wip/' : ''}${argv[argv.length - 1]}\n`)
    }
    if (line === 'git worktree list --porcelain') return answer('worktree /repo\nHEAD h1\nbranch refs/heads/main\n\nworktree /repo-wip\nHEAD h2\nbranch refs/heads/wip\n')
    if (line === 'git rev-list --left-right --count main...wip') return answer('0\t1\n')
    if (line === 'git merge-base main wip') return answer('base1\n')
    if (line === 'git rev-parse --path-format=absolute --git-common-dir') return answer('/repo/.git\n')
    if (line === 'git rev-parse --verify --quiet HEAD') return answer('head\n')
    if (line === 'git write-tree') return answer(`${tree.isChanging ? `tree${(trees += 1)}` : tree.name}\n`)
    if (line.startsWith('git commit-tree ')) return answer(`commit${(commits += 1)}\n`)

    return answer()
  })
  const exists = (path: string) => path in files || Object.keys(files).some(file => file.startsWith(`${path}/`))
  on('fs.exists', ($, e) => ({ value: exists(e.path) as never }))
  on('fs.read', ($, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)

    return { value: files[e.path] as never }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text

    return { value: undefined as never }
  })
  on('store.get', ($, e) => ({ value: store[e.key] as never }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    storeWrites.push(e.key)

    return { value: undefined as never }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]

    return { value: undefined as never }
  })
  on('session.id', () => ({ value: 'session-1' as never }))
  on('session.root', () => ({ value: '/repo' as never }))
  // The panes the plugin opened and has not closed, as the engine lists them.
  const panes = new Set<string>()
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } as never }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined as never }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  on('ui.log', () => ({ value: undefined as never }))
  on('settings.read', () => ({ value: {} as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('agent.list', () => ({ value: (start.agents ?? []) as never }))
  mock.env(on, { HOME: '/home/me' })
  const clock = mock.clock(on, { now: start.now ?? Date.parse('2026-10-06T05:00:00Z') } as never)

  return {
    clock,
    files,
    store,
    storeWrites,
    runs,
    tree,
    /** A list file under the repository's git folder, read back. */
    list: (kind: 'notes' | 'checkpoints') => JSON.parse(files[`/repo/.git/sc-workspace/${kind}--repo.json`] ?? 'null') as { text?: string; kind?: string }[] | null,
  }
}
