import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * The engine beneath the workspace pane, for the tests that mount it: the
 * state store seeded with agents, worktrees, checkpoints, notes and a diff,
 * the clock, and the props the engine draws the pane with.
 */

export const SURFACES = ['terminal', 'desktop'] as const
export const NOW = Date.parse('2026-10-04T05:00:00Z')

/** Stands in for the engine's state store beneath the plugin. */
/**
 * Stands in for the engine's state store beneath the plugin, seeded with the
 * values below and `extra`. With `isVersioned` the plugin's writes land in it
 * and keep a version, so a write made from a value read earlier misses, as the
 * engine's own store answers it; `values` is handed back to read what landed.
 */
export function seedState(on: On, extra: Record<string, unknown>, options: { isVersioned?: boolean } = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    tab: 'agents',
    agents: [
      { id: 'a1', stopIds: ['a1', 'reviewer'], label: 'reviewer', type: 'general-purpose', status: 'running', firstSeen: NOW - 5 * 60_000 },
      { id: 'a2', stopIds: ['a2'], label: 'Find the config loader', type: 'Explore', status: 'completed', firstSeen: NOW - 60_000 },
    ],
    worktrees: [
      { path: '/repo', branch: 'main', isMain: true, isLocked: false, changed: 2 },
      { path: '/repo-merged', branch: 'done', isMain: false, isLocked: false, changed: 0, ahead: 0, behind: 3 },
      { path: '/repo-busy', branch: 'wip', isMain: false, isLocked: false, changed: 4, ahead: 2, behind: 0 },
    ],
    repoError: null,
    checkpoints: [
      { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label: 'Fix the login bug', kind: 'turn', since: { files: 2, added: 10, removed: 3 } },
      { ref: 'refs/sc/checkpoints/s/0001', commit: 'c1', tree: 't1', at: NOW - 3_600_000, label: '', kind: 'session', since: { files: 0, added: 0, removed: 0 } },
    ],
    notes: [
      { id: 'n1', text: 'Ask about the retry policy', isDone: false, at: NOW },
      { id: 'n2', text: 'Rename the config key', isDone: true, at: NOW - 1000 },
    ],
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [
        { path: 'src/app.ts', status: 'modified', added: 8, removed: 2 },
        { path: 'docs/new.md', status: 'added', added: 20, removed: 0 },
        { path: 'logo.png', status: 'modified', added: null, removed: null },
      ],
      selected: { path: 'src/app.ts', text: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same', omitted: 0 },
      at: NOW,
    },
    busy: null,
    clock: 0,
    dialog: null,
    focused: null,
    activity: {},
    answers: {},
    finished: [],
    expandedAgent: null,
    memory: null,
    memoryQuery: '',
    memoryScope: 'all',
    memoryOpen: null,
    memoryPage: 0,
    diffPage: 0,
    ...extra,
  }
  // A hook standing for the engine answers { value: <the event's result> }.
  // Another plugin's value is seeded as `<plugin>:<key>`.
  const versions: Record<string, number> = {}
  on('state.get', ($, e) => ({ value: { value: values[`${e.plugin}:${e.key}`] ?? values[e.key], version: versions[e.key] ?? 1 } as never }))
  if (options.isVersioned) {
    on('state.set', ($, e) => {
      const current = versions[e.key] ?? 1
      const wanted = (e as { ifVersion?: number }).ifVersion
      if (wanted !== undefined && wanted !== current) return { value: { isSet: false, version: current } as never }
      values[e.key] = e.value
      versions[e.key] = current + 1

      return { value: { isSet: true, version: current + 1 } as never }
    })
  }
  mock.clock(on, { now: NOW } as never)

  return values
}

export function mountPane($: Engine, surface: (typeof SURFACES)[number] | 'mobile', bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'sc-workspace',
    surface,
    component: 'Pane',
    requestId: 'sc-workspace',
    props: { title: 'Workspace', isFocused: true, bodyColumns, placement: 'dock' } as never,
  })
}
