import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { mountPane, NOW, openQuick, seedState } from './paneHarness'

/**
 * What text from outside the plugin may hold: a colour sequence, a bell, a
 * backspace, a form feed and a C1 control. The engine refuses a whole tree
 * whose text holds any of them, so every place that draws such text cleans it.
 */
const DIRTY = 'x\u001b[31mred\u001b[0m\u0007\b\f\u0085y'
const CLEAN = 'xredy'

const SHELL = { id: 't1', name: `tool ${DIRTY}`, kind: 'shell', run: `echo ${DIRTY}` }
const RUN = { t1: { state: 'failed', startedAt: NOW - 9_000, endedAt: NOW - 5_000, code: 1, command: `echo ${DIRTY}` } }
const ASKS = { id: 't2', name: `ask ${DIRTY}`, kind: 'shell', run: 'cat {{file}}', params: { file: { type: 'path', mode: 'ask' } } }
const CONFIRMS = { id: 't3', name: `danger ${DIRTY}`, kind: 'claude', run: `/clear ${DIRTY}`, confirm: true }

const SEEDS: [string, Record<string, unknown>][] = [
  ['the Tools tab', { tools: [SHELL, ASKS, CONFIRMS], runs: RUN, toolsError: `problem ${DIRTY}` }],
  [
    'the Add tab',
    {
      tab: 'add',
      detected: [{ source: 'npm', name: `build ${DIRTY}`, run: 'npm run build', description: `vite ${DIRTY}` }],
      commands: [{ name: 'clear', description: `Clear ${DIRTY}`, source: 'builtin' }],
    },
  ],
  ['the values dialog', { tools: [ASKS], runs: {}, dialog: { kind: 'ask', id: 't2' }, draft: { file: `a${DIRTY}` }, suggest: { field: 'file', items: [`b${DIRTY}`] } }],
  ['the confirm dialog', { tools: [CONFIRMS], runs: {}, dialog: { kind: 'confirm', id: 't3' } }],
  ['the edit dialog', { tools: [], runs: {}, dialog: { kind: 'edit', id: '' }, draft: { kind: 'shell', name: `new ${DIRTY}`, run: `echo ${DIRTY}`, cwd: '', submit: 'fill', confirm: 'run' } }],
  ['the remove dialog', { tools: [SHELL], runs: RUN, dialog: { kind: 'remove', id: 't1' } }],
]

/** Every string the tree draws, keys left out: a key is an address the engine never shows. */
function drawnStrings(tree: unknown): string[] {
  const found: string[] = []
  JSON.stringify(tree, (name, value: unknown) => {
    if (name !== 'key' && typeof value === 'string') found.push(value)

    return value
  })

  return found
}

async function expectClean($: Engine): Promise<void> {
  // A refused tree rejects the mount: the pane would be drawn blank.
  const ui = await mountPane($)
  const strings = drawnStrings(await ui.drawn())
  expect(strings.filter(text => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text))).toEqual([])
  expect(strings.some(text => text.includes(CLEAN))).toBe(true)
  await ui.unmount()
}

for (const [where, seed] of SEEDS) {
  test(`text from outside holding control characters still draws ${where}, cleaned`, async ($, on) => {
    seedState(on, seed)
    await expectClean($)
  })
}

test('text from outside holding control characters still draws the quick view, cleaned', async ($, on) => {
  seedState(on, { tools: [SHELL, ASKS], runs: RUN })
  await openQuick($, on)
  await expectClean($)
})

/** Stands in for the log file a run left: there, with `text` in it. */
function logFile(on: On, text: string): void {
  on('fs.exists', () => ({ value: true as never }))
  on('fs.read', () => ({ value: text as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
}

for (const [what, log] of [
  ['a colour sequence and a bell', `compiling\nline ${DIRTY}\n`],
  ['tput sgr0 (ESC ( B) and a cursor save (ESC 7)', `compiling\nline x\u001b7red\u001b8\u001b(B\u001b[my\n`],
] as const) {
  test(`a run's log holding ${what} still draws in its dialog, cleaned`, async ($, on) => {
    seedState(on, { tools: [SHELL], runs: RUN }, { isWritable: true })
    logFile(on, log)
    const list = await mountPane($)
    await list.press({ key: 'tool-log-t1' })
    await list.unmount()
    await expectClean($)
  })
}
