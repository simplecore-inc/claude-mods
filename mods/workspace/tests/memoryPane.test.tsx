import { expect, test } from 'claude-code/testing'

import { seedState, mountPane } from './paneHarness'

const MEMORY_FILES = [
  { path: '/home/me/.claude/CLAUDE.md', display: '~/.claude/CLAUDE.md', scope: 'global', kind: 'user', bytes: 900, lines: 40, outline: [{ line: 1, text: 'Global instructions', level: 1 }, { line: 9, text: 'Git', level: 2 }] },
  { path: '/repo/CLAUDE.md', display: 'CLAUDE.md', scope: 'project', kind: 'project', bytes: 300, lines: 12, outline: [] },
  { path: '/repo/docs/rules.md', display: 'docs/rules.md', scope: 'project', kind: 'imported', bytes: 100, lines: 5, outline: [], note: 'CLAUDE.md' },
  { path: '/home/me/.claude/projects/-repo/memory/x.md', display: '~/.claude/projects/-repo/memory/x.md', scope: 'project', kind: 'auto', bytes: 80, lines: 6, outline: [], note: 'every release updates the pictures' },
]

test('the Memory tab lists the global and the project files apart, each with what it is to Claude Code', async ($, on) => {
  seedState(on, { tab: 'memory', memory: MEMORY_FILES })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'tab-memory' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Global' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Project' })).toBeDefined()
  expect((await ui.find({ key: 'memory-open-/home/me/.claude/CLAUDE.md' }))?.text).toBe('~/.claude/CLAUDE.md')
  expect((await ui.find({ key: 'memory-outline-toggle-/home/me/.claude/CLAUDE.md' }))?.text).toBe('▸')
  expect(await ui.find({ type: 'Text', text: 'your instructions · 40 lines' })).toBeDefined()
  expect((await ui.find({ key: 'memory-note-/repo/docs/rules.md' }))?.text).toBe('↳ from CLAUDE.md')
  expect((await ui.find({ key: 'memory-note-/home/me/.claude/projects/-repo/memory/x.md' }))?.text).toBe('↳ every release updates the pictures')
  expect(await ui.find({ key: 'memory-search-input' })).toBeDefined()
  await ui.unmount()
})

test('an open memory file shows its outline with line numbers; a scope shows only its files', async ($, on) => {
  seedState(on, { tab: 'memory', memory: MEMORY_FILES, memoryOpen: '/home/me/.claude/CLAUDE.md', memoryScope: 'global' })
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'memory-outline-toggle-/home/me/.claude/CLAUDE.md' }))?.text).toBe('▾')
  expect((await ui.find({ key: 'memory-outline-/home/me/.claude/CLAUDE.md' }))?.text).toContain('9    Git')
  expect(await ui.find({ key: 'memory-open-/repo/CLAUDE.md' })).toBeUndefined()
  expect((await ui.find({ key: 'memory-scope-field' }))?.text).toBe('Global ▾')
  await ui.unmount()
})

test('on mobile, with no field, the Memory tab still lists the files', async ($, on) => {
  seedState(on, { tab: 'memory', memory: MEMORY_FILES })
  const ui = await mountPane($, 'mobile')
  expect(await ui.find({ key: 'memory-search-input' })).toBeUndefined()
  expect(await ui.find({ key: 'memory-open-/repo/CLAUDE.md' })).toBeDefined()
  await ui.unmount()
})
