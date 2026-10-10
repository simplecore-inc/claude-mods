import { expect, test } from 'claude-code/testing'

import { SURFACES, NOW, seedState, mountPane } from './paneHarness'

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

test('on a narrow pane a checkpoint keeps one line: the label is cut to its cells, the right side never shrinks', async ($, on) => {
  const label = '에이전트 두 개를 만들어봐. workspace 기능 테스트를 위한 것임'
  seedState(on, {
    tab: 'checkpoints',
    checkpoints: [
      { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label, kind: 'turn', since: { files: 13, added: 336, removed: 121 } },
    ],
  })
  const ui = await mountPane($, 'terminal', 50)
  const shown = (await ui.find({ type: 'Text', text: /^에이/ }))?.text ?? ''
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
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    expect((await ui.find({ key: 'dialog' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'yellow' })
    expect(await ui.find({ type: 'Text', text: /^Restore the working tree to / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Checkpoint: Fix the login bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 files, \+10 −3/ })).toBeDefined()
    expect((await ui.find({ key: 'dialog-confirm' }))?.props).toMatchObject({ autoFocus: true })
    if (surface === 'terminal') {
      // Focus shows as the tile's border: the confirming tile first, in the accent colour.
      expect((await ui.find({ key: 'tile-dialog-confirm' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
      expect((await ui.find({ key: 'tile-dialog-cancel' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    } else {
      // The surface's own buttons show the focus; the confirming one is the primary.
      expect((await ui.find({ key: 'dialog-confirm' }))?.props).toMatchObject({ variant: 'primary' })
      expect((await ui.find({ key: 'tile-dialog-confirm' }))?.props.borderStyle).toBeUndefined()
    }
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

test('when the ring moves to Cancel, Cancel\'s tile takes the accent border', async ($, on) => {
  seedState(on, { tab: 'checkpoints', dialog: { kind: 'restore', ref: 'refs/sc/checkpoints/s/0002' }, focused: 'dialog-cancel' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'tile-dialog-cancel' }))?.props).toMatchObject({ borderColor: 'cyan' })
  expect((await ui.find({ key: 'tile-dialog-confirm' }))?.props).toMatchObject({ borderDimColor: true })
  await ui.unmount()
})

test('a checkpoint whose prompt was only a harness block is named by its kind', async ($, on) => {
  seedState(on, {
    tab: 'checkpoints',
    checkpoints: [{ ref: 'refs/sc/checkpoints/s/0003', commit: 'c3', tree: 't3', at: NOW - 1000, label: '<task-notification>', kind: 'turn', since: { files: 0, added: 0, removed: 0 } }],
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '<task-notification>' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Prompt' })).toBeDefined()
  await ui.unmount()
})

test('each checkpoint but the newest opens its turn; a pinned one has its star lit', async ($, on) => {
  seedState(on, {
    tab: 'checkpoints',
    checkpoints: [
      { ref: 'r2', commit: 'c2', tree: 't2', at: NOW - 60_000, label: 'Fix the login bug', kind: 'turn', since: { files: 1, added: 1, removed: 0 } },
      { ref: 'r1', commit: 'c1', tree: 't1', at: NOW - 3_600_000, label: '', kind: 'session', name: 'Before the refactor', isPinned: true, since: { files: 2, added: 3, removed: 1 } },
    ],
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'turn-r2' })).toBeUndefined()
  expect(await ui.find({ key: 'turn-r1' })).toBeDefined()
  expect((await ui.find({ key: 'pin-r1' }))?.text).toBe('★')
  // A pinned star sits on the warning ground, an unpinned one on the neutral fill.
  expect((await ui.find({ key: 'pin-r1-ground' }))?.props.backgroundColor).toBe('#6b5719')
  expect((await ui.find({ key: 'pin-r2-ground' }))?.props.backgroundColor).toBe('#2a2f38')
  expect((await ui.find({ key: 'pin-r2' }))?.text).toBe('☆')
  expect(await ui.find({ type: 'Text', text: 'Before the refactor' })).toBeDefined()
  await ui.unmount()
})

test('the name dialog asks for a name in a field, or says how to give one where there is none', async ($, on) => {
  seedState(on, { tab: 'checkpoints', dialog: { kind: 'name', ref: 'refs/sc/checkpoints/s/0002' } })
  let ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Name the checkpoint at / })).toBeDefined()
  expect(await ui.find({ key: 'checkpoint-name' })).toBeDefined()
  await ui.unmount()
  ui = await mountPane($, 'mobile')
  expect(await ui.find({ key: 'checkpoint-name' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\/sc:workspace name/ })).toBeDefined()
  await ui.unmount()
})

test('every glyph button reads at rest: full strength, on a ground of its meaning', async ($, on) => {
  seedState(on, { tab: 'checkpoints' })
  const ui = await mountPane($, 'terminal')
  const restore = await ui.find({ key: 'restore-refs/sc/checkpoints/s/0002' })
  expect(restore?.props.dimColor).toBeUndefined()
  expect((await ui.find({ key: 'restore-refs/sc/checkpoints/s/0002-ground' }))?.props.backgroundColor).toBe('#6b5719')
  expect((await ui.find({ key: 'compare-refs/sc/checkpoints/s/0002-ground' }))?.props.backgroundColor).toBe('#1d5566')
  await ui.unmount()
})
