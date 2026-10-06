import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * The engine beneath the accounts pane and band, for the tests that mount
 * them: the state store seeded with three accounts, the session, the clock,
 * and the props the engine draws the pane and the band with.
 */

export const paneProps = (bodyColumns: number) => ({ title: 'Claude', isFocused: true, bodyColumns, placement: 'dock' }) as never
export const SURFACES = ['terminal', 'desktop'] as const
export const STATUS = {
  updatedAt: 1,
  model: 'Opus 5.5',
  effort: 'low',
  ultracode: false,
  fast: true,
  contextUsed: 40,
  task: 'Writing tests',
  dir: 'claude-mods',
  branch: 'main',
  pr: { number: 12, reviewState: 'approved' },
  linesAdded: 3,
  linesRemoved: 1,
}
export const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns }) as never

/** Stands in for the engine's state store beneath the plugin, seeded with two accounts. */
export function seedState(on: On, extra: Record<string, unknown>, now?: number): void {
  const values: Record<string, unknown> = {
    accounts: [
      { uuid: 'u1', email: 'mina@example.com', savedAt: 0 },
      { uuid: 'u2', email: 'jun@example.org', savedAt: 0 },
      { uuid: 'u3', email: 'kai@example.net', savedAt: 0 },
    ],
    live: 'u1',
    usage: {
      u1: {
        limits: [
          { label: '5h', percent: 30, resetsAt: '2099-01-01T00:00:00Z' },
          { label: 'wk', percent: 45, resetsAt: '2099-01-03T01:59:59.8Z' },
          { label: 'Fable', percent: 0, resetsAt: '2099-01-03T02:00:00Z' },
        ],
        fetchedAt: 0,
        source: 'lookup',
      },
      u2: { limits: [], fetchedAt: 0, error: 'Login expired', source: 'lookup' },
      u3: { limits: [{ label: '5h', percent: 10 }], fetchedAt: 0, isStale: true, source: 'lookup' },
    },
    dialog: null,
    focused: null,
    isRefreshing: false,
    isGuideOpen: false,
    status: null,
    ...extra,
  }
  // A hook standing for the engine answers { value: <the event's result> }.
  // Another plugin's value is seeded as `<plugin>:<key>`.
  on('state.get', ($, e) => ({ value: { value: values[`${e.plugin}:${e.key}`] ?? values[e.key], version: 1 } as never }))
  // And takes what the plugin writes, as the engine's store does.
  on('state.set', ($, e) => {
    values[e.key] = e.value
    return { value: { isSet: true, version: 2 } as never }
  })
  // The session this pane is drawn in: a cleanup never deletes it.
  on('session.id', () => ({ value: 'this-session' as never }))
  // The session's own context reading.
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 40 }, rateLimits: [] } as never }))
  mock.clock(on, (now === undefined ? undefined : { now }) as never)
}

export function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120) {
  return $.ui.mount({ plugin: 'sc-accounts', surface, component: 'Pane', requestId: 'account-switch', props: paneProps(bodyColumns) })
}
