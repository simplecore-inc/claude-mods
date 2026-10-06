import { expect, test } from 'claude-code/testing'

import { claudeFiles } from '../hooks/memory'
import { diffFiles, restoreCheckpoint, snapshotTree } from '../hooks/workspace'
import type { Run } from '../hooks/workspace'

/** A file a diff names: its status letter as git prints it, its path and its counts. */
type Changed = { status: string; path: string; from?: string; added: number; removed: number }

/** A path as git prints it in line output: quoted, each non-ASCII byte in octal, when it holds one or a quote. */
function quoted(path: string): string {
  if (!/[^\x20-\x7e]|["\\]/.test(path)) return path
  const bytes = [...new TextEncoder().encode(path)].map(byte => (byte >= 0x80 ? `\\${byte.toString(8)}` : byte === 0x22 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : String.fromCharCode(byte)))

  return `"${bytes.join('')}"`
}

/** Git as it answers: such a path quoted in line output, and as it is with -z. */
function git(files: Changed[]): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  const run: Run = async argv => {
    calls.push([...argv])
    const z = argv.includes('-z')
    const name = (path: string) => (z ? path : quoted(path))
    if (argv.includes('--name-status')) {
      return out(files.map(file => [file.status, ...(file.from ? [name(file.from)] : []), name(file.path)].join(z ? '\0' : '\t') + (z ? '\0' : '\n')).join(''))
    }
    if (argv.includes('--numstat')) {
      return out(
        files
          .map(file =>
            z
              ? file.from
                ? `${file.added}\t${file.removed}\t\0${file.from}\0${file.path}\0`
                : `${file.added}\t${file.removed}\t${file.path}\0`
              : `${file.added}\t${file.removed}\t${file.from ? `${name(file.from)} => ${name(file.path)}` : name(file.path)}\n`,
          )
          .join(''),
      )
    }
    if (argv.includes('--name-only')) return out(files.filter(file => file.status === 'A').map(file => `${name(file.path)}${z ? '\0' : '\n'}`).join(''))

    return out('')
  }

  return { run, calls }
}

test('a changed file is named as it is, a Korean name or a quote in it included', async () => {
  const { run } = git([
    { status: 'M', path: 'src/한글 노트.md', added: 1, removed: 1 },
    { status: 'A', path: 'a"b.txt', added: 2, removed: 0 },
    { status: 'R100', from: '옛 이름.md', path: '새 이름.md', added: 0, removed: 0 },
  ])
  const files = await diffFiles(run, '/repo', 'c1', 't1')
  expect(files.map(file => [file.status, file.path, file.added, file.removed])).toEqual([
    ['modified', 'src/한글 노트.md', 1, 1],
    ['added', 'a"b.txt', 2, 0],
    ['renamed', '새 이름.md', 0, 0],
  ])
  expect(files[2]?.from).toBe('옛 이름.md')
})

test('restoring a checkpoint removes every file made since it, a Korean name included', async () => {
  const { run, calls } = git([
    { status: 'A', path: '새 파일.md', added: 1, removed: 0 },
    { status: 'A', path: 'plain.md', added: 1, removed: 0 },
  ])
  expect(await restoreCheckpoint(run, '/repo', 'c1', 't1', 't2')).toBe(2)
  expect(calls.find(argv => argv[0] === 'rm')).toEqual(['rm', '-f', '--', '새 파일.md', 'plain.md'])
})

test('a subfolder\'s CLAUDE.md is found under a Korean folder name, and only those files', async () => {
  expect(claudeFiles('CLAUDE.md\0문서/CLAUDE.md\0api/CLAUDE.local.md\0src/NOTCLAUDE.md\0')).toEqual(['CLAUDE.md', '문서/CLAUDE.md', 'api/CLAUDE.local.md'])
})

test('two snapshots in one index run one after the other, as git\'s lock on the index needs', async () => {
  const events: string[] = []
  const run: Run = async argv => {
    events.push(`start ${argv[1]}`)
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    events.push(`end ${argv[1]}`)

    return { exitCode: 0, stdout: 'tree1\n', stderr: '' }
  }
  await Promise.all([snapshotTree(run, '/repo', '/repo/.git/i.index'), snapshotTree(run, '/repo', '/repo/.git/i.index')])
  expect(events).toEqual(['start add', 'end add', 'start write-tree', 'end write-tree', 'start add', 'end add', 'start write-tree', 'end write-tree'])
})
