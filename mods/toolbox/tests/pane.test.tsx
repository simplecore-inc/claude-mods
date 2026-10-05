import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-05T05:00:00Z')
const TOOLS = [
  { id: 'dev', name: 'dev server', kind: 'shell', run: 'pnpm run dev' },
  { id: 'test', name: 'test one', kind: 'shell', run: 'pnpm vitest {{file}}', params: { file: { type: 'path', mode: 'ask' } } },
  { id: 'clear', name: '/clear', kind: 'claude', run: '/clear' },
  { id: 'review', name: 'review', kind: 'prompt', run: 'Review {{file}}' },
]

function seedState(on: On, extra: Record<string, unknown>): void {
  const values: Record<string, unknown> = {
    tab: 'tools',
    tools: TOOLS,
    toolsError: null,
    runs: { dev: { state: 'running', startedAt: NOW - 90_000, command: 'pnpm run dev' } },
    logTick: 0,
    detected: null,
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
  mock.clock(on, { now: NOW } as never)
}

function mountPane($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal', bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'sc-toolbox',
    surface,
    component: 'Pane',
    requestId: 'sc-toolbox',
    props: { title: 'Toolbox', isFocused: true, bodyColumns, placement: 'dock' } as never,
  })
}

test('the tools list groups shell commands, Claude commands and prompts; a running one offers stop and its log', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($)
  for (const title of ['Shell', 'Claude commands', 'Prompts']) expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  expect(await ui.find({ key: 'tool-stop-dev' })).toBeDefined()
  expect(await ui.find({ key: 'tool-run-dev' })).toBeUndefined()
  expect(await ui.find({ key: 'tool-log-dev' })).toBeDefined()
  expect(await ui.find({ key: 'tool-run-test' })).toBeDefined()
  // A Claude command or a prompt has no log of its own.
  expect(await ui.find({ key: 'tool-log-clear' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^running · 1m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'asks at each run' })).toBeDefined()
  await ui.unmount()
})

test('the Add tab lists the project build tasks by ecosystem and Claude commands, each to add', async ($, on) => {
  seedState(on, {
    tab: 'add',
    detected: [
      { source: 'npm', name: 'build', run: 'pnpm run build', description: 'vite build' },
      { source: 'gradle', name: 'test', run: './gradlew test' },
    ],
    commands: [{ name: 'clear', description: 'Clear the conversation', source: 'builtin' }],
  })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'From this project' })).toBeDefined()
  expect(await ui.find({ key: 'add-source-npm-rows-0-open' })).toBeDefined()
  expect(await ui.find({ key: 'add-claude-rows-0-open' })).toBeDefined()
  expect(await ui.find({ key: 'add-gradle-all' })).toBeDefined()
  expect(await ui.find({ key: 'add-search' })).toBeDefined()
  await ui.unmount()
})

async function openQuick($: Engine, on: On) {
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  await $.command.run({ command: 'sc:toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
}

test('the quick view boxes the tools two to a row, apart from Settings and Close; a running tool shows its state, stop and log', async ($, on) => {
  seedState(on, {})
  await openQuick($, on)
  const ui = await mountPane($, 'terminal', 80)
  expect(await ui.find({ key: 'quick-card' })).toBeDefined()
  const row = await ui.find({ key: 'status-row-0' })
  expect(row?.children?.length).toBe(2)
  expect(await ui.find({ key: 'quick-stop-dev' })).toBeDefined()
  expect(await ui.find({ key: 'quick-log-dev' })).toBeDefined()
  expect(await ui.find({ key: 'quick-stop-test' })).toBeUndefined()
  expect(await ui.find({ key: 'quick-dev-status' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 running' })).toBeDefined()
  expect(await ui.find({ key: 'quick-settings' })).toBeDefined()
  await ui.unmount()
})

test('a tool set to ask first asks before it runs', async ($, on) => {
  seedState(on, { tools: [{ id: 'clear', name: '/clear', kind: 'claude', run: '/clear', confirm: true }], runs: {}, dialog: { kind: 'confirm', id: 'clear' } })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Run /clear?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Asked each time, as this command cannot be taken back.' })).toBeDefined()
  await ui.unmount()
})

test('a shell tool that has run opens its log when pressed and runs again from its play button', async ($, on) => {
  seedState(on, { runs: { dev: { state: 'failed', startedAt: NOW - 9_000, endedAt: NOW - 5_000, code: 2, command: 'pnpm run dev' } } })
  await openQuick($, on)
  const ui = await mountPane($, 'terminal', 80)
  expect(await ui.find({ key: 'quick-run-dev' })).toBeDefined()
  expect(await ui.find({ key: 'quick-log-dev' })).toBeDefined()
  expect(await ui.find({ key: 'quick-stop-dev' })).toBeUndefined()
  // A tool never run has no log to open: pressing it runs it.
  expect(await ui.find({ key: 'quick-run-test' })).toBeUndefined()
  await ui.unmount()
})
