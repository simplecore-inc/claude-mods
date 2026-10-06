import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * The engine beneath the toolbox pane, for the tests that mount it: the
 * state store seeded with a tool of each kind and a running shell tool, the
 * clock, and the props the engine draws the pane with.
 */

export const NOW = Date.parse('2026-10-05T05:00:00Z')
export const TOOLS = [
  { id: 'dev', name: 'dev server', kind: 'shell', run: 'pnpm run dev' },
  { id: 'test', name: 'test one', kind: 'shell', run: 'pnpm vitest {{file}}', params: { file: { type: 'path', mode: 'ask' } } },
  { id: 'clear', name: '/clear', kind: 'claude', run: '/clear' },
  { id: 'review', name: 'review', kind: 'prompt', run: 'Review {{file}}' },
]

/**
 * Stands in for the engine's state store beneath the plugin. With `isWritable`
 * the plugin's writes land in it, so a press that opens a dialog shows it at
 * the next mount.
 */
export function seedState(on: On, extra: Record<string, unknown>, options: { isWritable?: boolean } = {}): { values: Record<string, unknown>; clock: MockClock } {
  const values: Record<string, unknown> = {
    tab: 'tools',
    tools: TOOLS,
    toolsError: null,
    runs: { dev: { state: 'running', startedAt: NOW - 90_000, command: 'pnpm run dev' } },
    logTick: 0,
    detected: null,
    unreadable: [],
    commands: null,
    addQuery: '',
    dialog: null,
    draft: {},
    suggest: null,
    follow: true,
    focused: null,
    ...extra,
  }
  on('state.get', ($, e) => ({ value: { value: values[e.key], version: 1 } as never }))
  if (options.isWritable) {
    on('state.set', ($, e) => {
      values[e.key] = e.value

      return { value: { isSet: true, version: 2 } as never }
    })
  }
  const clock = mock.clock(on, { now: NOW } as never)

  return { values, clock }
}

export function mountPane($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal', bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'sc-toolbox',
    surface,
    component: 'Pane',
    requestId: 'sc-toolbox',
    props: { title: 'Toolbox', isFocused: true, bodyColumns, placement: 'dock' } as never,
  })
}

export async function openQuick($: Engine, on: On) {
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  await $.command.run({ command: 'sc:toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
}
