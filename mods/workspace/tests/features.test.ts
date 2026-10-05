import { describe, expect, test } from 'claude-code/testing'

import type { DiffView } from '../types'
import { finishAgents, keptCheckpoints, mergeCheckpoints, promptLabel } from '../hooks/git'
import { doneMarks, nextSeq, notesContext, numbered } from '../hooks/notes'
import { messagesFor } from '../hooks/i18n'
import { activityText, toolSummary } from '../hooks/views/agents'
import { checkpointLabel } from '../hooks/views/checkpoints'
import { commitPrompt, targetChoices, targetLabel } from '../hooks/views/diff'
import { restoreFile } from '../hooks/workspace'
import type { Run } from '../hooks/workspace'

const m = messagesFor('en')
const NOW = Date.parse('2026-10-04T05:00:00Z')

describe('promptLabel', () => {
  test('takes the first line the person wrote, leaving the harness blocks out', async () => {
    expect(promptLabel('<system-reminder>\nnoise\n</system-reminder>\nfix the login bug')).toBe('fix the login bug')
    expect(promptLabel('look at this\n<pasted_content id="a40d">\nError: boom\n</pasted_content>')).toBe('look at this')
  })

  test('falls back to pasted text, then to a task notification summary', async () => {
    expect(promptLabel('<pasted_content id="a40d">\nError: boom\nat line 3\n</pasted_content>')).toBe('Error: boom')
    expect(promptLabel('<task-notification>\n<task-id>abc</task-id>\n<summary>Agent "Review" completed</summary>\n</task-notification>')).toBe(
      'Agent "Review" completed',
    )
  })

  test('a label stored cut short, only an opening tag, reads as nothing', async () => {
    expect(promptLabel('<task-notification>')).toBe('')
    expect(promptLabel('<pasted_content id="a40d">')).toBe('')
    expect(checkpointLabel({ label: '<task-notification>', kind: 'turn' }, m)).toBe('Prompt')
    expect(checkpointLabel({ label: 'fix the login bug', kind: 'turn' }, m)).toBe('fix the login bug')
  })
})

describe('restoreFile', () => {
  /** A runner that records each command and answers success. */
  function recording(): { run: Run; calls: string[][] } {
    const calls: string[][] = []

    return { calls, run: async argv => (calls.push([...argv]), { exitCode: 0, stdout: '', stderr: '' }) }
  }

  test('a changed or deleted file is written back from the checkpoint', async () => {
    const { run, calls } = recording()
    const result = await restoreFile(run, '/repo', 'c1', { path: 'src/a.ts', status: 'modified', added: 1, removed: 2 })
    expect(result).toEqual({ written: ['src/a.ts'], removed: [] })
    expect(calls).toEqual([['git', '--literal-pathspecs', 'restore', '--source=c1', '--worktree', '--', 'src/a.ts']])
  })

  test('a file made since is removed, and nothing is written back', async () => {
    const { run, calls } = recording()
    expect(await restoreFile(run, '/repo', 'c1', { path: 'new.ts', status: 'added', added: 3, removed: 0 })).toEqual({ written: [], removed: ['new.ts'] })
    expect(calls).toEqual([['rm', '-f', '--', 'new.ts']])
  })

  test('a rename is undone: the old path back, the new one removed', async () => {
    const { run, calls } = recording()
    const result = await restoreFile(run, '/repo', 'c1', { path: 'b.ts', from: 'a.ts', status: 'renamed', added: 0, removed: 0 })
    expect(result).toEqual({ written: ['a.ts'], removed: ['b.ts'] })
    expect(calls[0]).toEqual(['git', '--literal-pathspecs', 'restore', '--source=c1', '--worktree', '--', 'a.ts'])
    expect(calls[1]).toEqual(['rm', '-f', '--', 'b.ts'])
  })
})

describe('the Diff tab comparing two checkpoints', () => {
  const base = { commit: 'c1', label: 'Session start', at: NOW - 3_600_000, isSessionStart: true }
  const later = { commit: 'c2', label: 'Fix the login bug', at: NOW - 60_000, isSessionStart: false }
  const earlier = { commit: 'c0', label: 'Older', at: NOW - 7_200_000, isSessionStart: false }

  test('offers the working tree first, then only checkpoints after the base, newest first', async () => {
    const choices = targetChoices([earlier, later, base], { base }, NOW, 'en', m)
    expect(choices.map(choice => choice.key)).toEqual(['target-now', 'target-c2'])
    expect(choices[0]).toMatchObject({ isCurrent: true, target: null })
    expect(targetChoices([later], { base, target: later }, NOW, 'en', m)[1]).toMatchObject({ isCurrent: true })
  })

  test('names the working tree, or the checkpoint compared up to', async () => {
    expect(targetLabel(undefined, NOW, 'en', m)).toBe('Working tree')
    expect(targetLabel(later, NOW, 'en', m)).toMatch(/Fix the login bug$/)
  })

  test('the commit message request names the range and every file with its counts', async () => {
    const view: DiffView = {
      base,
      files: [
        { path: 'src/app.ts', status: 'modified', added: 8, removed: 2 },
        { path: 'logo.png', status: 'modified', added: null, removed: null },
        { path: 'b.ts', from: 'a.ts', status: 'renamed', added: 0, removed: 0 },
      ],
      at: NOW,
    }
    const text = commitPrompt(view, NOW, 'en', m)
    expect(text).toMatch(/^Draft a commit message for the changes from .*Session start to Working tree:/)
    expect(text).toContain('- M src/app.ts (+8 −2)')
    expect(text).toContain('- M logo.png (binary)')
    expect(text).toContain('- R a.ts → b.ts (+0 −0)')
    expect(text).toContain('without committing')
  })
})

describe('agent activity', () => {
  test('a tool call reads as the tool and the first line of what it works on', async () => {
    expect(toolSummary('Bash', { command: 'npm test\n--watch', description: 'Run tests' })).toBe('Bash: npm test')
    expect(toolSummary('Edit', { file_path: 'src/app.ts', old_string: 'a' })).toBe('Edit: src/app.ts')
    expect(toolSummary('TodoWrite', { todos: [] })).toBe('TodoWrite')
  })

  test('an answer is marked, and every activity starts with how long ago', async () => {
    expect(activityText({ text: 'Bash: npm test', isAnswer: false, at: NOW - 120_000 }, NOW, m)).toBe('2m ago · Bash: npm test')
    expect(activityText({ text: 'All tests pass', isAnswer: true, at: NOW - 30_000 }, NOW, m)).toBe('<1m ago · ✔ All tests pass')
  })
})

describe('notes as tasks', () => {
  const note = (id: string, at: number, seq?: number) => ({ id, text: id, isDone: false, at, ...(seq !== undefined ? { seq } : {}) })

  test('numbers the notes that have none, oldest first, after the highest number given', async () => {
    const list = numbered([note('c', 3), note('a', 1, 4), note('b', 2)])
    expect(list.map(one => [one.id, one.seq])).toEqual([
      ['c', 6],
      ['a', 4],
      ['b', 5],
    ])
    expect(nextSeq(list)).toBe(7)
  })

  test('sends each open note by its number, with how to say one is done', async () => {
    const text = notesContext('app', [note('Fix the retry', 1, 3)])
    expect(text).toContain('- N3: Fix the retry')
    expect(text).toContain('[done N<number>]')
  })

  test('reads the numbers an answer marks done, and nothing else', async () => {
    expect(doneMarks('Fixed it [done N3]. Also [done N12].')).toEqual([3, 12])
    expect(doneMarks('done N3, [done N] and [Done N4]')).toEqual([])
  })
})

test('a checkpoint the person named is shown by its name', async () => {
  expect(checkpointLabel({ label: 'fix the login bug', kind: 'turn', name: 'Before the refactor' }, m)).toBe('Before the refactor')
  expect(checkpointLabel({ label: 'fix the login bug', kind: 'turn', name: '  ' }, m)).toBe('fix the login bug')
})

test('pinned checkpoints are kept past the limit; the oldest unpinned ones go', async () => {
  const row = (ref: string, isPinned = false) => ({ ref, commit: ref, tree: ref, at: 0, label: '', kind: 'turn' as const, ...(isPinned ? { isPinned } : {}) })
  const { kept, gone } = keptCheckpoints([row('r4'), row('r3', true), row('r2'), row('r1', true), row('r0')], 2)
  expect(kept.map(one => one.ref)).toEqual(['r4', 'r3', 'r2', 'r1'])
  expect(gone.map(one => one.ref)).toEqual(['r0'])
})

test('an agent the engine stops listing moves to the finished group with its answer', async () => {
  const agent = (id: string) => ({ id, stopId: id, label: id, type: 'Explore', status: 'running' as const, firstSeen: 0 })
  const after = finishAgents([agent('a1'), agent('a2')], [agent('a2')], [], { a1: 'All done.' }, 500, 20)
  expect(after).toEqual([{ ...agent('a1'), endedAt: 500, answer: 'All done.' }])
  // Listed again, it leaves the group; the group keeps at most `limit`.
  expect(finishAgents([], [agent('a1')], after, {}, 600, 20)).toEqual([])
  const many = finishAgents([agent('a3'), agent('a4')], [], after, {}, 700, 2)
  expect(many.map(one => one.id)).toEqual(['a3', 'a4'])
})

test('the session\'s start is kept past the limit, as the Diff tab\'s default base', async () => {
  const row = (ref: string) => ({ ref, commit: ref, tree: ref, at: 0, label: '', kind: 'turn' as const })
  const { gone } = keptCheckpoints([row('r3'), row('r2'), row('r1'), row('r0')], 2, ['r0'])
  expect(gone.map(one => one.ref)).toEqual(['r1'])
})

test('rows another session stored are kept when this one saves, its own winning where both have one', async () => {
  const row = (ref: string, at: number, label = '') => ({ ref, commit: ref, tree: ref, at, label, kind: 'turn' as const })
  const merged = mergeCheckpoints([row('a2', 30, 'mine'), row('a1', 10)], [row('b1', 20), row('a2', 30, 'stale')])
  expect(merged.map(one => [one.ref, one.label])).toEqual([
    ['a2', 'mine'],
    ['b1', ''],
    ['a1', ''],
  ])
})
