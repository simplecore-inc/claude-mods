import { expect, test } from 'claude-code/testing'

import { removeArgv } from '../hooks/shared/files'
import { SURFACES, seedState, mountPane } from './paneHarness'

test('the tab bar shows every tab, with counts on the ones that have something', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    for (const key of ['agents', 'checkpoints', 'notes', 'diff']) expect(await ui.find({ key: `tab-${key}` })).toBeDefined()
    // One running agent, two checkpoints, one open note, three changed files.
    for (const badge of [' 1', ' 2', ' 3']) expect(await ui.find({ type: 'Text', text: badge })).toBeDefined()
    await ui.unmount()
  }
})

test('on a narrow pane the tabs move to a new row instead of wrapping inside, every tab on a background', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal', 30)
  expect((await ui.find({ key: 'tabs' }))?.props).toMatchObject({ flexWrap: 'wrap' })
  for (const key of ['agents', 'checkpoints', 'notes', 'diff']) {
    const props = (await ui.find({ key: `tab-${key}` }))?.props
    expect(props).toMatchObject({ flexShrink: 0 })
    expect(props?.backgroundColor).toBeDefined()
  }
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

test('outside a repository the git tabs say so instead of drawing empty lists', async ($, on) => {
  seedState(on, { tab: 'checkpoints', repoError: 'Checkpoints and changes need a git repository.', checkpoints: [], worktrees: [] })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /need a git repository/ })).toBeDefined()
  await ui.unmount()
})

test('footer tiles keep every label on one line, moving tiles to a new row when the pane is narrow', async ($, on) => {
  seedState(on, { tab: 'diff' })
  const wide = await mountPane($, 'terminal', 100)
  expect(await wide.find({ key: 'footer-row-1' })).toBeUndefined()
  expect((await wide.find({ key: 'tile-draft-commit' }))?.props).toMatchObject({ justifyContent: 'center' })
  await wide.unmount()
  // Two tiles of at least 20 + 4 cells cannot share 30 cells: they wrap.
  const narrow = await mountPane($, 'terminal', 30)
  expect(await narrow.find({ key: 'footer-row-1' })).toBeDefined()
  const width = Number((await narrow.find({ key: 'tile-draft-commit' }))?.props.width)
  expect(width).toBeGreaterThanOrEqual('Draft commit message'.length + 4)
  await narrow.unmount()
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
  const typed = { command: 'sc:workspace', args: 'toggle diff', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
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
      // Stands for the accounts mod: its band, the place and the lines changed one Button each, their coloured runs inside.
      register: on => {
        on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
          const { Box, Button, Text } = $.ui.resolve(e)
          return (
            <Box>
              <Button key="band-place" plain onPress={() => undefined}>
                <Text color="gray">▐</Text>
                <Text>claude-mods</Text>
              </Button>
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
  expect(titles).toEqual(['Workspace'])
  // The place opens it too.
  expect(await band.press({ key: 'band-place' })).toEqual({ element: 'band-place' })
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
  const typed = { command: 'sc:workspace', args: 'toggle diff', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
  expect((await $.command.run(typed)).text).toBe('Opened the workspace on Diff.')
  expect(calls).toEqual(['close sc-workspace', 'open sc-workspace'])
})

test('alone, the pane\'s header names it: [SC] Workspace', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Workspace' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

test('beside the accounts pane, the header still names the pane, a row below the engine\'s tabs', async ($, on) => {
  seedState(on, { 'sc-accounts:paneOpen': true })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Workspace' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('files are deleted with rm on a POSIX system and with PowerShell on Windows', async () => {
  expect(removeArgv(['a/b.txt', 'c.txt'], false)).toEqual(['rm', '-f', '--', 'a/b.txt', 'c.txt'])
  expect(removeArgv(['a/b.txt'], true)[0]).toBe('powershell.exe')
})

test('opening the pane from its command drops a dialog an earlier draw left, so the tabs show', async ($, on) => {
  seedState(on, { tab: 'diff', dialog: { kind: 'diff', ref: 'src/app.ts' } })
  const writes: { key: string; value: unknown }[] = []
  on('state.set', ($, e) => {
    writes.push({ key: e.key, value: e.value })

    return { value: { isSet: true, version: 2 } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.panes', () => ({ value: [] as never }))
  await $.command.run({ command: 'sc:workspace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  expect(writes).toContainEqual({ key: 'dialog', value: null })
})
