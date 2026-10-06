import type { StorageProject, StorageView } from '../types'

/**
 * What Claude Code keeps on this machine under its config directory, and
 * which sessions a cleanup would delete. Pure: the hooks module walks the
 * folders and deletes; this file only adds up and chooses.
 */

/** A file under the projects folder: its path from there, its size and when it last changed. */
export type StorageFile = { relative: string; size: number; mtimeMs: number }

/** One session's files: its transcript, and its folder of subagent transcripts and tool output. */
export type StorageSession = {
  /** The project folder it is kept in. */
  folder: string
  session: string
  bytes: number
  /** `mtimeMs` of its newest file. */
  lastActive: number
  /** Paths from the projects folder to delete it: the transcript and the session's folder, those that exist. */
  paths: string[]
}

/** What the projects folder holds, by kind and by project; the folders and settings beside it are added by the caller. */
export type StorageSummary = Pick<StorageView, 'bytes' | 'transcripts' | 'subagents' | 'other' | 'sessions'> & { projects: Omit<StorageProject, 'name'>[] }

/** The project folder, the session and whether the path is the session's transcript, from a path under the projects folder. */
function placeOf(relative: string): { folder: string; session: string; isTranscript: boolean } | null {
  const parts = relative.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [folder = '', second = ''] = parts
  if (parts.length === 2) return second.endsWith('.jsonl') ? { folder, session: second.slice(0, -'.jsonl'.length), isTranscript: true } : null

  return { folder, session: second, isTranscript: false }
}

/** The files grouped by session, each with what deleting it removes. */
export function sessionsOf(files: StorageFile[]): StorageSession[] {
  const byKey = new Map<string, StorageSession & { hasTranscript: boolean; hasFolder: boolean }>()
  for (const file of files) {
    const place = placeOf(file.relative)
    if (!place) continue
    const key = `${place.folder}/${place.session}`
    const known = byKey.get(key) ?? { folder: place.folder, session: place.session, bytes: 0, lastActive: 0, paths: [], hasTranscript: false, hasFolder: false }
    known.bytes += file.size
    known.lastActive = Math.max(known.lastActive, file.mtimeMs)
    if (place.isTranscript) known.hasTranscript = true
    else known.hasFolder = true
    byKey.set(key, known)
  }

  return [...byKey.values()].map(({ hasTranscript, hasFolder, ...session }) => ({
    ...session,
    paths: [...(hasTranscript ? [`${session.folder}/${session.session}.jsonl`] : []), ...(hasFolder ? [`${session.folder}/${session.session}`] : [])],
  }))
}

/** What the projects folder holds, by kind and by project. */
export function summarizeStorage(files: StorageFile[]): StorageSummary {
  const add = (into: { count: number; bytes: number }, size: number) => ({ count: into.count + 1, bytes: into.bytes + size })
  let transcripts = { count: 0, bytes: 0 }
  let subagents = { count: 0, bytes: 0 }
  let other = { count: 0, bytes: 0 }
  for (const file of files) {
    const place = placeOf(file.relative)
    if (place?.isTranscript) transcripts = add(transcripts, file.size)
    else if (file.relative.endsWith('.jsonl') && file.relative.includes('/subagents/')) subagents = add(subagents, file.size)
    else other = add(other, file.size)
  }
  const sessions = sessionsOf(files)
  const byFolder = new Map<string, Omit<StorageProject, 'name'>>()
  for (const session of sessions) {
    const known = byFolder.get(session.folder) ?? { folder: session.folder, bytes: 0, sessions: 0, lastActive: 0 }
    byFolder.set(session.folder, {
      folder: session.folder,
      bytes: known.bytes + session.bytes,
      sessions: known.sessions + 1,
      lastActive: Math.max(known.lastActive, session.lastActive),
    })
  }

  return {
    bytes: transcripts.bytes + subagents.bytes + other.bytes,
    transcripts,
    subagents,
    other,
    sessions: sessions.length,
    projects: [...byFolder.values()].sort((a, b) => b.bytes - a.bytes),
  }
}

/**
 * The sessions a cleanup deletes: every one whose newest file is older than
 * `days` days, but never one of `keep` (the sessions running now).
 */
export function cleanupPlan(sessions: StorageSession[], days: number, now: number, keep: readonly string[]): { sessions: StorageSession[]; bytes: number } {
  const before = now - days * 86_400_000
  const chosen = sessions.filter(session => session.lastActive < before && !keep.includes(session.session))

  return { sessions: chosen, bytes: chosen.reduce((sum, session) => sum + session.bytes, 0) }
}

/**
 * The sessions running Claude Code processes name in their command lines, one
 * process a line: the id after `--resume`, `-r` or `--session-id`. A session
 * resumed in another window but idle past a cleanup's age is still in use.
 */
export function sessionIdsInCommands(commandLines: string): string[] {
  const ids = new Set<string>()
  const id = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
  for (const line of commandLines.split('\n')) {
    if (!/claude/i.test(line)) continue
    for (const match of line.matchAll(new RegExp(`(?:--resume|--session-id|-r)(?:=|\\s+)${id}`, 'g'))) if (match[1]) ids.add(match[1].toLowerCase())
  }

  return [...ids]
}

/**
 * The sessions a cleanup deletes now: those planned now that the dialog also
 * showed when the person confirmed it. A session that went idle past the age
 * between the two was never asked about, and stays.
 */
export function confirmedSessions(planned: StorageSession[], confirmed: ReadonlySet<string>): StorageSession[] {
  return planned.filter(session => confirmed.has(`${session.folder}/${session.session}`))
}

/** A size in a few characters: `512 B`, `12.4 KB`, `221.6 MB`, `17.0 GB`. */
export function byteSize(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 3, 'GB'],
    [1024 ** 2, 'MB'],
    [1024, 'KB'],
  ]
  for (const [size, unit] of units) if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`

  return `${bytes} B`
}

/**
 * The absolute paths a cleanup deletes, each under `root`; throws, deleting
 * nothing, when one would reach outside it (an absolute part, `.` or `..`).
 */
export function cleanupTargets(root: string, relatives: readonly string[]): string[] {
  return relatives.map(relative => {
    const parts = relative.split(/[\\/]/)
    if (relative === '' || relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`refused to delete outside ${root}: ${relative}`)
    }

    return `${root}/${relative}`
  })
}
