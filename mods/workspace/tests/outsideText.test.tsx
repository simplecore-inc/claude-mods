import { expect, test } from 'claude-code/testing'

import { mountPane, NOW, seedState } from './paneHarness'

/**
 * What text from outside the plugin may hold: a colour sequence, a bell, a
 * backspace, a form feed and a C1 control. The engine refuses a whole tree
 * whose text holds any of them, so every place that draws such text cleans it.
 */
const DIRTY = 'x\u001b[31mred\u001b[0m\u0007\b\f\u0085y'
const CLEAN = 'xredy'

const BASE = { commit: 'c1', label: `base ${DIRTY}`, at: NOW - 3_600_000, isSessionStart: true }
const CHECKPOINT = { ref: 'refs/sc/checkpoints/s/0002', commit: 'c2', tree: 't2', at: NOW - 60_000, label: `prompt ${DIRTY}`, kind: 'turn', since: { files: 1, added: 1, removed: 0 } }
const NAMED = { ...CHECKPOINT, ref: 'refs/sc/checkpoints/s/0001', commit: 'c1', tree: 't1', at: NOW - 3_600_000, name: `name ${DIRTY}` }
const FILE = { path: `src/${DIRTY}.ts`, status: 'modified', added: 1, removed: 1 }
const DIFF = {
  base: BASE,
  files: [FILE],
  selected: { path: FILE.path, text: `@@ -1 +1 @@\n-old ${DIRTY}\n+new ${DIRTY}`, omitted: 0 },
  at: NOW,
}
const AGENT = { id: 'a1', stopIds: ['a1'], label: `agent ${DIRTY}`, type: `type ${DIRTY}`, status: 'running', firstSeen: NOW - 60_000 }
const FINISHED = { ...AGENT, id: 'f1', status: 'completed', endedAt: NOW, answer: `answer ${DIRTY}` }
const WORKTREES = [
  { path: '/repo', branch: 'main', isMain: true, isLocked: false, changed: 0 },
  { path: `/repo-${DIRTY}`, branch: `wip-${DIRTY}`, isMain: false, isLocked: false, changed: 0, ahead: 0, behind: 0 },
]
const MEMORY = [
  {
    path: '/repo/CLAUDE.md',
    display: `CLAUDE ${DIRTY}.md`,
    scope: 'project',
    kind: 'imported',
    bytes: 10,
    lines: 2,
    outline: [{ line: 1, text: `heading ${DIRTY}`, level: 1 }],
    note: `note ${DIRTY}`,
  },
]

const SEEDS: [string, Record<string, unknown>][] = [
  ['the Agents tab', { agents: [AGENT], activity: { a1: { text: `Bash: ${DIRTY}`, isAnswer: false, at: NOW } }, finished: [FINISHED], expandedAgent: 'f1', worktrees: WORKTREES }],
  ['the Checkpoints tab', { tab: 'checkpoints', checkpoints: [CHECKPOINT, NAMED] }],
  ['the Notes tab', { tab: 'notes', notes: [{ id: 'n1', text: `note ${DIRTY}`, isDone: false, at: NOW, seq: 1, isSuggestedDone: true }] }],
  ['the Diff tab', { tab: 'diff', diff: DIFF }],
  ['the Memory tab', { tab: 'memory', memory: MEMORY, memoryOpen: '/repo/CLAUDE.md', memoryQuery: '' }],
  ['the diff dialog', { tab: 'diff', diff: DIFF, dialog: { kind: 'diff', ref: FILE.path } }],
  ['the restore dialog', { tab: 'checkpoints', checkpoints: [CHECKPOINT, NAMED], dialog: { kind: 'restore', ref: CHECKPOINT.ref } }],
  ['the file restore dialog', { tab: 'diff', diff: { ...DIFF, selected: undefined }, dialog: { kind: 'file', ref: FILE.path } }],
  ['the note dialog', { tab: 'notes', notes: [{ id: 'n1', text: `note ${DIRTY}`, isDone: false, at: NOW }], dialog: { kind: 'note', ref: 'n1' } }],
  ['the stop dialog', { agents: [AGENT], dialog: { kind: 'stop', ref: 'a1' } }],
  ['the worktree dialog', { worktrees: WORKTREES, dialog: { kind: 'worktree', ref: WORKTREES[1]?.path } }],
  ['the base dialog', { tab: 'diff', diff: DIFF, checkpoints: [CHECKPOINT, NAMED], dialog: { kind: 'base', ref: '' } }],
  ['the target dialog', { tab: 'diff', diff: { ...DIFF, base: { ...BASE, at: NOW - 7_200_000 } }, checkpoints: [CHECKPOINT, NAMED], dialog: { kind: 'target', ref: '' } }],
  ['the name dialog', { tab: 'checkpoints', checkpoints: [CHECKPOINT, NAMED], dialog: { kind: 'name', ref: NAMED.ref } }],
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

for (const [where, seed] of SEEDS) {
  test(`text from outside holding control characters still draws ${where}, cleaned`, async ($, on) => {
    seedState(on, seed)
    for (const surface of ['terminal', 'desktop'] as const) {
      // A refused tree rejects the mount: the pane would be drawn blank.
      const ui = await mountPane($, surface)
      const strings = drawnStrings(await ui.drawn())
      expect(strings.filter(text => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text))).toEqual([])
      expect(strings.some(text => text.includes(CLEAN))).toBe(true)
      await ui.unmount()
    }
  })
}
