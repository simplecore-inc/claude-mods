import type { StorageView } from '../types'
import { countUsage, forgetTranscripts, loadUsageIndex } from './count'
import type { CountContext } from './count'
import { claudeDirectory, platformOf } from './credentials'
import type { Io } from './io'
import { message } from './io'
import { removeTreeArgv } from './shared/files'
import { byteSize, cleanupPlan, cleanupTargets, confirmedSessions, sessionIdsInCommands, sessionsOf, summarizeStorage } from './storage'
import type { StorageFile, StorageSession } from './storage'
import { projectOf } from './usage'

/**
 * What Claude Code keeps under its config directory, and the cleanup of idle
 * sessions. A cleanup deletes only the sessions its dialog named when the
 * person confirmed it, never this session nor one a running Claude Code
 * process resumed, and counts every transcript first so their tokens stay.
 */

/** What the Storage tab reads and shows beyond the machine. */
export type CleanupContext = {
  io: Io
  count: CountContext
  storage: (view: StorageView) => Promise<void>
  cleanupDays: () => Promise<number>
  sessionId: () => Promise<string>
  /** `cleanupPeriodDays` from Claude Code's settings, when set. */
  autoCleanupDays: () => Promise<number | undefined>
  homePath: () => string
}

/** Claude Code's own default for `cleanupPeriodDays`. */
const AUTO_CLEANUP_DEFAULT_DAYS = 30
/** How deep the Storage tab walks the projects folder: tool output sits in `<project>/<session>/tool-results/`. */
const STORAGE_DEPTH = 6
/** Project folders the Storage tab names: as many as it lists. */
const STORAGE_PROJECTS_NAMED = 8
/** Other folders the Storage tab lists, the largest first, and the smallest it lists. */
const STORAGE_FOLDERS_SHOWN = 8
const STORAGE_FOLDER_MIN_BYTES = 1024 * 1024
/** Paths one deletion command takes at a time. */
const DELETE_BATCH = 40

/** The files under the projects folder as last measured, for the cleanup to choose from. */
let storageFiles: StorageFile[] = []
/** The sessions the cleanup dialog named, as `<folder>/<session>`: all a cleanup may delete. */
let confirmed = new Set<string>()

/** Every file under the projects folder, with its size and when it last changed. */
async function projectFiles(io: Io, root: string): Promise<StorageFile[]> {
  if (!(await io.exists(root))) return []
  const files: StorageFile[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    for (const entry of await io.list(relative === '' ? root : `${root}/${relative}`)) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.kind === 'dir' && !entry.isLink && depth < STORAGE_DEPTH) await walk(child, depth + 1)
      else if (entry.kind === 'file') files.push({ relative: child, size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }
  await walk('', 1)

  return files
}

/** The sizes of the config directory's other folders, by `du`; none where there is no POSIX shell. */
async function otherFolders(io: Io, directory: string): Promise<{ name: string; bytes: number }[]> {
  const names = (await io.list(directory)).filter(entry => entry.kind === 'dir' && entry.name !== 'projects').map(entry => entry.name)
  if (names.length === 0) return []
  const { exitCode, stdout } = await io.run(['du', '-sk', '--', ...names.map(name => `${directory}/${name}`)], { timeoutMs: 60_000 })
  if (exitCode !== 0 && stdout.trim() === '') return []

  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 2 && /^\d+$/.test(parts[0] ?? ''))
    .map(([kb = '0', path = '']) => ({ name: path.slice(directory.length + 1), bytes: Number(kb) * 1024 }))
    .filter(folder => folder.bytes >= STORAGE_FOLDER_MIN_BYTES)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, STORAGE_FOLDERS_SHOWN)
}

/** The project a folder's newest session transcript worked in, read from its first `cwd`; undefined when none is found. */
async function recordedProject(io: Io, root: string, folder: string, files: StorageFile[]): Promise<string | undefined> {
  const newest = files
    // A session's own transcript: a subagent's may have worked in a worktree of its own.
    .filter(file => file.relative.startsWith(`${folder}/`) && file.relative.endsWith('.jsonl') && file.relative.split('/').length === 2)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!newest) return undefined
  const { exitCode, stdout } = await io.run(['sh', '-c', 'head -c 262144 "$1" | grep -a -o -m 1 \'"cwd":"[^"]*"\'', 'sh', `${root}/${newest.relative}`], { timeoutMs: 10_000 })
  const cwd = exitCode === 0 ? /"cwd":"([^"]*)"/.exec(stdout)?.[1] : undefined

  return cwd ? projectOf(cwd.replace(/\\\\/g, '\\')) : undefined
}

/** Measures what the config directory holds, for the Storage tab. */
export async function measureStorage(ctx: CleanupContext): Promise<void> {
  const { io } = ctx
  const directory = await claudeDirectory(io)
  const files = await projectFiles(io, `${directory}/projects`)
  storageFiles = files
  const summary = summarizeStorage(files)
  // A folder is named after the project its sessions worked in, as the usage count recorded it.
  const { index } = await loadUsageIndex(ctx.count)
  const votes = new Map<string, Map<string, number>>()
  for (const session of sessionsOf(files)) {
    const project = index.sessions[session.session]?.projects[0]
    if (!project) continue
    const tally = votes.get(session.folder) ?? new Map<string, number>()
    tally.set(project, (tally.get(project) ?? 0) + 1)
    votes.set(session.folder, tally)
  }
  const voted = (folder: string) => [...(votes.get(folder)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0]
  // A folder the count knows nothing of is named from the directory its newest transcript records.
  const names = new Map<string, string>()
  for (const project of summary.projects.slice(0, STORAGE_PROJECTS_NAMED)) {
    const name = voted(project.folder) ?? (await recordedProject(io, `${directory}/projects`, project.folder, files))
    if (name) names.set(project.folder, name)
  }
  const configured = await ctx.autoCleanupDays()
  let folders: { name: string; bytes: number }[] = []
  try {
    folders = await otherFolders(io, directory)
  } catch (error) {
    io.log(message(error))
  }
  await ctx.storage({
    ...summary,
    projects: summary.projects.map(project => ({ ...project, name: names.get(project.folder) ?? project.folder })),
    folders,
    autoDays: configured ?? AUTO_CLEANUP_DEFAULT_DAYS,
    isAutoDefault: configured === undefined,
    root: directory.replace(ctx.homePath(), '~'),
  })
}

/** The sessions running Claude Code processes resumed by id; none where the processes cannot be listed. */
async function runningSessions(io: Io): Promise<string[]> {
  const { isWindows } = await platformOf(io)
  const argv = isWindows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }']
    : ['ps', '-axo', 'command=']
  try {
    const listed = await io.run(argv, { timeoutMs: 10_000 })

    return listed.exitCode === 0 ? sessionIdsInCommands(listed.stdout) : []
  } catch (error) {
    io.log(message(error))

    return []
  }
}

/** The sessions a cleanup at the chosen age would delete, as last measured: never this one, nor one a running process resumed. */
export async function plannedCleanup(ctx: CleanupContext): Promise<{ sessions: StorageSession[]; bytes: number }> {
  const keep = [await ctx.sessionId(), ...(await runningSessions(ctx.io))]

  return cleanupPlan(sessionsOf(storageFiles), await ctx.cleanupDays(), await ctx.io.now(), keep)
}

/** What the cleanup dialog names: the sessions and their bytes as measured when it opened. */
let asked: { count: number; bytes: number } = { count: 0, bytes: 0 }

/** Names what the dialog shows, measured now, as all a cleanup confirmed from it may delete. */
export async function askCleanup(ctx: CleanupContext): Promise<{ count: number; bytes: number }> {
  await measureStorage(ctx)
  const plan = await plannedCleanup(ctx)
  confirmed = new Set(plan.sessions.map(session => `${session.folder}/${session.session}`))
  asked = { count: plan.sessions.length, bytes: plan.bytes }

  return asked
}

/** What the open cleanup dialog names. */
export function askedCleanup(): { count: number; bytes: number } {
  return asked
}

/**
 * Deletes the sessions the confirmed dialog named that are still idle now:
 * each transcript and the session's folder. Every path is checked to lie
 * under the projects folder first; one that does not stops the whole cleanup
 * before anything is deleted. The usage figures already counted stay.
 */
export async function cleanUp(ctx: CleanupContext, words: { nothing: (days: number) => string; uncounted: (files: number) => string; needsShell: string; done: (count: number, size: string) => string }): Promise<string> {
  const { io } = ctx
  // Measured again now: a session resumed since the dialog opened is no longer idle.
  await measureStorage(ctx)
  const sessions = confirmedSessions((await plannedCleanup(ctx)).sessions, confirmed)
  confirmed = new Set()
  if (sessions.length === 0) return words.nothing(await ctx.cleanupDays())
  // Every transcript is counted before any is deleted, so the usage figures keep their tokens;
  // one that could not be counted stops the cleanup.
  const uncounted = await countUsage(ctx.count, true)
  if ((await ctx.count.usageError.get()) !== null) throw new Error(words.needsShell)
  if (uncounted.length > 0) throw new Error(words.uncounted(uncounted.length))
  const root = `${await claudeDirectory(io)}/projects`
  const paths = cleanupTargets(root, sessions.flatMap(session => session.paths))
  const { isWindows } = await platformOf(io)
  for (let start = 0; start < paths.length; start += DELETE_BATCH) {
    const { exitCode, stderr } = await io.run(removeTreeArgv(paths.slice(start, start + DELETE_BATCH), isWindows), { timeoutMs: 120_000 })
    if (exitCode !== 0) throw new Error(`deleting sessions exited ${exitCode}: ${stderr.trim()}`)
  }
  // The count forgets the deleted transcripts' offsets; their tokens stay counted.
  await forgetTranscripts(ctx.count, paths)
  await measureStorage(ctx)

  return words.done(sessions.length, byteSize(sessions.reduce((sum, session) => sum + session.bytes, 0)))
}
