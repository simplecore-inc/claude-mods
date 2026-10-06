import { expect, test } from 'claude-code/testing'

import { mountPane, NOW, openQuick, seedState } from './paneHarness'

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

test('off fullscreen the first command that opens the pane says clicks need fullscreen, and only once', async ($, on) => {
  seedState(on, {})
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  const typed = (isFullscreen: boolean) => ({ command: 'sc:toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen, columns: 100 } }) as never
  expect((await $.command.run(typed(true))).text).toBe('Opened the toolbox.')
  expect((await $.command.run(typed(false))).text).toMatch(/^Opened the toolbox\. Clicks reach the panes only in fullscreen mode/)
  expect((await $.command.run(typed(false))).text).toBe('Opened the toolbox.')
})

test('opening the toolbox from its command drops a dialog an earlier draw left, so the tools show', async ($, on) => {
  seedState(on, { dialog: { kind: 'log', id: 'dev' } })
  const writes: { key: string; value: unknown }[] = []
  on('state.set', ($, e) => {
    writes.push({ key: e.key, value: e.value })

    return { value: { isSet: true, version: 2 } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  await $.command.run({ command: 'sc:toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  expect(writes).toContainEqual({ key: 'dialog', value: null })
})

test('Enter in a value field runs the tool with what was typed in it', async ($, on) => {
  const { values } = seedState(on, { dialog: { kind: 'ask', id: 'test' }, draft: {} }, { isWritable: true })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  on('fs.exists', () => ({ value: false as never }))
  on('fs.write', () => ({ value: undefined as never }))
  const ui = await mountPane($)
  await $.ui.input({ plugin: 'sc-toolbox', key: 'field-file', text: 'src/a.test.ts' })
  await ui.unmount()
  // The run as it started, its value filled in: what Enter submitted, not the field as it stood before.
  expect((values.runs as Record<string, { command: string }>).test?.command).toBe('pnpm vitest src/a.test.ts')
})

test('a prompt tool puts its text at the cursor, so what the person was typing stays', async ($, on) => {
  seedState(on, { tools: [{ id: 'note', name: 'note', kind: 'prompt', run: 'Check the retry policy' }], runs: {} })
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.mode)

    return { isFilled: true } as never
  })
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($)
  await ui.press({ key: 'tool-run-note' })
  expect(filled).toEqual(['insert'])
  await ui.unmount()
})

test('a Claude command pressed again while it waits is not queued a second time, and its end is on the session\'s clock', async ($, on) => {
  const { values, clock } = seedState(on, { tools: [{ id: 'compact', name: '/compact', kind: 'claude', run: '/compact' }], runs: {} }, { isWritable: true })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined as never }
  })
  let finish: () => void = () => undefined
  const asked: string[] = []
  on('command.run', ($, e) => {
    asked.push(e.command)

    return new Promise(resolve => {
      finish = () => resolve({ text: '' } as never)
    })
  })
  const ui = await mountPane($)
  await ui.press({ key: 'tool-run-compact' })
  await ui.press({ key: 'tool-run-compact' })
  expect(asked).toEqual(['compact'])
  expect(toasts.some(text => /already waiting/.test(text))).toBe(true)
  finish()
  await clock.settle()
  expect((values.runs as Record<string, { state: string; endedAt?: number }>).compact).toMatchObject({ state: 'done', endedAt: NOW })
  await ui.unmount()
})

test('removing a tool from the pane keeps a tool added to the file since the pane read it', async ($, on) => {
  const dev = { id: 'dev', name: 'dev server', kind: 'shell', run: 'pnpm run dev' }
  seedState(on, { tools: [dev], runs: {}, dialog: { kind: 'remove', id: 'dev' } }, { isWritable: true })
  const files: Record<string, string> = {
    '/.toolbox/toolbox.json': JSON.stringify({ version: 1, tools: [dev, { id: 'lint', name: 'lint', kind: 'shell', run: 'pnpm lint' }] }),
  }
  on('fs.exists', ($, e) => ({ value: (e.path in files) as never }))
  on('fs.read', ($, e) => ({ value: (files[e.path] ?? '') as never }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text

    return { value: undefined as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($)
  await ui.press({ key: 'dialog-confirm' })
  await ui.unmount()
  expect(JSON.parse(files['/.toolbox/toolbox.json'] ?? '{}').tools.map((tool: { id: string }) => tool.id)).toEqual(['lint'])
})

test('the Add tab reads pnpm\'s workspace packages, and names a package.json it could not read', async ($, on) => {
  const { values } = seedState(on, { tab: 'add' }, { isWritable: true })
  const files: Record<string, string> = {
    '/package.json': '{ "name": "root", "scripts": { "dev": "vite" }, }',
    '/pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    '/pnpm-lock.yaml': '',
    '/apps/web/package.json': JSON.stringify({ name: '@x/web', scripts: { test: 'vitest' } }),
  }
  on('fs.exists', ($, e) => ({ value: (e.path in files || Object.keys(files).some(path => path.startsWith(`${e.path}/`))) as never }))
  on('fs.read', ($, e) => ({ value: (files[e.path] ?? '') as never }))
  on('fs.list', ($, e) => ({ value: (e.path === '/apps' ? [{ name: 'web', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : []) as never }))
  on('command.list', () => ({ value: [] as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  await $.command.run({ command: 'sc:toolbox', args: 'add', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  expect((values.detected as { name: string; run: string }[]).map(task => [task.name, task.run])).toContainEqual(['test (@x/web)', 'pnpm run test'])
  expect(values.unreadable).toEqual(['package.json'])
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Could not read package\.json/ })).toBeDefined()
  await ui.unmount()
})
