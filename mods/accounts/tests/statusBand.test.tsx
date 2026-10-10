import { expect, test } from 'claude-code/testing'

import { look } from '../hooks/views/band'
import { SURFACES, STATUS, bandProps, seedState } from './paneHarness'

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

test('a remote surface wraps the band itself, under no rule; the terminal packs rows to its cells under one', async ($, on) => {
  seedState(on, { status: STATUS })
  // Narrow enough that the terminal needs a second row.
  const desktop = await $.ui.mount({ plugin: 'sc-accounts', surface: 'desktop', component: 'AbovePrompt', props: bandProps(40) })
  expect(await desktop.find({ type: 'Text', text: /^─+$/ })).toBeUndefined()
  const flow = await desktop.find({ key: 'status-row-0' })
  expect(flow?.props).toMatchObject({ flexWrap: 'wrap' })
  expect(flow?.children?.length).toBeGreaterThan(3)
  for (const child of flow?.children ?? []) expect(child.props).toMatchObject({ flexShrink: 0 })
  expect(await desktop.find({ key: 'status-row-1' })).toBeUndefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(40) })
  expect((await terminal.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(40))
  expect((await terminal.find({ key: 'status-row-0' }))?.props.flexWrap).toBeUndefined()
  expect(await terminal.find({ key: 'status-row-1' })).toBeDefined()
  await terminal.unmount()
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
    // The account's cell is one Button holding its name in its own colour and weight, nothing hidden over it.
    expect((await ui.find({ key: 'band-account' }))?.type).toBe('Button')
    expect((await ui.find({ key: 'band-account' }))?.text).toBe('mina@example.com')
    expect((await ui.findAll({ type: 'Box' })).filter(found => found.props.display === 'none')).toEqual([])
    const inked = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(found => found.props.color !== undefined)?.props
    expect(await inked('mina@example.com')).toMatchObject({ color: '#87afd7', bold: true })
    // The context and the usage take no press.
    for (const key of ['band-context', 'band-usage-5h', 'band-usage-wk']) expect(await ui.find({ key })).toBeUndefined()
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
  // The counts on the block's ground, between its half blocks, green and red: one Button, one press.
  expect((await ui.find({ key: 'lines' }))?.text).toBe('▐+3677 -511▌')
  expect((await ui.find({ key: 'band-lines' }))?.text).toBe('▐+3677 -511▌')
  const inked = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(found => found.props.color !== undefined)?.props
  expect(await inked('+3677')).toMatchObject({ color: '#00d787', bold: true, backgroundColor: '#303030' })
  expect(await inked('-511')).toMatchObject({ color: '#ff5f5f', bold: true, backgroundColor: '#303030' })
  await ui.press({ key: 'band-lines' })
  expect(ran).toEqual(['sc:workspace toggle diff'])
  // The place opens the workspace too, the pill and the PR in one Button.
  expect((await ui.find({ key: 'band-place' }))?.text).toBe('▐claude-mods▌◇ main▌ #12✔')
  await ui.press({ key: 'band-place' })
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
    // Rounded off by half blocks on the cell grid, by spaces of its ground elsewhere.
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? '▐ctx ━━━━━━ 50%▌' : ' ctx ━━━━━━ 50% ' })).toBeDefined()
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

test('a span\'s look carries only what the span sets', async () => {
  expect(look({ text: '+3', color: '#00d787', backgroundColor: '#303030', bold: true })).toEqual({ color: '#00d787', backgroundColor: '#303030', bold: true })
  // Nothing the span lacks: no underline.
  expect(look({ text: 'x', dimColor: true })).toEqual({ dimColor: true })
})

test('off the cell grid the place, the lines and the toolbox are one Button each; pills and grounds open and close on spaces, no half block', async ($, on) => {
  seedState(on, { status: STATUS })
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as never
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'desktop', component: 'AbovePrompt', props })
  expect((await ui.find({ key: 'band-place' }))?.text).toBe(' claude-mods ◇ main  #12✔')
  expect((await ui.find({ key: 'band-lines' }))?.text).toBe(' +3 -1 ')
  expect((await ui.find({ key: 'band-toolbox' }))?.text).toBe(' ⚒ Toolbox ')
  expect(await ui.find({ type: 'Text', text: /[▐▌]/ })).toBeUndefined()
  expect((await ui.find({ key: 'status-cell-model' }))?.text).toMatch(/^ Opus5\.5 .* $/)
  await ui.unmount()
})

test('the account\'s Button opens the pane, the stale mark beside the name inside it', async ($, on) => {
  seedState(on, { usage: { u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: 0, isStale: true, source: 'lookup' } } })
  on('ui.panes', () => ({ value: [] as never }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
  expect((await ui.find({ key: 'band-account' }))?.text).toBe('mina@example.com ◷')
  expect(await ui.press({ key: 'band-account' })).toEqual({ element: 'band-account' })
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
