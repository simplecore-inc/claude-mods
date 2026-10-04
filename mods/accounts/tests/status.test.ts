import { expect, test } from 'claude-code/testing'

import { StatusCollector, transcriptPath } from '../hooks/collector'
import type { CollectorIo } from '../hooks/collector'
import { displayModel, editedPath, inProgressTask, lineChanges, parsePr, settledEffort, todoFilesOf, ultracodeAfter } from '../hooks/status'

test('a model id reads as Claude Code names it on screen', async () => {
  expect(displayModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(displayModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(displayModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(displayModel('Opus 5.5')).toBe('Opus 5.5')
})

test('lines added and removed between two versions, as a diff stat counts them', async () => {
  expect(lineChanges('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 })
  expect(lineChanges(null, 'x\ny')).toEqual({ added: 2, removed: 0 })
  expect(lineChanges('x\ny\n', null)).toEqual({ added: 0, removed: 2 })
  expect(lineChanges('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
})

test('only file-changing tools name a file to count', async () => {
  expect(editedPath('Edit', { file_path: '/a.ts' })).toBe('/a.ts')
  expect(editedPath('NotebookEdit', { notebook_path: '/n.ipynb' })).toBe('/n.ipynb')
  expect(editedPath('Read', { file_path: '/a.ts' })).toBeNull()
  expect(editedPath('Write', {})).toBeNull()
})

test('ultracode follows attachment records only, never a line that mentions them', async () => {
  const enter = JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } })
  const exit = JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_exit' } })
  const mention = JSON.stringify({ type: 'user', message: { content: '"type":"ultra_effort_exit"' } })
  expect(ultracodeAfter(`${enter}\n`, false)).toBe(true)
  expect(ultracodeAfter(`${enter}\n${mention}\n`, false)).toBe(true)
  expect(ultracodeAfter(`${enter}\n${exit}\n`, false)).toBe(false)
  expect(ultracodeAfter('{broken\n', true)).toBe(true)
})

test('the in-progress task, the session\'s newest todo list, the PR and the settled effort', async () => {
  expect(inProgressTask(JSON.stringify([{ status: 'completed', activeForm: 'Old' }, { status: 'in_progress', activeForm: 'Writing tests' }]))).toBe('Writing tests')
  expect(inProgressTask('not json')).toBe('')
  expect(
    todoFilesOf(
      [
        { name: 's1-agent-a.json', mtimeMs: 1 },
        { name: 's1-agent-b.json', mtimeMs: 2 },
        { name: 's2-agent-c.json', mtimeMs: 3 },
      ],
      's1',
    ),
  ).toEqual(['s1-agent-b.json', 's1-agent-a.json'])
  expect(parsePr('{"number":12,"reviewDecision":"APPROVED"}')).toEqual({ number: 12, reviewState: 'approved' })
  expect(parsePr('{"number":12,"reviewDecision":"REVIEW_REQUIRED"}')).toEqual({ number: 12, reviewState: null })
  expect(parsePr('no pull requests found')).toBeNull()
  expect(settledEffort({ effortLevel: 'xhigh', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, 'claude-opus-5-5')).toBe('high')
  expect(settledEffort({ effortLevel: 'xhigh' }, 'claude-sonnet-5-5')).toBe('xhigh')
})

test('the transcript sits in the project folder Claude Code names after the root', async () => {
  expect(transcriptPath('/home/me', '/Users/me/Work/claude-mods', 's1')).toBe('/home/me/.claude/projects/-Users-me-Work-claude-mods/s1.jsonl')
})

test('the collector scans only what the transcript gained, and asks gh once per window', async () => {
  const calls: string[][] = []
  let size = 100
  const io: CollectorIo = {
    run: async argv => {
      calls.push([...argv])
      if (argv[0] === 'sh') {
        return { exitCode: 0, stdout: `${JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } })}\n`, stderr: '' }
      }
      if (argv[0] === 'gh') return { exitCode: 0, stdout: '{"number":7,"reviewDecision":""}', stderr: '' }

      return { exitCode: 0, stdout: 'main\n', stderr: '' }
    },
    read: async () => null,
    list: async () => [],
    size: async () => size,
  }
  const collector = new StatusCollector(io)
  expect(await collector.ultracode('/t.jsonl')).toBe(true)
  // The scan starts at byte 1 and reads up to the size.
  expect(calls.at(-1)?.slice(4, 7)).toEqual(['/t.jsonl', '100', '1'])
  // Nothing appended: no scan.
  const scans = calls.length
  expect(await collector.ultracode('/t.jsonl')).toBe(true)
  expect(calls.length).toBe(scans)
  size = 150
  await collector.ultracode('/t.jsonl')
  expect(calls.at(-1)?.slice(4, 7)).toEqual(['/t.jsonl', '150', '101'])
  // gh once per three minutes on one branch.
  expect(await collector.pullRequest('/w', 'main', 0)).toEqual({ number: 7, reviewState: null })
  await collector.pullRequest('/w', 'main', 60_000)
  expect(calls.filter(argv => argv[0] === 'gh').length).toBe(1)
  await collector.pullRequest('/w', 'main', 200_000)
  expect(calls.filter(argv => argv[0] === 'gh').length).toBe(2)
})
