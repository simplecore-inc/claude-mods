import { expect, test } from 'claude-code/testing'

import { SURFACES, NOW, seedState, mountPane } from './paneHarness'

test('on mobile, with no field, the Notes tab says how to add a note', async ($, on) => {
  seedState(on, { tab: 'notes' })
  const ui = await mountPane($, 'mobile')
  expect(await ui.find({ key: 'note-new' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\/sc:workspace notes/ })).toBeDefined()
  await ui.unmount()
})

test('the notes tab: an input where the surface has one, open notes first', async ($, on) => {
  seedState(on, { tab: 'notes' })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'note-new' })).toBeDefined()
    expect((await ui.find({ key: 'notes-input-frame' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan', flexGrow: 1 })
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

    return { value: e.value as never }
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


test('a note Claude says it finished shows its number and a Done button to confirm', async ($, on) => {
  seedState(on, {
    tab: 'notes',
    notes: [{ id: 'n1', text: 'Ask about the retry policy', isDone: false, at: NOW, seq: 3, isSuggestedDone: true }],
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'N3' })).toBeDefined()
  expect((await ui.find({ key: 'confirm-done-n1' }))?.text).toBe('Done')
  expect(await ui.find({ key: 'suggested-n1' })).toBeDefined()
  await ui.unmount()
})

test('two notes ticked one after the other are both done: the second press does not write back the list the first changed', async ($, on) => {
  const values = seedState(on, { tab: 'notes', notes: [{ id: 'n1', text: 'one', isDone: false, at: NOW, seq: 1 }, { id: 'n2', text: 'two', isDone: false, at: NOW - 1, seq: 2 }] }, { isVersioned: true })
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'toggle-n1' })
  await ui.press({ key: 'toggle-n2' })
  expect((values.notes as { id: string; isDone: boolean }[]).map(note => [note.id, note.isDone])).toEqual([
    ['n1', true],
    ['n2', true],
  ])
  await ui.unmount()
})

test('a note added and another then ticked are both kept', async ($, on) => {
  const values = seedState(on, { tab: 'notes', notes: [{ id: 'n1', text: 'one', isDone: false, at: NOW, seq: 1 }] }, { isVersioned: true })
  on('ui.toast', () => ({ value: undefined as never }))
  const ui = await mountPane($, 'terminal')
  await $.ui.input({ plugin: 'sc-workspace', key: 'note-new', text: 'three' })
  await ui.press({ key: 'toggle-n1' })
  const kept = values.notes as { text: string; isDone: boolean }[]
  expect(kept.map(note => [note.text, note.isDone])).toEqual([
    ['three', false],
    ['one', true],
  ])
  await ui.unmount()
})
