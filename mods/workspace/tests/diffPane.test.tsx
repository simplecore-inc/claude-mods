import { expect, test } from 'claude-code/testing'

import { changeCells, splitPath } from '../hooks/views/diff'
import { clipDiff } from '../hooks/git'
import { displayWidth } from '../hooks/shared/layout'
import { hunkProblems } from './diffCheck'
import { SURFACES, NOW, seedState, mountPane } from './paneHarness'

test('the diff tab: files with their marks, and the open file\'s diff', async ($, on) => {
  seedState(on, { tab: 'diff' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The file's name is the button; the folder is joined by ›, never /,
    // so nothing on the row looks like a path a terminal would turn into a link.
    // Names share one column (here 8 cells, logo.png), so the folders start together.
    expect((await ui.find({ key: 'file-open-src/app.ts' }))?.text).toBe('▸ app.ts  ')
    expect((await ui.find({ key: 'file-open-docs/new.md' }))?.text).toBe('▸ new.md  ')
    // The name is drawn at full strength; only the folder is dim.
    expect((await ui.find({ key: 'file-open-docs/new.md' }))?.props.dimColor).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'src' })).toBeDefined()
    expect((await ui.find({ key: 'diff-files' }))?.text).not.toMatch(/\w\/\w/)
    // A file's diff opens in its dialog, never under the list, however long the list.
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /binary/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+28' })).toBeDefined()
    // Every file's counts take the same width, so the bars line up.
    const widths = async (pattern: RegExp) => new Set((await ui.findAll({ type: 'Text', text: pattern })).map(found => (found.text ?? '').length))
    const counts = [...(await widths(/^ {2}\s*\+\d+ \s*−\d+$/))]
    expect(counts.length).toBe(1)
    expect([...(await widths(/^ {2}binary\s*$/))]).toEqual(counts)
    await ui.unmount()
  }
})

test('changeCells splits the bar by added and removed lines, scaled to the largest file', async () => {
  expect(changeCells({ path: 'a', status: 'modified', added: 8, removed: 2 }, 20)).toEqual({ added: 4, removed: 1 })
  expect(changeCells({ path: 'b', status: 'added', added: 20, removed: 0 }, 20)).toEqual({ added: 10, removed: 0 })
  expect(changeCells({ path: 'c', status: 'modified', added: null, removed: null }, 20)).toEqual({ added: 0, removed: 0 })
  // A tiny change still shows one cell.
  expect(changeCells({ path: 'd', status: 'modified', added: 1, removed: 0 }, 1000).added).toBe(1)
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
    // A filled select on the terminal; elsewhere the surface's own button is the field.
    if (surface === 'terminal') expect((await ui.find({ key: 'diff-base-field' }))?.props.backgroundColor).toBeDefined()
    else expect((await ui.find({ key: 'diff-base' }))?.type).toBe('Button')
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

test('on a narrow pane a base choice keeps one line: the label is cut to what the counts leave', async ($, on) => {
  const label = '앱 재실행해도 됨. target/debug도 정리해\n그리고 다음 작업을 이어서 진행해 주세요'
  seedState(on, {
    tab: 'diff',
    dialog: { kind: 'base', ref: '' },
    checkpoints: [
      { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label, kind: 'turn', since: { files: 13, added: 408, removed: 71 } },
    ],
    diff: { base: { commit: 'c2', label, at: NOW - 60_000, isSessionStart: false }, files: [], at: NOW },
  })
  const ui = await mountPane($, 'terminal', 50)
  const shown = (await ui.find({ key: 'base-c2' }))?.text ?? ''
  const detail = '13 files +408 −71'
  expect(shown.includes('\n')).toBe(false)
  expect(await ui.find({ type: 'Text', text: detail })).toBeDefined()
  // Mark, label and counts fit inside the dialog's border and padding.
  expect(1 + 1 + displayWidth(shown) + 1 + displayWidth(detail)).toBeLessThanOrEqual(50 - 4)
  await ui.unmount()
})

test('a diff of one huge line (an SVG) still draws: the line is cut to 400 characters', async ($, on) => {
  const huge = `diff --git a/x.svg b/x.svg\n--- a/x.svg\n+++ b/x.svg\n@@ -0,0 +1 @@\n+${'<rect/>'.repeat(20_000)}`
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [{ path: 'x.svg', status: 'added', added: 1, removed: 0 }],
      selected: { path: 'x.svg', ...clipDiff(huge, 400, 400_000) },
      at: NOW,
    },
    dialog: { kind: 'diff', ref: 'x.svg' },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})

test('a long diff of ordinary lines draws a page at a time', async ($, on) => {
  const long = ['diff --git a/r.ts b/r.ts', '--- a/r.ts', '+++ b/r.ts', '@@ -1,400 +1,400 @@', ...Array.from({ length: 400 }, (_, index) => `+const line${index} = 'an ordinary line of source code here'`)].join('\n')
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [{ path: 'r.ts', status: 'modified', added: 400, removed: 0 }],
      selected: { path: 'r.ts', ...clipDiff(long, 400, 400_000) },
      at: NOW,
    },
    dialog: { kind: 'diff', ref: 'r.ts' },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  // A page at a time, 24 lines each: the first one shown, Next offered.
  expect(await ui.find({ type: 'Text', text: /page 1 of \d+$/ })).toBeDefined()
  expect(await ui.find({ key: 'code-next' })).toBeDefined()
  expect(await ui.find({ key: 'code-previous' })).toBeUndefined()
  await ui.unmount()
})

test('the diff dialog has a restore button that asks first, and moves between the files', async ($, on) => {
  seedState(on, { tab: 'diff', dialog: { kind: 'diff', ref: 'src/app.ts' } })
  const written: unknown[] = []
  on('state.set', ($, e) => {
    if (e.key === 'dialog') written.push(e.value)
    return { value: { isSet: true, version: 2 } as never }
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+8 −2 · since Session start' })).toBeDefined()
  // The first file has a next one and no previous one.
  expect(await ui.find({ key: 'diff-next-file' })).toBeDefined()
  expect(await ui.find({ key: 'diff-previous-file' })).toBeUndefined()
  await ui.press({ key: 'diff-file-restore' })
  expect(written).toContainEqual({ kind: 'file', ref: 'src/app.ts' })
  await ui.unmount()
})

test('between two checkpoints the open file has no restore button', async ($, on) => {
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      target: { commit: 'c2', label: 'Fix the login bug', at: NOW - 60_000, isSessionStart: false },
      files: [{ path: 'src/app.ts', status: 'modified', added: 8, removed: 2 }],
      selected: { path: 'src/app.ts', text: '@@ -1 +1 @@\n-old\n+new', omitted: 0 },
      at: NOW,
    },
    dialog: { kind: 'diff', ref: 'src/app.ts' },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'diff-file-restore' })).toBeUndefined()
  await ui.unmount()
})

test('the file dialog names the file, what restoring undoes, and how to undo it', async ($, on) => {
  seedState(on, { tab: 'diff', dialog: { kind: 'file', ref: 'src/app.ts' } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Put src\/app\.ts back as it was at / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Undoes +8 −2 in this file.' })).toBeDefined()
  expect((await ui.find({ key: 'dialog-confirm' }))?.text).toBe('Restore file')
  await ui.unmount()
})

test('the target dialog offers the working tree and the checkpoints after the base', async ($, on) => {
  seedState(on, { tab: 'diff', dialog: { kind: 'target', ref: '' } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Compare the changes up to' })).toBeDefined()
  expect((await ui.find({ key: 'target-now' }))?.props).toMatchObject({ autoFocus: true })
  expect(await ui.find({ key: 'target-c2' })).toBeDefined()
  expect(await ui.find({ key: 'target-c1' })).toBeUndefined()
  await ui.unmount()
})

test('Draft commit message puts a request naming every changed file in the prompt', async ($, on) => {
  seedState(on, { tab: 'diff' })
  const filled: { text: string; mode: string }[] = []
  on('prompt.fill', ($, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true } as never
  })
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'draft-commit' })
  expect(filled).toHaveLength(1)
  // Put in at the cursor: what the person was typing stays.
  expect(filled[0]?.mode).toBe('insert')
  expect(filled[0]?.text).toContain('- A docs/new.md (+20 −0)')
  await ui.unmount()
})

test('another worktree\'s changes are headed by its branch, with no base to pick and nothing to restore', async ($, on) => {
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'mb', label: 'main', at: 0, isSessionStart: false },
      worktree: { path: '/repo-busy', branch: 'wip' },
      files: [{ path: 'src/app.ts', status: 'modified', added: 1, removed: 0 }],
      selected: { path: 'src/app.ts', text: '@@ -1 +1 @@\n-a\n+b', omitted: 0 },
      at: NOW,
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Changes in wip' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /since it parted from main/ })).toBeDefined()
  expect(await ui.find({ key: 'diff-base' })).toBeUndefined()
  expect(await ui.find({ key: 'diff-file-restore' })).toBeUndefined()
  expect(await ui.find({ key: 'diff-worktree-close' })).toBeDefined()
  await ui.unmount()
})

test('a binary file keeps its row to one line when every count is shorter than its word', async ($, on) => {
  seedState(on, {
    tab: 'diff',
    diff: {
      base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
      files: [
        { path: 'src/a.ts', status: 'modified', added: 4, removed: 4 },
        { path: 'logo.png', status: 'modified', added: null, removed: null },
      ],
      at: NOW,
    },
  })
  const ui = await mountPane($, 'terminal')
  const counts = (await ui.findAll({ type: 'Text', text: /^ {2}\s*\+\d+ \s*−\d+$/ })).map(found => (found.text ?? '').length)
  const binary = (await ui.findAll({ type: 'Text', text: /^ {2}binary\s*$/ })).map(found => (found.text ?? '').length)
  // One width for both: the counts are padded to the word, never the word run past them.
  expect(counts).toEqual(binary)
  await ui.unmount()
})

/** A diff of one long hunk: every other line changed, 120 lines of the file. */
const LONG_HUNK = [
  'diff --git a/r.ts b/r.ts',
  'index 1111111..2222222 100644',
  '--- a/r.ts',
  '+++ b/r.ts',
  '@@ -1,120 +1,120 @@ export function r()',
  ...Array.from({ length: 120 }, (_, line) => (line % 2 === 0 ? `-old ${line}\n+new ${line}` : ` same ${line}`)),
].join('\n')

for (const page of [0, 1, 2, 7]) {
  test(`page ${page + 1} of a diff longer than a page is whole hunks, so the engine draws it as a diff`, async ($, on) => {
    seedState(on, {
      tab: 'diff',
      dialog: { kind: 'diff', ref: 'r.ts' },
      diffPage: page,
      diff: {
        base: { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true },
        files: [{ path: 'r.ts', status: 'modified', added: 60, removed: 60 }],
        selected: { path: 'r.ts', text: LONG_HUNK, omitted: 0 },
        at: NOW,
      },
    })
    const ui = await mountPane($, 'terminal')
    const code = await ui.find({ type: 'Code' })
    const source = String(code?.props.source ?? '')
    expect(hunkProblems(source)).toEqual([])
    expect(source.split('\n').length).toBeLessThanOrEqual(24)
    await ui.unmount()
  })
}
