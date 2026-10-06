import { describe, expect, test } from 'claude-code/testing'

import { hunkProblems } from './diffCheck'
import {
  checkpointRef,
  clipDiff,
  countChanged,
  diffPages,
  isRemovable,
  parseDiffFiles,
  parseLeftRight,
  parseWorktrees,
  promptLabel,
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
    // The NUL form git prints with -z: a rename's paths are fields of their own.
    const nameStatus = ['M', 'src/a.ts', 'A', 'new.md', 'D', 'old.md', 'R087', 'src/b.ts', 'src/c.ts', 'M', 'image.png', ''].join('\0')
    const numstat = ['2\t1\tsrc/a.ts', '5\t0\tnew.md', '0\t3\told.md', '1\t1\t', 'src/b.ts', 'src/c.ts', '-\t-\timage.png', ''].join('\0')
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
})

test('labels, refs, paths and clipped diffs', async () => {
  expect(promptLabel('  fix the login bug\nand more')).toBe('fix the login bug')
  expect(promptLabel('x'.repeat(80), 10)).toBe(`${'x'.repeat(9)}…`)
  expect(checkpointRef('s1', 7)).toBe('refs/sc/checkpoints/s1/0007')
  expect(shortPath('/repo/sub', '/repo', '/home/u')).toBe('sub')
  expect(shortPath('/repo', '/repo', '/home/u')).toBe('.')
  expect(shortPath('/home/u/x', '/repo', '/home/u')).toBe('~/x')
  expect(clipDiff('a\nb\nc', 2, 1000)).toEqual({ text: 'a\nb', omitted: 1 })
  expect(clipDiff('a', 2, 1000)).toEqual({ text: 'a', omitted: 0 })
  expect(clipDiff('@@ -1 +1 @@\n-a\n+b\n', 10, 1000)).toEqual({ text: '@@ -1 +1 @@\n-a\n+b', omitted: 0 })
  // A line of thousands (an SVG, a minified file) is cut and marked; the whole stays within its characters.
  const long = `+${'x'.repeat(5000)}`
  const one = clipDiff(`@@ -0,0 +1 @@\n${long}`, 10, 1000)
  expect(one.text).toBe(`@@ -0,0 +1 @@\n+${'x'.repeat(399)}…`)
  const many = clipDiff(Array.from({ length: 300 }, () => long).join('\n'), 400, 9_500)
  expect(many.text.length).toBeLessThanOrEqual(9_500)
  // Ordinary lines, many of them: the characters stop it before the line limit does.
  const ordinary = clipDiff(Array.from({ length: 400 }, (_, index) => `+const line${index} = 'an ordinary line of source code here'`).join('\n'), 400, 9_500)
  expect(ordinary.text.length).toBeLessThanOrEqual(9_500)
  expect(ordinary.omitted).toBeGreaterThan(0)
  expect(many.omitted).toBe(300 - many.text.split('\n').length)
})

describe('diffPages', () => {
  /** The body lines of a diff in order, every hunk header left out: what the pages must hold once each. */
  const bodyOf = (text: string) => text.split('\n').filter(line => !line.startsWith('@@'))

  const SHAPES: [string, string][] = [
    [
      'two hunks, one longer than a page',
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ...['@@ -40,60 +40,61 @@ class A', ...Array.from({ length: 60 }, (_, line) => (line === 30 ? `-x ${line}\n+y ${line}\n+z` : ` ctx ${line}`))],
      ].join('\n'),
    ],
    ['a new file of 70 lines', ['@@ -0,0 +1,70 @@', ...Array.from({ length: 70 }, (_, line) => `+line ${line}`)].join('\n')],
    ['a deleted file of 50 lines', ['@@ -1,50 +0,0 @@', ...Array.from({ length: 50 }, (_, line) => `-line ${line}`)].join('\n')],
    [
      'a missing newline marker where a page would be cut',
      ['@@ -1,23 +1,23 @@', ...Array.from({ length: 22 }, (_, line) => ` ctx ${line}`), '-last', '\\ No newline at end of file', '+last'].join('\n'),
    ],
    // clipDiff cut the hunk short: its header counts more lines than are left.
    ['a hunk cut short', ['@@ -1,400 +1,400 @@', ...Array.from({ length: 30 }, (_, line) => ` ctx ${line}`)].join('\n')],
  ]

  for (const [shape, text] of SHAPES) {
    test(`every page of ${shape} is whole hunks of at most the page's lines, holding every line once, in order`, async () => {
      const pages = diffPages(text, 24)
      for (const page of pages) {
        expect(hunkProblems(page)).toEqual([])
        expect(page.split('\n').length).toBeLessThanOrEqual(24)
      }
      expect(pages.flatMap(page => bodyOf(page))).toEqual(bodyOf(text))
    })
  }

  test('a continued hunk starts where the page before stopped, its heading only on its first piece', async () => {
    const pages = diffPages(['@@ -10,30 +10,30 @@ fn main()', ...Array.from({ length: 30 }, (_, line) => ` ctx ${line}`)].join('\n'), 24)
    expect(pages.map(page => page.split('\n')[0])).toEqual(['@@ -10,23 +10,23 @@ fn main()', '@@ -33,7 +33,7 @@'])
    // A missing newline marker stays under the line it follows.
    const marked = diffPages(['@@ -1,23 +1,23 @@', ...Array.from({ length: 22 }, (_, line) => ` ctx ${line}`), '-last', '\\ No newline at end of file', '+last'].join('\n'), 24)
    expect(marked[1]?.split('\n').slice(1, 3)).toEqual(['-last', '\\ No newline at end of file'])
    expect(diffPages('', 24)).toEqual([''])
    expect(diffPages('Binary files a/x.png and b/x.png differ', 24)).toEqual(['Binary files a/x.png and b/x.png differ'])
  })
})
