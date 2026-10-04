import { describe, expect, test } from 'claude-code/testing'

import {
  checkpointRef,
  clipDiff,
  DIFF_CHARS,
  countChanged,
  isRemovable,
  parseDiffFiles,
  parseLeftRight,
  parseWorktrees,
  promptLabel,
  renamedTo,
  shortPath,
} from '../hooks/git'

describe('parseWorktrees', () => {
  test('reads each record, its branch, and the bare, detached and locked markers', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD 1111',
      'branch refs/heads/main',
      '',
      'worktree /repo-wt',
      'HEAD 2222',
      'branch refs/heads/feature/x',
      'locked reason',
      '',
      'worktree /repo-detached',
      'HEAD 3333',
      'detached',
      '',
    ].join('\n')
    const rows = parseWorktrees(porcelain)
    expect(rows.map(row => row.path)).toEqual(['/repo', '/repo-wt', '/repo-detached'])
    expect(rows[1]).toMatchObject({ branch: 'feature/x', isLocked: true, isDetached: false })
    expect(rows[2]).toMatchObject({ branch: undefined, isDetached: true })
  })
})

test('parseLeftRight and countChanged', async () => {
  expect(parseLeftRight('3\t5\n')).toEqual({ behind: 3, ahead: 5 })
  expect(parseLeftRight('')).toBeUndefined()
  expect(countChanged(' M a.txt\n?? b.txt\n')).toBe(2)
  expect(countChanged('')).toBe(0)
})

test('isRemovable needs a clean, merged, unlocked worktree that is not the main one', async () => {
  const row = { path: '/w', branch: 'b', isMain: false, isLocked: false, changed: 0, ahead: 0, behind: 2 }
  expect(isRemovable(row)).toBe(true)
  expect(isRemovable({ ...row, changed: 1 })).toBe(false)
  expect(isRemovable({ ...row, ahead: 1 })).toBe(false)
  expect(isRemovable({ ...row, ahead: undefined })).toBe(false)
  expect(isRemovable({ ...row, isLocked: true })).toBe(false)
  expect(isRemovable({ ...row, isMain: true })).toBe(false)
})

describe('parseDiffFiles', () => {
  test('joins name-status and numstat, renames by their new path, binaries as null', async () => {
    const nameStatus = ['M\tsrc/a.ts', 'A\tnew.md', 'D\told.md', 'R087\tsrc/b.ts\tsrc/c.ts', 'M\timage.png'].join('\n')
    const numstat = ['2\t1\tsrc/a.ts', '5\t0\tnew.md', '0\t3\told.md', '1\t1\tsrc/{b.ts => c.ts}', '-\t-\timage.png'].join('\n')
    const files = parseDiffFiles(nameStatus, numstat)
    expect(files.map(file => `${file.status}:${file.path}:${file.added}:${file.removed}`)).toEqual([
      'modified:src/a.ts:2:1',
      'added:new.md:5:0',
      'deleted:old.md:0:3',
      'renamed:src/c.ts:1:1',
      'modified:image.png:null:null',
    ])
    expect(files[3]?.from).toBe('src/b.ts')
  })
  test('renamedTo reads both numstat spellings', async () => {
    expect(renamedTo('a.ts => b.ts')).toBe('b.ts')
    expect(renamedTo('src/{old => new}/f.ts')).toBe('src/new/f.ts')
    expect(renamedTo('src/{ => sub}/f.ts')).toBe('src/sub/f.ts')
    expect(renamedTo('plain.ts')).toBe('plain.ts')
  })
})

test('labels, refs, paths and clipped diffs', async () => {
  expect(promptLabel('  fix the login bug\nand more')).toBe('fix the login bug')
  expect(promptLabel('x'.repeat(80), 10)).toBe(`${'x'.repeat(9)}…`)
  expect(checkpointRef('s1', 7)).toBe('refs/sc/checkpoints/s1/0007')
  expect(shortPath('/repo/sub', '/repo', '/home/u')).toBe('sub')
  expect(shortPath('/repo', '/repo', '/home/u')).toBe('.')
  expect(shortPath('/home/u/x', '/repo', '/home/u')).toBe('~/x')
  expect(clipDiff('a\nb\nc', 2)).toEqual({ text: 'a\nb', omitted: 1 })
  expect(clipDiff('a', 2)).toEqual({ text: 'a', omitted: 0 })
  expect(clipDiff('@@ -1 +1 @@\n-a\n+b\n', 10)).toEqual({ text: '@@ -1 +1 @@\n-a\n+b', omitted: 0 })
  // A line of thousands (an SVG, a minified file) is cut and marked; the whole stays within the engine's bound.
  const long = `+${'x'.repeat(5000)}`
  const one = clipDiff(`@@ -0,0 +1 @@\n${long}`, 10)
  expect(one.text).toBe(`@@ -0,0 +1 @@\n+${'x'.repeat(399)}…`)
  const many = clipDiff(Array.from({ length: 300 }, () => long).join('\n'), 400)
  expect(many.text.length).toBeLessThanOrEqual(DIFF_CHARS)
  // Ordinary lines, many of them: the characters stop it before the line limit does.
  const ordinary = clipDiff(Array.from({ length: 400 }, (_, index) => `+const line${index} = 'an ordinary line of source code here'`).join('\n'), 400)
  expect(ordinary.text.length).toBeLessThanOrEqual(DIFF_CHARS)
  expect(ordinary.omitted).toBeGreaterThan(0)
  expect(many.omitted).toBe(300 - many.text.split('\n').length)
})
