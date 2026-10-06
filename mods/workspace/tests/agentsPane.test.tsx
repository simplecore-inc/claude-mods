import { expect, test } from 'claude-code/testing'

import { SURFACES, NOW, seedState, mountPane } from './paneHarness'

test('the agents tab: a running agent can be stopped, a merged clean worktree removed', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'stop-a1' })).toBeDefined()
    expect(await ui.find({ key: 'stop-a2' })).toBeUndefined()
    expect(await ui.find({ key: 'remove-worktree-/repo-merged' })).toBeDefined()
    expect(await ui.find({ key: 'remove-worktree-/repo-busy' })).toBeUndefined()
    expect(await ui.find({ key: 'remove-worktree-/repo' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /4 changed · ↑2/ })).toBeDefined()
    expect(await ui.find({ key: 'tile-refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('destructive buttons are one press each: the dialog does the asking', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'stop-a1' }))?.text).toBe('■')
  expect(await ui.find({ key: 'stop-a1-confirm' })).toBeUndefined()
  expect((await ui.find({ key: 'remove-worktree-/repo-merged' }))?.text).toBe('✕')
  await ui.unmount()
})

test('a running agent\'s elapsed time follows the agents clock tick', async ($, on) => {
  // firstSeen is five minutes before NOW; the tick says ten minutes have passed since.
  seedState(on, { clock: NOW + 10 * 60_000 })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /running · 15m/ })).toBeDefined()
  await ui.unmount()
})

test('an agent shows what it did last under its row', async ($, on) => {
  seedState(on, { activity: { a1: { text: 'Bash: npm test', isAnswer: false, at: NOW - 120_000 } } })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'activity-a1' }))?.text).toBe('↳ 2m ago · Bash: npm test')
  await ui.unmount()
})

test('a finished agent stays in its group with its answer, shown whole when opened', async ($, on) => {
  const done = { id: 'a9', stopIds: ['a9'], label: 'Summarise files', type: 'Explore', status: 'completed', firstSeen: NOW - 120_000, endedAt: NOW - 30_000, answer: 'Read 7 files.\nAll fine.' }
  seedState(on, { finished: [done], activity: { a9: { text: 'Read 7 files.', isAnswer: true, at: NOW - 30_000 } } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Finished' })).toBeDefined()
  expect((await ui.find({ key: 'answer-a9' }))?.text).toBe('▸')
  expect(await ui.find({ key: 'finished-activity-a9' })).toBeDefined()
  await ui.unmount()
})

test('a finished agent opened shows its answer whole', async ($, on) => {
  const done = { id: 'a9', stopIds: ['a9'], label: 'Summarise files', type: 'Explore', status: 'completed', firstSeen: NOW - 120_000, endedAt: NOW - 30_000, answer: 'Read 7 files.\nAll fine.' }
  seedState(on, { finished: [done], expandedAgent: 'a9' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'answer-a9' }))?.text).toBe('▾')
  expect((await ui.find({ type: 'Text', text: /All fine\.$/ }))?.text).toBe('Read 7 files.\nAll fine.')
  await ui.unmount()
})

test('another worktree\'s branch is a button; the main one is not', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'worktree-open-/repo-busy' })).toBeDefined()
  expect(await ui.find({ key: 'worktree-open-/repo' })).toBeUndefined()
  await ui.unmount()
})

test('stopping an agent names it by its id, and a stop refused says so instead of saying it stopped', async ($, on) => {
  seedState(on, { dialog: { kind: 'stop', ref: 'a1' } })
  const asked: string[] = []
  on('tool.call', ($, e) => {
    asked.push(String((e as { task_id?: unknown }).task_id))

    return { deny: 'Stopping is not allowed here' } as never
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined as never }
  })
  on('agent.list', () => ({ value: [] as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'dialog-confirm' })
  // Two agents may hold one name: the id names this one alone.
  expect(asked).toEqual(['a1'])
  expect(toasts.filter(text => /^Stopped/.test(text))).toEqual([])
  expect(toasts.some(text => text.includes('Stopping is not allowed here'))).toBe(true)
  await ui.unmount()
})

test('a stop the id does not reach is tried by the agent\'s name, and one that fails everywhere says so', async ($, on) => {
  seedState(on, { dialog: { kind: 'stop', ref: 'a1' } })
  const asked: string[] = []
  on('tool.call', ($, e) => {
    asked.push(String((e as { task_id?: unknown }).task_id))

    return { isError: true, result: undefined, text: 'No task found' } as never
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined as never }
  })
  on('agent.list', () => ({ value: [] as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'dialog-confirm' })
  expect(asked).toEqual(['a1', 'reviewer'])
  expect(toasts.filter(text => /^Stopped/.test(text))).toEqual([])
  expect(toasts.some(text => text.includes('No task found'))).toBe(true)
  await ui.unmount()
})
