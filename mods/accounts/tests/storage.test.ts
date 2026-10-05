import { describe, expect, test } from 'claude-code/testing'

import { removeTreeArgv } from '../hooks/shared/files'
import { byteSize, cleanupPlan, cleanupTargets, sessionsOf, summarizeStorage } from '../hooks/storage'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-05T00:00:00Z')
const FILES = [
  { relative: '-w-app/s1.jsonl', size: 1000, mtimeMs: NOW - 40 * DAY },
  { relative: '-w-app/s1/subagents/agent-a.jsonl', size: 5000, mtimeMs: NOW - 41 * DAY },
  { relative: '-w-app/s1/tool-results/out.txt', size: 300, mtimeMs: NOW - 41 * DAY },
  { relative: '-w-app/s2.jsonl', size: 2000, mtimeMs: NOW - 2 * DAY },
  { relative: '-w-lib/s3.jsonl', size: 700, mtimeMs: NOW - 60 * DAY },
  { relative: '-w-lib/s4/subagents/agent-b.jsonl', size: 900, mtimeMs: NOW - 90 * DAY },
]

describe('what the projects folder holds', () => {
  test('by kind: session transcripts, subagent transcripts, and the rest', async () => {
    const summary = summarizeStorage(FILES)
    expect(summary.transcripts).toEqual({ count: 3, bytes: 3700 })
    expect(summary.subagents).toEqual({ count: 2, bytes: 5900 })
    expect(summary.other).toEqual({ count: 1, bytes: 300 })
    expect(summary.bytes).toBe(9900)
    expect(summary.sessions).toBe(4)
    expect(summary.projects.map(project => [project.folder, project.bytes, project.sessions])).toEqual([
      ['-w-app', 8300, 2],
      ['-w-lib', 1600, 2],
    ])
  })

  test('a session is its transcript and its folder, whichever exist', async () => {
    const sessions = sessionsOf(FILES)
    expect(sessions.find(session => session.session === 's1')?.paths).toEqual(['-w-app/s1.jsonl', '-w-app/s1'])
    expect(sessions.find(session => session.session === 's2')?.paths).toEqual(['-w-app/s2.jsonl'])
    expect(sessions.find(session => session.session === 's4')?.paths).toEqual(['-w-lib/s4'])
    // A session is as old as its newest file.
    expect(sessions.find(session => session.session === 's1')?.lastActive).toBe(NOW - 40 * DAY)
  })
})

describe('a cleanup', () => {
  test('chooses the sessions idle over the age, never one of those kept', async () => {
    const plan = cleanupPlan(sessionsOf(FILES), 30, NOW, ['s3'])
    expect(plan.sessions.map(session => session.session).sort()).toEqual(['s1', 's4'])
    expect(plan.bytes).toBe(7200)
    expect(cleanupPlan(sessionsOf(FILES), 100, NOW, []).sessions).toEqual([])
  })

  test('deletes each path with what is under it, the paths as arguments', async () => {
    expect(removeTreeArgv(['/c/projects/-w-app/s1.jsonl', '/c/projects/-w-app/s1'], false)).toEqual(['rm', '-rf', '--', '/c/projects/-w-app/s1.jsonl', '/c/projects/-w-app/s1'])
    const windows = removeTreeArgv(["C:/c/it's"], true)
    expect(windows.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  })

  test('sizes read short', async () => {
    expect(byteSize(512)).toBe('512 B')
    expect(byteSize(12_700)).toBe('12.4 KB')
    expect(byteSize(17 * 1024 ** 3)).toBe('17.0 GB')
  })
})

test('a cleanup deletes only under the projects folder: any path reaching out stops it all', async () => {
  expect(cleanupTargets('/c/projects', ['-w-app/s1.jsonl', '-w-app/s1'])).toEqual(['/c/projects/-w-app/s1.jsonl', '/c/projects/-w-app/s1'])
  for (const bad of ['../x', '-w-app/../../x', '/etc/passwd', 'C:\\x', '-w-app//s1', '', './s1', '-w-app\\..\\x']) {
    expect(() => cleanupTargets('/c/projects', ['-w-app/s1.jsonl', bad])).toThrow(/refused to delete outside/)
  }
})
