/**
 * What a project keeps across sessions, its notes and its checkpoint list: a
 * JSON file each under the repository's own git folder, one pair per working
 * tree, so they grow with the project and go with it, never with the machine's
 * history in the plugin store (4 MiB for everything a plugin keeps). Pure: the
 * hooks module hands in the file calls over `$.fs`.
 */
import { projectFolder } from './shared/claude'

/** The file calls a list is kept through. */
export type ListFiles = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

/** Where a working tree's notes and checkpoint list are kept: in the git folder every worktree of the repository shares. */
export function listPaths(commonDir: string, root: string): { notes: string; checkpoints: string } {
  const folder = `${commonDir}/sc-workspace`
  const name = projectFolder(root)

  return { notes: `${folder}/notes-${name}.json`, checkpoints: `${folder}/checkpoints-${name}.json` }
}

/** A list as its file holds it: empty with no file. Rejects when the file holds anything but a list, which is then left as it is. */
export async function readList<T>(files: ListFiles, path: string): Promise<T[]> {
  if (!(await files.exists(path))) return []
  const data: unknown = JSON.parse(await files.read(path))
  if (!Array.isArray(data)) throw new Error(`${path} holds no list`)

  return data as T[]
}

/** The change running on each file, which the next change to it waits for. */
const chains = new Map<string, Promise<unknown>>()

/**
 * Applies `change` to the list as its file holds it at that moment and writes
 * the result, one change at a time per file. A change worked out from a list
 * read earlier (a second press before the pane redrew, a session that read
 * the file before another wrote to it) would write back what came since.
 * @returns the list as written
 */
export function changeList<T>(files: ListFiles, path: string, change: (list: T[]) => T[] | Promise<T[]>): Promise<T[]> {
  const run = (chains.get(path) ?? Promise.resolve()).then(async () => {
    const next = await change(await readList<T>(files, path))
    await files.write(path, `${JSON.stringify(next)}\n`)

    return next
  })
  chains.set(
    path,
    run.catch(() => undefined),
  )

  return run
}

/** Moves a list the plugin store held into its file, unless the file is there already: the store kept them before files did. */
export async function adoptStored(files: ListFiles, path: string, stored: unknown): Promise<void> {
  if (!Array.isArray(stored) || (await files.exists(path))) return
  await files.write(path, `${JSON.stringify(stored)}\n`)
}
