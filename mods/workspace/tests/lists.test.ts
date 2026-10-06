import { expect, test } from 'claude-code/testing'

import { adoptStored, changeList, listPaths, readList } from '../hooks/lists'
import type { ListFiles } from '../hooks/lists'

/** Files in memory, each write a moment later than the read before it. */
function memoryFiles(start: Record<string, string> = {}): { files: ListFiles; held: Record<string, string> } {
  const held = { ...start }
  const files: ListFiles = {
    exists: async path => path in held,
    read: async path => {
      await Promise.resolve()
      if (!(path in held)) throw new Error(`ENOENT: ${path}`)

      return held[path] as string
    },
    write: async (path, text) => {
      await Promise.resolve()
      held[path] = text
    },
  }

  return { files, held }
}

test('a working tree\'s lists are files of their own under the repository\'s git folder', async () => {
  expect(listPaths('/repo/.git', '/repo')).toEqual({ notes: '/repo/.git/sc-workspace/notes--repo.json', checkpoints: '/repo/.git/sc-workspace/checkpoints--repo.json' })
  expect(listPaths('/repo/.git', '/repo-wt').notes).not.toBe(listPaths('/repo/.git', '/repo').notes)
})

test('two changes made at once both land, each on the list the other left', async () => {
  const { files, held } = memoryFiles({ '/l.json': '[1]' })
  await Promise.all([changeList<number>(files, '/l.json', list => [...list, 2]), changeList<number>(files, '/l.json', list => [...list, 3])])
  expect(JSON.parse(held['/l.json'] ?? '')).toEqual([1, 2, 3])
})

test('a change that fails leaves the file as it was, and the next change still runs', async () => {
  const { files, held } = memoryFiles({ '/l.json': '[1]' })
  await expect(
    changeList<number>(files, '/l.json', () => {
      throw new Error('no')
    }),
  ).rejects.toThrow('no')
  await changeList<number>(files, '/l.json', list => [...list, 2])
  expect(JSON.parse(held['/l.json'] ?? '')).toEqual([1, 2])
})

test('no file reads as an empty list; a file holding something else is refused and left alone', async () => {
  const { files, held } = memoryFiles({ '/bad.json': '{"not":"a list"}' })
  expect(await readList(files, '/none.json')).toEqual([])
  await expect(readList(files, '/bad.json')).rejects.toThrow('holds no list')
  await expect(changeList(files, '/bad.json', list => list)).rejects.toThrow('holds no list')
  expect(held['/bad.json']).toBe('{"not":"a list"}')
})

test('a list the store held moves to its file, never over a file already there', async () => {
  const { files, held } = memoryFiles({ '/kept.json': '["file"]' })
  await adoptStored(files, '/new.json', ['store'])
  await adoptStored(files, '/kept.json', ['store'])
  await adoptStored(files, '/other.json', 'not a list')
  expect(JSON.parse(held['/new.json'] ?? '')).toEqual(['store'])
  expect(JSON.parse(held['/kept.json'] ?? '')).toEqual(['file'])
  expect('/other.json' in held).toBe(false)
})
