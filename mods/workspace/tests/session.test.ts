import { expect, test } from 'claude-code/testing'

import { fakeRepo } from './repoMachine'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const typed = (args: string) => ({ command: 'sc:workspace', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } }) as never

test('a project\'s notes and checkpoints are kept in files under its git folder, never in the plugin store', async ($, on) => {
  const repo = fakeRepo(on)
  await $.session.start(START as never)
  expect(repo.list('checkpoints')?.map(row => row.kind)).toEqual(['session'])
  await $.command.run(typed('notes ask about the retry policy'))
  expect(repo.list('notes')?.map(note => note.text)).toEqual(['ask about the retry policy'])
  expect(repo.storeWrites).toEqual([])
})

test('notes and checkpoints the plugin store held move to their files once, and leave the store', async ($, on) => {
  const old = [{ id: 'n0', text: 'kept from before', isDone: false, at: 1, seq: 1 }]
  const repo = fakeRepo(on, { store: { 'notes:/repo': old, 'checkpoints:/repo': [] } })
  await $.session.start(START as never)
  expect(repo.list('notes')?.map(note => note.text)).toEqual(['kept from before'])
  expect(Object.keys(repo.store)).toEqual([])
})

test('a note another session wrote to the file is kept when this one adds one', async ($, on) => {
  const repo = fakeRepo(on)
  await $.session.start(START as never)
  // Another session of this project adds a note after this one read the file.
  repo.files['/repo/.git/sc-workspace/notes--repo.json'] = JSON.stringify([{ id: 'other', text: 'from the other session', isDone: false, at: 2, seq: 1 }])
  await $.command.run(typed('notes mine'))
  expect(repo.list('notes')?.map(note => note.text)).toEqual(['mine', 'from the other session'])
})

test('two checkpoints taken at once are numbered apart', async ($, on) => {
  const repo = fakeRepo(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start(START as never)
  repo.tree.isChanging = true
  await Promise.all([$.turn.start({ text: 'first', turnId: 't1' } as never), $.turn.start({ text: 'second', turnId: 't2' } as never)])
  const refs = (repo.list('checkpoints') as { ref: string }[]).map(row => row.ref)
  expect(refs).toHaveLength(3)
  expect(new Set(refs).size).toBe(3)
})

test('the changes since each checkpoint are counted again only when the working tree or the checkpoints changed', async ($, on) => {
  const repo = fakeRepo(on)
  await $.session.start(START as never)
  const counts = () => repo.runs.filter(argv => argv.includes('--numstat')).length
  await $.command.run(typed('checkpoints'))
  const first = counts()
  expect(first).toBeGreaterThan(0)
  await $.command.run(typed('checkpoints'))
  expect(counts()).toBe(first)
  repo.tree.name = 'tree2'
  await $.command.run(typed('checkpoints'))
  expect(counts()).toBeGreaterThan(first)
})

test('the Memory tab reads the memory files when it opens and when Refresh is pressed, never on the five-second beat', async ($, on) => {
  const repo = fakeRepo(on)
  await $.session.start(START as never)
  const listings = () => repo.runs.filter(argv => argv[0] === 'git' && argv[1] === 'ls-files').length
  await $.command.run(typed('memory'))
  const opened = listings()
  expect(opened).toBe(1)
  await repo.clock.advance(16_000)
  expect(listings()).toBe(opened)
})

test('the Diff tab stamps its comparison with the session\'s clock', async ($, on) => {
  const repo = fakeRepo(on)
  const stamps: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.key === 'diff' && e.value !== null) stamps.push((e.value as { at?: unknown }).at)

    return next(e)
  })
  await $.session.start(START as never)
  await $.command.run(typed('diff'))
  expect(stamps.length).toBeGreaterThan(0)
  expect(stamps.every(at => at === repo.clock.now())).toBe(true)
})

test('every reply that opens the pane off fullscreen says once how to press without a mouse', async ($, on) => {
  fakeRepo(on)
  await $.session.start(START as never)
  const off = (args: string) => ({ command: 'sc:workspace', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
  expect((await $.command.run(off('notes remember the retry policy'))).text).toMatch(/Clicks reach the panes only in fullscreen mode/)
  expect((await $.command.run(off('diff'))).text).not.toMatch(/Clicks reach/)
})

test('with checkpoints before every prompt off, the Checkpoints tab does not say they are taken before every prompt', { options: { checkpointEveryPrompt: false } }, async ($, on) => {
  fakeRepo(on)
  await $.session.start(START as never)
  await $.command.run(typed('checkpoints'))
  const ui = await $.ui.mount({ plugin: 'sc-workspace', surface: 'terminal', component: 'Pane', requestId: 'sc-workspace', props: { title: 'Workspace', isFocused: true, bodyColumns: 100, placement: 'dock' } as never })
  expect(await ui.find({ type: 'Text', text: /before every prompt/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Checkpoint now/ })).toBeDefined()
  await ui.unmount()
})

test('the snapshot indexes the session made, its own and another worktree\'s, go when it ends', async ($, on) => {
  const repo = fakeRepo(on)
  await $.session.start(START as never)
  await $.command.run(typed('agents'))
  const ui = await $.ui.mount({ plugin: 'sc-workspace', surface: 'terminal', component: 'Pane', requestId: 'sc-workspace', props: { title: 'Workspace', isFocused: true, bodyColumns: 100, placement: 'dock' } as never })
  await ui.press({ key: 'worktree-open-/repo-wip' })
  await ui.unmount()
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: {} } as never)
  const removed = repo.runs.filter(argv => argv[0] === 'rm').flatMap(argv => argv.slice(3))
  expect(removed).toContain('/repo/.git/sc-snapshot-session-1.index')
  expect(removed).toContain('/repo/.git/worktrees/wip/sc-snapshot-session-1.index')
})

test('as a session starts, or a reload takes it up again, the agents are read at once in the shape this load draws', async ($, on) => {
  fakeRepo(on, { agents: [{ id: 'a1', name: 'reviewer', description: 'Review the change', type: 'general-purpose', status: 'running' }] })
  const written: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.key === 'agents') written.push(e.value)

    return next(e)
  })
  await $.session.start(START as never)
  // Before the first three-second poll: a row left by an earlier load is replaced at once.
  expect(written.at(-1)).toEqual([expect.objectContaining({ id: 'a1', stopIds: ['a1', 'reviewer'] })])
})
