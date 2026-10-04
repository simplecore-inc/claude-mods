import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changeCells, splitPath } from '../hooks/views/diff'
import { removeArgv } from '../hooks/shared/files'
import { clipDiff } from '../hooks/git'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-04T05:00:00Z')

/** Stands in for the engine's state store beneath the plugin. */
function seedState(on: On, extra: Record<string, unknown>): void {
  const values: Record<string, unknown> = {
    tab: 'agents',
    agents: [
      { id: 'a1', stopId: 'reviewer', label: 'reviewer', type: 'general-purpose', status: 'running', firstSeen: NOW - 5 * 60_000 },
      { id: 'a2', stopId: 'a2', label: 'Find the config loader', type: 'Explore', status: 'completed', firstSeen: NOW - 60_000 },
    ],
    worktrees: [
      { path: '/repo', branch: 'main', isMain: true, isLocked: false, changed: 2 },
      { path: '/repo-merged', branch: 'done', isMain: false, isLocked: false, changed: 0, ahead: 0, behind: 3 },
      { path: '/repo-busy', branch: 'wip', isMain: false, isLocked: false, changed: 4, ahead: 2, behind: 0 },
    ],
    repoError: null,
    checkpoints: [
      { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label: 'Fix the login bug', kind: 'turn', since: { files: 2, added: 10, removed: 3 } },
      { ref: 'refs/sc/checkpoints/s/0001', commit: 'c1', tree: 't1', at: NOW - 3_600_000, label: '', kind: 'session', since: { files: 0, added: 0, removed: 0 } },
    ],
    notes: [
      { id: 'n1', text: 'Ask about the retry policy', isDone: false, at: NOW },
      { id: 'n2', text: 'Rename the config key', isDone: true, at: NOW - 1000 },
    ],
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [
        { path: 'src/app.ts', status: 'modified', added: 8, removed: 2 },
        { path: 'docs/new.md', status: 'added', added: 20, removed: 0 },
        { path: 'logo.png', status: 'modified', added: null, removed: null },
      ],
      selected: { path: 'src/app.ts', text: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same', omitted: 0 },
      at: NOW,
    },
    busy: null,
    clock: 0,
    dialog: null,
    focused: null,
    ...extra,
  }
  // A hook standing for the engine answers { value: <the event's result> }.
  // Another plugin's value is seeded as `<plugin>:<key>`.
  on('state.get', ($, e) => ({ value: { value: values[`${e.plugin}:${e.key}`] ?? values[e.key], version: 1 } as never }))
  mock.clock(on, { now: NOW } as never)
}

function mountPane($: Engine, surface: (typeof SURFACES)[number] | 'mobile', bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'sc-workspace',
    surface,
    component: 'Pane',
    requestId: 'sc-workspace',
    props: { title: 'Workspace', isFocused: true, bodyColumns, placement: 'dock' } as never,
  })
}

test('the tab bar shows every tab, with counts on the ones that have something', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'SimpleCORE Mods' })).toBeDefined()
    for (const key of ['agents', 'checkpoints', 'notes', 'diff']) expect(await ui.find({ key: `tab-${key}` })).toBeDefined()
    // One running agent, two checkpoints, one open note, three changed files.
    for (const badge of [' 1', ' 2', ' 3']) expect(await ui.find({ type: 'Text', text: badge })).toBeDefined()
    await ui.unmount()
  }
})

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

for (const [kind, ref, title, confirm] of [
  ['note', 'n1', 'Delete this note?', 'Delete'],
  ['stop', 'a1', 'Stop reviewer?', 'Stop'],
  ['worktree', '/repo-merged', 'Remove the worktree done?', 'Remove'],
] as const) {
  test(`the ${kind} dialog names what it acts on and its confirming button`, async ($, on) => {
    seedState(on, { dialog: { kind, ref } })
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    expect((await ui.find({ key: 'dialog-confirm' }))?.text).toBe(confirm)
    expect(await ui.find({ key: 'dialog-cancel' })).toBeDefined()
    // The dialog takes the pane: no tab bar behind it.
    expect(await ui.find({ key: 'tabs' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a dialog about something already gone falls back to the tabs', async ($, on) => {
  seedState(on, { dialog: { kind: 'note', ref: 'no-such-note' } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'tabs' })).toBeDefined()
  await ui.unmount()
})

test('on mobile, with no field, the Notes tab says how to add a note', async ($, on) => {
  seedState(on, { tab: 'notes' })
  const ui = await mountPane($, 'mobile')
  expect(await ui.find({ key: 'note-new' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\/sc:workspace notes/ })).toBeDefined()
  await ui.unmount()
})

test('the checkpoints tab: changes since each, compare and restore', async ($, on) => {
  seedState(on, { tab: 'checkpoints' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Fix the login bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+10' })).toBeDefined()
    expect(await ui.find({ key: 'compare-refs/sc/checkpoints/s/0002' })).toBeDefined()
    expect(await ui.find({ key: 'restore-refs/sc/checkpoints/s/0002' })).toBeDefined()
    // Nothing changed since the oldest: there is nothing to restore.
    expect(await ui.find({ key: 'restore-refs/sc/checkpoints/s/0001' })).toBeUndefined()
    expect(await ui.find({ key: 'tile-checkpoint-now' })).toBeDefined()
    await ui.unmount()
  }
})

test('the notes tab: an input where the surface has one, open notes first', async ($, on) => {
  seedState(on, { tab: 'notes' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'note-new' })).toBeDefined()
    expect((await ui.find({ key: 'notes-input' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect((await ui.find({ key: 'toggle-n1' }))?.text).toBe('☐')
    expect((await ui.find({ key: 'toggle-n2' }))?.text).toBe('☑')
    // Open and done notes are two groups; a done note is struck through, its group saying it is not sent.
    expect(await ui.find({ key: 'notes-card' })).toBeDefined()
    expect(await ui.find({ key: 'notes-done-card' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Rename the config key' }))?.props.strikethrough).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'Ask about the retry policy' }))?.props.strikethrough).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /not sent with prompts/ })).toBeDefined()
    // Notes come from the field alone: there is no tile taking the transcript selection.
    expect(await ui.find({ key: 'tile-add-selection' })).toBeUndefined()
    expect(await ui.find({ key: 'insert-n1' })).toBeDefined()
    // What notes are for, and the switch that sends them with prompts (off by default).
    expect(await ui.find({ type: 'Text', text: /^Things to remember in this project/ })).toBeDefined()
    // [ On | Off ]: the current segment (Off) filled grey, the other dim; the name beside flips it too.
    expect((await ui.find({ key: 'notes-send-on' }))?.text).toBe('On')
    expect((await ui.find({ key: 'notes-send-off' }))?.text).toBe('Off')
    expect((await ui.find({ key: 'notes-send-off-segment' }))?.props.backgroundColor).toBe('#5a606b')
    expect((await ui.find({ key: 'notes-send-on' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'notes-send-label' }))?.text).toBe('Send with prompts')
    await ui.unmount()
  }
})

test('the diff tab: files with their marks, and the open file\'s diff', async ($, on) => {
  seedState(on, { tab: 'diff' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The file's name is the button, its glyph down when open; the folder is joined by ›, never /,
    // so nothing on the row looks like a path a terminal would turn into a link.
    // Names share one column (here 8 cells, logo.png), so the folders start together.
    expect((await ui.find({ key: 'file-open-src/app.ts' }))?.text).toBe('▾ app.ts  ')
    expect((await ui.find({ key: 'file-open-docs/new.md' }))?.text).toBe('▸ new.md  ')
    // The name is drawn at full strength; only the folder is dim.
    expect((await ui.find({ key: 'file-open-docs/new.md' }))?.props.dimColor).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'src' })).toBeDefined()
    expect((await ui.find({ key: 'diff-files' }))?.text).not.toMatch(/\w\/\w/)
    // Code takes no key; the open file's diff is the one Code element.
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /binary/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+28' })).toBeDefined()
    // Every file's counts take the same width, so the bars line up.
    const widths = async (pattern: RegExp) => new Set((await ui.findAll({ type: 'Text', text: pattern })).map(found => (found.text ?? '').length))
    const added = [...(await widths(/^ {2}\s*\+\d+$/))]
    const removed = [...(await widths(/^ \s*−\d+$/))]
    expect(added.length).toBe(1)
    expect(removed.length).toBe(1)
    expect([...(await widths(/^ {2}binary\s*$/))]).toEqual([(added[0] ?? 0) + (removed[0] ?? 0)])
    await ui.unmount()
  }
})

test('outside a repository the git tabs say so instead of drawing empty lists', async ($, on) => {
  seedState(on, { tab: 'checkpoints', repoError: 'Checkpoints and changes need a git repository.', checkpoints: [], worktrees: [] })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /need a git repository/ })).toBeDefined()
  await ui.unmount()
})

test('changeCells splits the bar by added and removed lines, scaled to the largest file', async () => {
  expect(changeCells({ path: 'a', status: 'modified', added: 8, removed: 2 }, 20)).toEqual({ added: 4, removed: 1 })
  expect(changeCells({ path: 'b', status: 'added', added: 20, removed: 0 }, 20)).toEqual({ added: 10, removed: 0 })
  expect(changeCells({ path: 'c', status: 'modified', added: null, removed: null }, 20)).toEqual({ added: 0, removed: 0 })
  // A tiny change still shows one cell.
  expect(changeCells({ path: 'd', status: 'modified', added: 1, removed: 0 }, 1000).added).toBe(1)
})

test('footer tiles keep every label on one line, moving tiles to a new row when the pane is narrow', async ($, on) => {
  seedState(on, { tab: 'notes' })
  const wide = await mountPane($, 'terminal', 100)
  expect(await wide.find({ key: 'footer-row-1' })).toBeUndefined()
  expect((await wide.find({ key: 'tile-clear-done' }))?.props).toMatchObject({ justifyContent: 'center' })
  await wide.unmount()
  // Two tiles of at least 10 + 4 cells cannot share 20 cells: they wrap.
  const narrow = await mountPane($, 'terminal', 20)
  expect(await narrow.find({ key: 'footer-row-1' })).toBeDefined()
  const width = Number((await narrow.find({ key: 'tile-clear-done' }))?.props.width)
  expect(width).toBeGreaterThanOrEqual('Clear done'.length + 4)
  await narrow.unmount()
})

test('a running agent\'s elapsed time follows the agents clock tick', async ($, on) => {
  // firstSeen is five minutes before NOW; the tick says ten minutes have passed since.
  seedState(on, { clock: NOW + 10 * 60_000 })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /running · 15m/ })).toBeDefined()
  await ui.unmount()
})

test('on a narrow pane a checkpoint keeps one line: the label is cut to its cells, the right side never shrinks', async ($, on) => {
  const label = '에이전트 두 개를 만들어봐. workspace 기능 테스트를 위한 것임'
  seedState(on, {
    tab: 'checkpoints',
    checkpoints: [
      { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label, kind: 'turn', since: { files: 13, added: 336, removed: 121 } },
    ],
  })
  const ui = await mountPane($, 'terminal', 50)
  const shown = (await ui.find({ type: 'Text', text: /^에이전트/ }))?.text ?? ''
  expect(shown.endsWith('…')).toBe(true)
  expect(shown.length).toBeLessThan(label.length)
  expect((await ui.find({ key: 'checkpoint-right-refs/sc/checkpoints/s/0002' }))?.props).toMatchObject({ flexShrink: 0 })
  await ui.unmount()
})

test('restoring asks in a dialog: what it goes back to, what it undoes, and how to undo it', async ($, on) => {
  seedState(on, { tab: 'checkpoints', dialog: { kind: 'restore', ref: 'refs/sc/checkpoints/s/0002' } })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'sc-workspace',
      surface,
      component: 'Pane',
      requestId: 'sc-workspace',
      props: { title: 'Workspace', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
    })
    // The pane's usual header stays; the dialog itself is a bordered box.
    expect(await ui.find({ type: 'Text', text: 'SimpleCORE Mods' })).toBeDefined()
    expect((await ui.find({ key: 'dialog' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'yellow' })
    expect(await ui.find({ type: 'Text', text: /^Restore the working tree to / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Checkpoint: Fix the login bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 files, \+10 −3/ })).toBeDefined()
    expect((await ui.find({ key: 'dialog-confirm' }))?.props).toMatchObject({ autoFocus: true })
    // Focus shows as the tile's border: the confirming tile first, in the accent colour.
    expect((await ui.find({ key: 'tile-dialog-confirm' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect((await ui.find({ key: 'tile-dialog-cancel' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(await ui.find({ key: 'dialog-cancel' })).toBeDefined()
    // The dialog takes the workspace pane itself: no tab bar, no list behind it.
    expect(await ui.find({ key: 'tabs' })).toBeUndefined()
    expect(await ui.find({ key: 'checkpoints-card' })).toBeUndefined()
    await ui.unmount()
  }
})

test('in the checkpoints tab the restore button is one press: the dialog does the asking', async ($, on) => {
  seedState(on, { tab: 'checkpoints' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'restore-refs/sc/checkpoints/s/0002' }))?.text).toBe('↺')
  expect(await ui.find({ key: 'restore-refs/sc/checkpoints/s/0002-confirm' })).toBeUndefined()
  await ui.unmount()
})

test('splitPath cuts the name to its column and the folder to what is left', async () => {
  expect(splitPath('mods/accounts/tests/format.test.ts', 14, 60)).toEqual({ name: 'format.test.ts', folder: 'mods › accounts › tests' })
  expect(splitPath('README.md', 14, 60)).toEqual({ name: 'README.md', folder: '' })
  expect(splitPath('a/b/c/d/e/long-name.ts', 12, 26).folder.endsWith('…')).toBe(true)
  expect(splitPath('a/b/a-very-long-file-name.ts', 10, 60).name).toBe('a-very-lo…')
  expect(splitPath('a/b/file.ts', 7, 12).folder).toBe('')
})

test('the diff tab names its base as a button that opens the base dialog', async ($, on) => {
  seedState(on, { tab: 'diff' })
  // The engine's store beneath the plugin takes the dialog it is asked to show.
  const written: unknown[] = []
  on('state.set', ($, e) => {
    if (e.key === 'dialog') written.push(e.value)
    return { value: { isSet: true, version: 2 } as never }
  })
  const opened: { id: string; focus?: boolean }[] = []
  on('ui.open', ($, e, next) => {
    opened.push({ id: e.id, focus: e.focus })
    return next(e)
  })
  for (const surface of [...SURFACES, 'mobile'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'diff-base' }))?.text).toMatch(/Session start ▾$/)
    await ui.unmount()
  }
  const ui = await mountPane($, 'terminal')
  // The dialog is drawn in this pane, which takes the keys so Enter answers it.
  await ui.press({ key: 'diff-base' })
  expect(written).toContainEqual({ kind: 'base', ref: '' })
  expect(opened).toEqual([{ id: 'sc-workspace', focus: true }])
  await ui.unmount()
})

test('the base dialog lists the checkpoints with what changed since each, the base in use marked', async ($, on) => {
  seedState(on, {
    tab: 'diff',
    dialog: { kind: 'base', ref: '' },
    diff: { base: { commit: 'c2', label: 'Fix the login bug', at: NOW - 60_000, isSessionStart: false }, files: [], at: NOW },
  })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Compare the changes with' })).toBeDefined()
    // The newest first, the labels in one column, the counts beside.
    expect((await ui.find({ key: 'base-c2' }))?.text).toMatch(/Fix the login bug$/)
    expect((await ui.find({ key: 'base-c1' }))?.text?.length).toBe((await ui.find({ key: 'base-c2' }))?.text?.length)
    expect(await ui.find({ type: 'Text', text: '2 files +10 −3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no changes since' })).toBeDefined()
    // The base in use holds the focus first, so Enter keeps it.
    expect((await ui.find({ key: 'base-c2' }))?.props).toMatchObject({ autoFocus: true })
    expect((await ui.find({ key: 'base-c1' }))?.props.autoFocus).toBeUndefined()
    expect(await ui.find({ key: 'dialog-cancel' })).toBeDefined()
    expect(await ui.find({ key: 'tabs' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Close closes the workspace pane itself', async ($, on) => {
  seedState(on, {})
  const closed: string[] = []
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined as never }
  })
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'close' })
  expect(closed).toEqual(['sc-workspace'])
  await ui.unmount()
})

test('when the ring moves to Cancel, Cancel\'s tile takes the accent border', async ($, on) => {
  seedState(on, { tab: 'checkpoints', dialog: { kind: 'restore', ref: 'refs/sc/checkpoints/s/0002' }, focused: 'dialog-cancel' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'tile-dialog-cancel' }))?.props).toMatchObject({ borderColor: 'cyan' })
  expect((await ui.find({ key: 'tile-dialog-confirm' }))?.props).toMatchObject({ borderDimColor: true })
  await ui.unmount()
})

test('with notesInContext on, the Notes tab shows sending as ticked', { options: { notesInContext: true } }, async ($, on) => {
  seedState(on, { tab: 'notes' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'notes-send-on-segment' }))?.props.backgroundColor).toBe('#1f7a3a')
  expect((await ui.find({ key: 'notes-send-off' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('pressing Send with prompts sets the notesInContext setting', async ($, on) => {
  seedState(on, { tab: 'notes' })
  const writes: { key: string; value: unknown }[] = []
  on('config.set', ($, e) => {
    writes.push({ key: e.key, value: e.value })

    return { value: { value: e.value } as never }
  })
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($, 'terminal')
  // Off is current: pressing it changes nothing; pressing On, or the name, switches it on.
  await ui.press({ key: 'notes-send-off' })
  await ui.press({ key: 'notes-send-on' })
  await ui.press({ key: 'notes-send-label' })
  expect(writes).toEqual([
    { key: 'sc-workspace.notesInContext', value: true },
    { key: 'sc-workspace.notesInContext', value: true },
  ])
  await ui.unmount()
})

test('the send switch sits right under the notes, below their card and above the done group', async ($, on) => {
  seedState(on, { tab: 'notes' })
  const ui = await mountPane($, 'terminal')
  const text = (await ui.find({ key: 'notes' }))?.text ?? ''
  const at = (needle: string) => text.indexOf(needle)
  expect(at('Ask about the retry policy')).toBeGreaterThan(-1)
  expect(at('Send with prompts')).toBeGreaterThan(at('Ask about the retry policy'))
  expect(at('Done')).toBeGreaterThan(at('Send with prompts'))
  // The group is called Notes now, not To do.
  expect(await ui.find({ type: 'Text', text: 'To do' })).toBeUndefined()
  await ui.unmount()
})


test('toggle opens the closed pane on the tab named, and closes the open one', async ($, on) => {
  seedState(on, { tab: 'diff' })
  let panes: { id: string; isShown?: boolean; isPlaced?: boolean }[] = []
  on('ui.panes', () => ({ value: panes as never }))
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined as never }
  })
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  // The command as the person types it at the prompt.
  const typed = { command: 'sc:workspace', args: 'toggle diff', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  expect((await $.command.run(typed)).text).toBe('Opened the workspace on Diff.')
  expect(opened).toEqual(['sc-workspace'])
  panes = [{ id: 'sc-workspace', isShown: true, isPlaced: true }]
  expect((await $.command.run(typed)).text).toBe('Closed the workspace.')
  expect(closed).toEqual(['sc-workspace'])
})

test('pressing the accounts band\'s place or lines changed toggles the workspace, inside the press', {
  plugins: [
    {
      name: 'sc-accounts',
      // Stands for the accounts mod: its band, with the lines changed as a Button.
      register: on => {
        on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
          const { Button } = $.ui.resolve(e)
          const { Box } = $.ui.resolve(e)
          return (
            <Box>
              <Button key="band-place" label="▐" plain onPress={() => undefined} />
              <Button key="band-place-1" label="claude-mods" plain onPress={() => undefined} />
              <Button key="band-lines" label="+3 -1" plain onPress={() => undefined} />
            </Box>
          )
        })
      },
    },
  ],
}, async ($, on) => {
  seedState(on, { tab: 'diff' })
  on('ui.panes', () => ({ value: [] as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  const opened: string[] = []
  const titles: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    titles.push(e.title ?? '')
    return { value: { isPlaced: true } as never }
  })
  const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
  expect(await band.press({ key: 'band-lines' })).toEqual({ element: 'band-lines' })
  expect(opened).toEqual(['sc-workspace'])
  // The engine's tab row names the pane short, while another pane is open beside it.
  expect(titles).toEqual(['SC-Workspace'])
  // Any Button of the cell, not only its first: here the directory's name.
  expect(await band.press({ key: 'band-place-1' })).toEqual({ element: 'band-place-1' })
  expect(opened).toEqual(['sc-workspace', 'sc-workspace'])
  await band.unmount()
})

test('a workspace pane behind another pane\'s tab is opened afresh, in front, not closed', async ($, on) => {
  seedState(on, { tab: 'diff' })
  on('ui.panes', () => ({ value: [{ id: 'sc-workspace', isShown: false, isPlaced: true }] as never }))
  on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
  const calls: string[] = []
  on('ui.open', ($, e) => {
    calls.push(`open ${e.id}`)
    return { value: { isPlaced: true } as never }
  })
  on('ui.close', ($, e) => {
    calls.push(`close ${e.id}`)
    return { value: undefined as never }
  })
  const typed = { command: 'sc:workspace', args: 'toggle diff', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  expect((await $.command.run(typed)).text).toBe('Opened the workspace on Diff.')
  expect(calls).toEqual(['close sc-workspace', 'open sc-workspace'])
})

test('alone, the pane\'s header names it: SimpleCORE Mods: Workspace', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'SimpleCORE Mods: Workspace' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

test('beside the accounts pane, the header still names the pane, a row below the engine\'s tabs', async ($, on) => {
  seedState(on, { 'sc-accounts:paneOpen': true })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'SimpleCORE Mods: Workspace' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('files are deleted with rm on a POSIX system and with PowerShell on Windows', async () => {
  expect(removeArgv(['a/b.txt', 'c.txt'], false)).toEqual(['rm', '-f', '--', 'a/b.txt', 'c.txt'])
  expect(removeArgv(['a/b.txt'], true)[0]).toBe('powershell.exe')
})

test('a diff of one huge line (an SVG), or of many ordinary lines, still draws: it is cut within the engine\'s bound', async ($, on) => {
  const huge = `diff --git a/x.svg b/x.svg\n--- a/x.svg\n+++ b/x.svg\n@@ -0,0 +1 @@\n+${'<rect/>'.repeat(20_000)}`
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [{ path: 'x.svg', status: 'added', added: 1, removed: 0 }],
      selected: { path: 'x.svg', ...clipDiff(huge, 400) },
      at: NOW,
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})

test('a long diff of ordinary lines draws, cut to what the engine takes', async ($, on) => {
  const long = ['diff --git a/r.ts b/r.ts', '--- a/r.ts', '+++ b/r.ts', '@@ -1,400 +1,400 @@', ...Array.from({ length: 400 }, (_, index) => `+const line${index} = 'an ordinary line of source code here'`)].join('\n')
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [{ path: 'r.ts', status: 'modified', added: 400, removed: 0 }],
      selected: { path: 'r.ts', ...clipDiff(long, 400) },
      at: NOW,
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})
