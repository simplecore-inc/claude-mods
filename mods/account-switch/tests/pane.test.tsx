import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const paneProps = (bodyColumns: number) => ({ title: 'Claude', isFocused: true, bodyColumns, placement: 'dock' }) as never
const SURFACES = ['terminal', 'desktop'] as const

/** Stands in for the engine's state store beneath the plugin, seeded with two accounts. */
function seedState(on: On, extra: Record<string, unknown>): void {
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
    pendingRemove: null,
    isRefreshing: false,
    isGuideOpen: false,
    status: null,
    ...extra,
  }
  // A hook standing for the engine answers { value: <the event's result> }.
  on('state.get', ($, e) => ({ value: { value: values[e.key], version: 1 } as never }))
  // The session's own context reading.
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 40 }, rateLimits: [] } as never }))
  mock.clock(on)
}

function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120) {
  return $.ui.mount({ plugin: 'sc', surface, component: 'Pane', requestId: 'account-switch', props: paneProps(bodyColumns) })
}

test('the pane offers switching only for the accounts not in use', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'use-u2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'SimpleCORE Mods' })).toBeDefined()
    // Every account is a card; the one in use is drawn in the accent color.
    expect((await ui.find({ key: 'row-u1' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect((await ui.find({ key: 'row-u2' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(await ui.find({ key: 'remove-u2' })).toBeDefined()
    expect((await ui.find({ key: 'use-u2' }))?.text).toBe('⇄')
    expect((await ui.find({ key: 'remove-u2' }))?.text).toBe('✕')
    expect(await ui.find({ key: 'use-u1' })).toBeUndefined()
    // The footer splits into three bordered, filled tiles, one button in each.
    for (const key of ['refresh', 'add', 'close']) {
      expect((await ui.find({ key: `tile-${key}` }))?.props).toMatchObject({ borderStyle: 'round', width: 39 })
      expect(await ui.find({ key })).toBeDefined()
      // Words alone: no glyph ahead of the label, no hotkey drawn beside it.
      expect((await ui.find({ key }))?.text).toMatch(/^[\p{L} ]+$/u)
    }
    expect(await ui.find({ key: 'guide' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Login expired/ })).toBeDefined()
    // A rate-limited account shows one mark and no words.
    expect((await ui.findAll({ type: 'Text', text: /^ ◷$/ })).length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /한도|limited/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^↻ .+ \(\d+d \d+h\)$/ })).toBeDefined()
    // Fable resets with the weekly window: one reset line for the two.
    expect((await ui.findAll({ type: 'Text', text: /^↻ / })).length).toBe(2)
    // ...and one cell: the weekly cell holds Fable's bar, so Fable has no cell of its own.
    expect(await ui.find({ key: 'u1-wk' })).toBeDefined()
    expect(await ui.find({ key: 'u1-Fable' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Fable / })).toBeDefined()
    await ui.unmount()
  }
})

test('a pending removal asks for confirmation and the guide shows every line', async ($, on) => {
  seedState(on, { pendingRemove: 'u2', isGuideOpen: true })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'confirm-u2' })).toBeDefined()
    // Icons alone: the confirming press is told apart by its question mark.
    expect((await ui.find({ key: 'confirm-u2' }))?.text).toBe('✕?')
    expect(await ui.find({ key: 'remove-u2' })).toBeUndefined()
    // Text carries no key, so the guide's last line is found by its words.
    expect(await ui.find({ type: 'Text', text: /Within a minute/ })).toBeDefined()
    await ui.unmount()
  }
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
  const band = (bodyColumns: number, hasSurvey = false) =>
    ({ hasSurvey, isWorking: false, maxRows: 10, bodyColumns }) as never
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc', surface, component: 'AbovePrompt', props: band(120) })
    expect((await ui.findAll({ type: 'Text', text: /^━+$/ })).length).toBeGreaterThan(0)
    expect(await ui.find({ type: 'Text', text: 'mina@example.com' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /jun@example/ })).toBeUndefined()
    expect(await ui.find({ key: 'status-row-1' })).toBeUndefined()
    await ui.unmount()
  }
  // Too narrow for both windows on one row: the weekly window wraps to a second row.
  const narrow = await $.ui.mount({ plugin: 'sc', surface: 'terminal', component: 'AbovePrompt', props: band(40) })
  expect(await narrow.find({ key: 'status-row-1' })).toBeDefined()
  await narrow.unmount()
})

test('with the status line command\'s forward, the band shows its line above the usage', async ($, on) => {
  seedState(on, {
    status: {
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
    },
  })
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as never
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc', surface, component: 'AbovePrompt', props })
    for (const text of ['Opus5.5', '○ low', '▶ fast', '‣ Writing tests', 'claude-mods', '◇ main', ' #12', '+3', '-1']) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    // Everything fits one line at this width, the session's context first.
    expect(await ui.find({ key: 'status-row-0' })).toBeDefined()
    expect(await ui.find({ key: 'status-row-1' })).toBeUndefined()
    // The context is a gauge like the usage bars: a label, thin bar cells, the percentage.
    expect(await ui.find({ type: 'Text', text: 'ctx ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 50%' })).toBeDefined()
    // The place sits at the end, right before the lines changed.
    const row = (await ui.find({ key: 'status-row-0' }))?.text ?? ''
    expect(row.indexOf('45%')).toBeGreaterThan(-1)
    expect(row.indexOf('claude-mods')).toBeGreaterThan(row.indexOf('45%'))
    expect(row.indexOf('claude-mods')).toBeLessThan(row.indexOf('+3'))
    // The context gauge sits right before the five-hour window, after the account.
    expect(row.indexOf('ctx')).toBeGreaterThan(row.indexOf('mina@example.com'))
    expect(row.indexOf('ctx')).toBeLessThan(row.indexOf('5h'))
    expect(row.indexOf('ctx')).toBeGreaterThan(row.indexOf('Opus5.5'))
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
  const ui = await $.ui.mount({ plugin: 'sc', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await ui.find({ key: 'status-row-0' })).toBeUndefined()
  await ui.unmount()
})
