import { expect, test } from 'claude-code/testing'

import { paneProps, SURFACES, seedState, mountPane } from './paneHarness'

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
