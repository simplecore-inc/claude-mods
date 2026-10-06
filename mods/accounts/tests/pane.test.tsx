import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { look, pressedLook } from '../hooks/views/band'

const paneProps = (bodyColumns: number) => ({ title: 'Claude', isFocused: true, bodyColumns, placement: 'dock' }) as never
const SURFACES = ['terminal', 'desktop'] as const
const STATUS = {
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
const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns }) as never

/** Stands in for the engine's state store beneath the plugin, seeded with two accounts. */
function seedState(on: On, extra: Record<string, unknown>, now?: number): void {
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

function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120) {
  return $.ui.mount({ plugin: 'sc-accounts', surface, component: 'Pane', requestId: 'account-switch', props: paneProps(bodyColumns) })
}

test('the pane offers switching only for the accounts not in use', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'use-u2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    // Every account is a card; the one in use is drawn in the accent color.
    expect((await ui.find({ key: 'row-u1' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect((await ui.find({ key: 'row-u2' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(await ui.find({ key: 'remove-u2' })).toBeDefined()
    // Switching is a filled button with a word, not a glyph.
    expect((await ui.find({ key: 'use-u2' }))?.text).toBe('Switch')
    expect((await ui.find({ key: 'use-u2-tile' }))?.props).toMatchObject({ paddingX: 1, backgroundColor: '#1f4650' })
    expect((await ui.find({ key: 'remove-u2' }))?.text).toBe('✕')
    expect(await ui.find({ key: 'use-u1' })).toBeUndefined()
    // The account in use reads in its Active badge's colour; the others in the plain one.
    expect((await ui.findAll({ type: 'Text', text: 'mina@example.com' })).some(found => found.props.color === 'cyan' && found.props.bold === true)).toBe(true)
    expect((await ui.findAll({ type: 'Text', text: 'jun@example.org' })).some(found => found.props.color !== undefined)).toBe(false)
    // The footer splits into equal filled tiles, one button in each; Close is in the header.
    expect(await ui.find({ key: 'tile-close' })).toBeUndefined()
    expect(await ui.find({ key: 'header-exit-ground' })).toBeDefined()
    for (const key of ['refresh', 'add', 'webhook']) {
      // One row tall: a filled tile with no border.
      const tile = (await ui.find({ key: `tile-${key}` }))?.props
      expect(tile).toMatchObject({ width: 39 })
      expect(tile?.borderStyle).toBeUndefined()
      expect(tile?.backgroundColor).toBeDefined()
      expect(await ui.find({ key })).toBeDefined()
      // Words alone: no glyph ahead of the label, no hotkey drawn beside it.
      expect((await ui.find({ key }))?.text).toMatch(/^[\p{L} ]+$/u)
    }
    expect(await ui.find({ key: 'guide' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Login expired/ })).toBeDefined()
    // A rate-limited account shows one mark and no words.
    expect((await ui.findAll({ type: 'Text', text: /^ ◷$/ })).length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /한도|limited/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^↻ .+\(\d+d \d{2}h\)$/ })).toBeDefined()
    // Fable resets with the weekly window: one reset line for the two.
    expect((await ui.findAll({ type: 'Text', text: /^↻ / })).length).toBe(2)
    // ...and one cell: the weekly cell holds Fable's bar, so Fable has no cell of its own.
    expect(await ui.find({ key: 'u1-wk' })).toBeDefined()
    expect(await ui.find({ key: 'u1-Fable' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Fable / })).toBeDefined()
    await ui.unmount()
  }
})

test('the add guide shows every line', async ($, on) => {
  seedState(on, { isGuideOpen: true })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // Text carries no key, so the guide's last line is found by its words.
    expect(await ui.find({ type: 'Text', text: /Within a minute/ })).toBeDefined()
    await ui.unmount()
  }
})

test('removing an account asks in a dialog that names it, in place of the list', async ($, on) => {
  seedState(on, { dialog: { kind: 'remove', uuid: 'u2' } })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Remove jun@example.org?' })).toBeDefined()
    expect((await ui.find({ key: 'dialog-confirm' }))?.text).toBe('Remove')
    expect((await ui.find({ key: 'dialog' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'yellow' })
    expect(await ui.find({ key: 'row-u1' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the remove button is one press: the dialog does the asking', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'remove-u2' }))?.text).toBe('✕')
  expect(await ui.find({ key: 'remove-u2-confirm' })).toBeUndefined()
  await ui.unmount()
})

test('limit columns move to a new row only when the pane is too narrow', async ($, on) => {
  seedState(on, {})
  const wide = await mountPane($, 'terminal', 120)
  expect(await wide.find({ key: 'u1-limits-0' })).toBeDefined()
  expect(await wide.find({ key: 'u1-limits-1' })).toBeUndefined()
  await wide.unmount()
  const narrow = await mountPane($, 'terminal', 40)
  expect(await narrow.find({ key: 'u1-limits-1' })).toBeDefined()
  await narrow.unmount()
})

test('the band above the prompt shows the live account and its usage, left-aligned', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface, component: 'AbovePrompt', props: bandProps(120) })
    expect((await ui.findAll({ type: 'Text', text: /^━+$/ })).length).toBeGreaterThan(0)
    expect((await ui.find({ key: 'band-account' }))?.text).toBe('mina@example.com')
    expect((await ui.find({ key: 'status-row-0' }))?.text).not.toMatch(/jun@example/)
    expect(await ui.find({ key: 'status-row-1' })).toBeUndefined()
    await ui.unmount()
  }
  // Too narrow for both windows on one row: the weekly window wraps to a second row.
  const narrow = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(40) })
  expect(await narrow.find({ key: 'status-row-1' })).toBeDefined()
  await narrow.unmount()
})

test('with the accounts pane closed, pressing the account\'s name opens it with the keys; the context and the usage only show', async ($, on) => {
  seedState(on, { status: STATUS })
  on('ui.panes', () => ({ value: [] as never }))
  // Stands for the engine placing the pane.
  const opened: { id: string; focus?: boolean; title?: string }[] = []
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, focus: e.focus, title: e.title })
    return { value: { isPlaced: true } as never }
  })
  // Beneath the plugins: a press their hooks let through reaches here.
  const passedThrough: string[] = []
  on('ui.press', ($, e, next) => {
    passedThrough.push(e.element)
    return next(e)
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface, component: 'AbovePrompt', props: bandProps(160) })
    // The account's Button lies over its name, hidden until the pointer is on it, with the same text.
    const hidden = (await ui.findAll({ type: 'Box' })).filter(found => found.props.display === 'none')
    expect(hidden.map(found => found.props)).toContainEqual(expect.objectContaining({ position: 'absolute', top: 0, left: 0, display: 'none' }))
    expect(hidden.map(found => found.text)).toContain('mina@example.com')
    expect((await ui.find({ key: 'band-account' }))?.text).toBe('mina@example.com')
    // The name drawn beneath it, then the Button: the cell shows the same text twice in its tree.
    expect((await ui.find({ key: 'account' }))?.text).toBe('mina@example.commina@example.com')
    // The context and the usage take no press.
    for (const key of ['band-context', 'band-usage-5h', 'band-usage-wk']) expect(await ui.find({ key })).toBeUndefined()
    // The account keeps its colour and weight.
    const inked = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(found => found.props.color !== undefined)?.props
    expect(await inked('mina@example.com')).toMatchObject({ color: '#87afd7', bold: true })
    opened.length = 0
    // Taken by the ui.press hook, inside the person's press: the pane is asked for.
    expect(await ui.press({ key: 'band-account' })).toEqual({ element: 'band-account' })
    expect(opened).toEqual([{ id: 'account-switch', focus: true, title: 'Accounts' }])
    expect(passedThrough).toEqual([])
    await ui.unmount()
  }
})

test('with the accounts pane in view, pressing the band closes it', async ($, on) => {
  seedState(on, {})
  on('ui.panes', () => ({ value: [{ id: 'account-switch', isShown: true, isPlaced: true }] as never }))
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', ($, e, next) => {
    opened.push(e.id)
    return next(e)
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined as never }
  })
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
  await ui.press({ key: 'band-account' })
  expect(closed).toEqual(['account-switch'])
  expect(opened).toEqual([])
  await ui.unmount()
})

test('the lines changed are one filled block; with no workspace hook to take it, a press runs its toggle command', async ($, on) => {
  seedState(on, { status: { ...STATUS, linesAdded: 3677, linesRemoved: 511 } })
  const ran: string[] = []
  on('command.run', ($, e) => {
    ran.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
  // The counts on the block's ground, between its half blocks, green and red.
  // One Button per span, each drawn under the pointer as its span is at rest.
  expect((await ui.find({ key: 'lines' }))?.text).toBe('▐+3677 -511▌▐+3677 -511▌')
  const labels = async (key: string) => (await ui.findAll({ type: 'Button' })).filter(found => found.key?.startsWith(key)).map(found => found.text)
  expect(await labels('band-lines')).toEqual(['▐', '+3677', ' ', '-511', '▌'])
  const inked = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(found => found.props.color !== undefined)?.props
  expect(await inked('+3677')).toMatchObject({ color: '#00d787', bold: true, backgroundColor: '#303030' })
  expect(await inked('-511')).toMatchObject({ color: '#ff5f5f', bold: true, backgroundColor: '#303030' })
  await ui.press({ key: 'band-lines-1' })
  expect(ran).toEqual(['sc:workspace toggle diff'])
  // The place opens the workspace too; its Buttons spell the pill as the face does.
  expect((await ui.find({ key: 'place' }))?.text).toBe('▐claude-mods▌◇ main▌ #12✔'.repeat(2))
  expect(await labels('band-place')).toEqual(['▐', 'claude-mods', '▌', '◇ main', '▌', ' #12', '✔'])
  await ui.press({ key: 'band-place-1' })
  expect(ran).toEqual(['sc:workspace toggle diff', 'sc:workspace toggle diff'])
  await ui.unmount()
})

test('with the status line command\'s forward, the band shows its line above the usage', async ($, on) => {
  seedState(on, { status: STATUS })
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as never
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface, component: 'AbovePrompt', props })
    const row = (await ui.find({ key: 'status-row-0' }))?.text ?? ''
    for (const text of ['Opus5.5', '○ low', '▶ fast', '‣ Writing tests', 'claude-mods', '◇ main', ' #12', '+3', '-1']) {
      expect(row).toContain(text)
    }
    // Everything fits one line at this width.
    expect(await ui.find({ key: 'status-row-0' })).toBeDefined()
    expect(await ui.find({ key: 'status-row-1' })).toBeUndefined()
    // The context is a gauge like the usage bars: a label, thin bar cells, the percentage.
    expect(await ui.find({ type: 'Text', text: '▐ctx ━━━━━━ 50%▌' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 50%' })).toBeDefined()
    // The place sits at the end, right before the lines changed.
    expect(row.indexOf('45%')).toBeGreaterThan(-1)
    expect(row.indexOf('claude-mods')).toBeGreaterThan(row.indexOf('45%'))
    expect(row.indexOf('claude-mods')).toBeLessThan(row.indexOf('+3'))
    // The account leads, the model and effort come second, the task after them.
    expect(row.indexOf('mina@example.com')).toBe(row.search(/\S/))
    expect(row.indexOf('Opus5.5')).toBeGreaterThan(row.indexOf('mina@example.com'))
    expect(row.indexOf('‣ Writing tests')).toBeGreaterThan(row.indexOf('○ low'))
    // The context gauge sits right before the five-hour window, after the task.
    expect(row.indexOf('ctx')).toBeGreaterThan(row.indexOf('‣ Writing tests'))
    expect(row.indexOf('ctx')).toBeLessThan(row.indexOf('5h'))
    expect(await ui.find({ type: 'Text', text: /█|░/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with showStatusBand off, the band is left to the engine', { options: { showStatusBand: false } }, async ($, on) => {
  seedState(on, {})
  // Stands for the engine's own band beneath the plugin.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await ui.find({ key: 'status-row-0' })).toBeUndefined()
  await ui.unmount()
})

test('each account with figures says how long ago they were looked up', async ($, on) => {
  // The test clock stands at 0: u1 was looked up five minutes before, u3 half a minute before.
  seedState(on, {
    usage: {
      u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: -5 * 60_000, source: 'lookup' },
      u2: { limits: [], fetchedAt: -5 * 60_000, error: 'Login expired', source: 'lookup' },
      u3: { limits: [{ label: '5h', percent: 10 }], fetchedAt: -30_000, source: 'lookup' },
    },
  })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // u1 says it; u3, under a minute, and u2, with no figures to date, say nothing.
    const shown = await ui.findAll({ type: 'Text', text: /^ {2}\(updated .+ ago\)$/ })
    expect(shown.map(found => found.text)).toEqual(['  (updated 5m ago)'])
    await ui.unmount()
  }
})

for (const [where, pane] of [
  ['behind another pane\'s tab', { isShown: false, isPlaced: true }],
  ['waiting undrawn', { isShown: true, isPlaced: false }],
] as const) {
  test(`with the accounts pane ${where}, pressing the band opens it afresh, in front`, async ($, on) => {
    seedState(on, {})
    on('ui.panes', () => ({ value: [{ id: 'account-switch', ...pane }] as never }))
    const calls: string[] = []
    on('ui.open', ($, e) => {
      calls.push(`open ${e.id}`)
      return { value: { isPlaced: true } as never }
    })
    on('ui.close', ($, e) => {
      calls.push(`close ${e.id}`)
      return { value: undefined as never }
    })
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    await ui.press({ key: 'band-account' })
    expect(calls).toEqual(['close account-switch', 'open account-switch'])
    await ui.unmount()
  })
}

test('a pressable span\'s Button, revealed under the pointer, draws as the span does and never inverts', async () => {
  expect(pressedLook({ text: 'mina@example.com', color: '#87afd7', bold: true })).toEqual({ inverse: false, color: '#87afd7', bold: true })
  expect(pressedLook({ text: '+3', color: '#00d787', backgroundColor: '#303030', bold: true })).toEqual({ inverse: false, color: '#00d787', backgroundColor: '#303030', bold: true })
  expect(pressedLook({ text: ' ' })).toEqual({ inverse: false })
  // Nothing the face lacks: no underline.
  expect(look({ text: 'x', dimColor: true })).toEqual({ dimColor: true })
})

test('any Button of the account cell opens the pane, the stale mark beside the name included', async ($, on) => {
  seedState(on, { usage: { u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: 0, isStale: true, source: 'lookup' } } })
  on('ui.panes', () => ({ value: [] as never }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
  expect((await ui.find({ key: 'band-account-1' }))?.text).toBe(' ◷')
  expect(await ui.press({ key: 'band-account-1' })).toEqual({ element: 'band-account-1' })
  expect(opened).toEqual(['account-switch'])
  await ui.unmount()
})

test('a dim rule as wide as the band sits above its rows', async ($, on) => {
  seedState(on, {})
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(60) })
  const rule = await ui.find({ type: 'Text', text: /^─+$/ })
  expect(rule?.text).toBe('─'.repeat(60))
  expect(rule?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('the webhook dialog: the switch, the method, the URL, the token, the template file and what is sent now', async ($, on) => {
  seedState(on, {
    status: STATUS,
    dialog: { kind: 'webhook' },
    webhookDraft: { enabled: true, url: '', method: 'POST', token: '', hasToken: false, clearToken: false },
    webhookLast: null,
  })
  // Stand for the engine beneath: the template file, the session's model and folder.
  on('fs.exists', () => ({ value: true as never }))
  on('fs.read', () => ({ value: '{"session_id": "{{session}}", "ctx": "{{context}}"}' as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' as never }))
  on('session.cwd', () => ({ value: '/work/claude-mods' as never }))
  on('env.get', ($, e) => ({ value: (e.name === 'HOME' ? '/home/me' : undefined) as never }))
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Webhook' })).toBeDefined()
  expect((await ui.find({ key: 'webhook-enabled-on' }))?.text).toBe('On')
  expect((await ui.find({ key: 'webhook-method-on' }))?.text).toBe('POST')
  expect((await ui.find({ key: 'webhook-method-off' }))?.text).toBe('GET')
  // When it sends, in the numbers the feed uses.
  expect(await ui.find({ type: 'Text', text: /every 30 seconds while nothing changes\. Never twice within 2 seconds\.$/ })).toBeDefined()
  expect(await ui.find({ key: 'webhook-url-input' })).toBeDefined()
  expect(await ui.find({ key: 'webhook-token-input' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'none' })).toBeDefined()
  // An empty URL with the feed on says what is wrong before saving.
  expect(await ui.find({ type: 'Text', text: 'Enter the URL to send to.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sc-accounts\/webhook\.json$/ })).toBeDefined()
  // The preview is the template filled now, indented.
  expect(await ui.find({ type: 'Text', text: '  "ctx": 40' })).toBeDefined()
  for (const key of ['dialog-confirm', 'webhook-test', 'dialog-cancel']) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ key: 'tabs' })).toBeUndefined()
  await ui.unmount()
})

test('alone, the pane\'s header names it: [SC] Accounts', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  await ui.unmount()
})

test('beside the workspace, the header still names the pane, a row below the engine\'s tabs', async ($, on) => {
  seedState(on, { 'sc-workspace:paneOpen': true })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('alone, the header names the pane on the first row', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

for (const [who, configured, isFiled] of [
  ['the login this session knows', 'u1', true],
  ['a login another session switched to', 'u2', false],
] as const) {
  test(`a response measured under ${who} is ${isFiled ? '' : 'never '}filed under the live account`, async ($, on) => {
    // The turn starts after the live account last changed (at 0), as a turn after a switch does.
    seedState(on, {}, 60_000)
    // Stand for the engine beneath: Claude Code's config names the login its requests use.
    on('env.get', ($, e) => ({ value: (e.name === 'HOME' ? '/home/me' : undefined) as never }))
    on('fs.read', () => ({ value: JSON.stringify({ oauthAccount: { accountUuid: configured, emailAddress: 'x@example.com' } }) as never }))
    const stored: string[] = []
    on('store.set', ($, e) => {
      stored.push(e.key)
      return { value: undefined as never }
    })
    on('store.get', () => ({ value: undefined as never }))
    on('session.measure', ($, e) => ({ changed: e.changed }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
    on('ui.log', () => ({ value: undefined as never }))
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never).catch(() => undefined)
    await $.session.measure({
      context: { window: 200_000, percent: 40 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2099-01-01T00:00:00Z' }],
      changed: ['rateLimits'],
    } as never)
    expect(stored.includes('usage')).toBe(isFiled)
  })
}

test('the pane has two tabs, Accounts with the count of accounts and Usage', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'tab-accounts' }))?.text).toMatch(/Accounts 3/)
  expect(await ui.find({ key: 'tab-usage' })).toBeDefined()
  await ui.unmount()
})

test('an account shows what it spent past the plan only when the endpoint reported it', async ($, on) => {
  seedState(on, {
    usage: {
      u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: 0, source: 'lookup', spend: { used: { minor: 1234, currency: 'USD', exponent: 2 }, limit: { minor: 5000, currency: 'USD', exponent: 2 } } },
      u2: { limits: [{ label: '5h', percent: 10 }], fetchedAt: 0, source: 'lookup' },
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Spent past the plan: 12.34 USD of 50.00 USD' })).toBeDefined()
  // One line in all: the account the endpoint reported no spend for has none.
  expect(await ui.findAll({ type: 'Text', text: /^Spent past the plan/ })).toHaveLength(1)
  await ui.unmount()
})

test('the Usage tab shows the period, the totals, a bar per day and the top models and projects', async ($, on) => {
  const tokens = (n: number) => ({ input: n, output: n, cacheRead: n * 10, cacheWrite: n, responses: 1 })
  seedState(on, {
    tab: 'usage',
    usagePeriod: 7,
    usageScan: null,
    usageError: null,
    usageSummary: {
      totals: tokens(100),
      daily: ['2026-10-01', '2026-10-02', '2026-10-03'].map((day, index) => ({ day, tokens: tokens(index * 10) })),
      models: [{ name: 'claude-opus-5-5', tokens: tokens(80), sessions: 3 }],
      projects: [{ name: 'claude-mods', tokens: tokens(60), sessions: 2 }],
      sessions: 4,
    },
  })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'usage-period-field' }))?.text).toBe('Last 7 days ▾')
    expect(await ui.find({ type: 'Text', text: '1.0k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4 sessions · 1 responses' })).toBeDefined()
    expect(await ui.find({ key: 'usage-chart' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'claude-mods' })).toBeDefined()
    // The Usage tab's footer: refresh the count, close.
    expect(await ui.find({ key: 'add' })).toBeUndefined()
    await ui.unmount()
  }
})

test('while the transcripts are counted the Usage tab says how far it has got', async ($, on) => {
  seedState(on, { tab: 'usage', usagePeriod: 30, usageSummary: null, usageScan: { done: 40, total: 2368 }, usageError: null })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Counting transcripts… 40 of 2368 files' })).toBeDefined()
  await ui.unmount()
})

test('the period dialog offers seven days, thirty and everything, the one in use first in focus', async ($, on) => {
  seedState(on, { tab: 'usage', usagePeriod: 30, dialog: { kind: 'period' } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Show usage for' })).toBeDefined()
  expect((await ui.find({ key: 'period-30' }))?.props).toMatchObject({ autoFocus: true })
  expect(await ui.find({ key: 'period-7' })).toBeDefined()
  expect(await ui.find({ key: 'period-0' })).toBeDefined()
  await ui.unmount()
})

test('the Storage tab shows the transcripts by kind and project, Claude Code\'s own cleanup, and what a cleanup takes', async ($, on) => {
  seedState(on, {
    tab: 'storage',
    cleanupDays: 30,
    storage: {
      bytes: 17 * 1024 ** 3,
      transcripts: { count: 2370, bytes: 4 * 1024 ** 3 },
      subagents: { count: 1373, bytes: 12 * 1024 ** 3 },
      other: { count: 4600, bytes: 1024 ** 3 },
      sessions: 2370,
      projects: [{ folder: '-Users-u-Workspace-slideglance', name: 'slideglance', bytes: 9 * 1024 ** 3, sessions: 899, lastActive: 0 }],
      folders: [{ name: 'jobs', bytes: 1.7 * 1024 ** 3 }],
      autoDays: 30,
      isAutoDefault: true,
      root: '~/.claude',
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'tab-storage' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12.0 GB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /deletes sessions idle over 30 days on its own \(the default\)/ })).toBeDefined()
  expect((await ui.find({ key: 'cleanup-days-field' }))?.text).toBe('30 days ▾')
  expect(await ui.find({ key: 'cleanup' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'slideglance' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'jobs' })).toBeDefined()
  await ui.unmount()
})

test('the cleanup dialog deletes only when the word is typed, and says what is deleted and what stays', async ($, on) => {
  seedState(on, { tab: 'storage', cleanupDays: 30, dialog: { kind: 'cleanup' } })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined as never }
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Delete 0 sessions/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cannot be undone/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Type delete and press Enter to delete them.' })).toBeDefined()
  // No button deletes: the confirmation is the typed word.
  expect(await ui.find({ key: 'dialog-confirm' })).toBeUndefined()
  await ui.input({ key: 'cleanup-word', text: 'yes' })
  expect(toasts).toContain('Nothing was deleted: type delete exactly to confirm.')
  await ui.unmount()
})

test('on mobile, with no field, the cleanup dialog says where to clean up instead', async ($, on) => {
  seedState(on, { tab: 'storage', cleanupDays: 30, dialog: { kind: 'cleanup' } })
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'mobile', component: 'Pane', requestId: 'account-switch', props: paneProps(60) })
  expect(await ui.find({ key: 'cleanup-word' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /terminal or the desktop app/ })).toBeDefined()
  await ui.unmount()
})

test('every gauge takes the same width on every card, whether a reset line shows under it or not', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  // mina's 5h shows a reset line; kai's does not.
  const minaFive = await ui.find({ key: 'u1-5h-slot' })
  const kaiFive = await ui.find({ key: 'u3-5h-slot' })
  expect(minaFive?.props.width).toBeGreaterThan(0)
  expect(kaiFive?.props.width).toBe(minaFive?.props.width)
  // wk and Fable reset together: one block, the gauges side by side with no slot between them.
  expect(await ui.find({ key: 'u1-wk-slot' })).toBeUndefined()
  expect((await ui.find({ key: 'u1-wk' }))?.props.width).toBe(2 * Number(minaFive?.props.width ?? 0) + 3)
  await ui.unmount()
})

test('on the day a weekly window resets, its reset reads red; the five-hour window\'s stays dim', async ($, on) => {
  // Two hours before the weekly reset, whatever the machine's time zone: the same local day.
  seedState(on, {}, Date.parse('2099-01-03T00:00:00Z'))
  const ui = await mountPane($, 'terminal')
  const resets = await ui.findAll({ type: 'Text', text: /^↻ / })
  const weekly = resets.find(found => /\(1h|\(2h/.test(found.text ?? ''))
  expect(weekly?.props).toMatchObject({ color: 'red', bold: true })
  expect(resets.filter(found => found.props.color === undefined && found.props.dimColor === true).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('Switch asks first, Cancel holding the keyboard, so a stray Enter never changes every session\'s login', async ($, on) => {
  seedState(on, {})
  const switched: unknown[] = []
  on('process.run', ($, e) => {
    switched.push(e.argv)
    return { value: { exitCode: 1, stdout: '', stderr: '' } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'use-u2' })
  await ui.unmount()
  // The press leaves the dialog to draw and touches no login.
  const after = await mountPane($, 'terminal')
  expect(await after.find({ type: 'Text', text: 'Switch to jun@example.org?' })).toBeDefined()
  expect(switched).toEqual([])
  await after.unmount()
})

test('the switch dialog names the account and focuses Cancel first', async ($, on) => {
  seedState(on, { dialog: { kind: 'switch', uuid: 'u2' } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Switch to jun@example.org?' })).toBeDefined()
  expect((await ui.find({ key: 'dialog-cancel' }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ key: 'dialog-confirm' }))?.props.autoFocus).toBeUndefined()
  await ui.unmount()
})
