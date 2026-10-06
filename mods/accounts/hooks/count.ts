import type { UsageSummary } from '../types'
import { claudeDirectory, platformOf } from './credentials'
import type { Messages } from './i18n'
import type { Cell, Io } from './io'
import { message } from './io'
import { LockBusyError, acquire } from './lock'
import type { Lock } from './lock'
import { addRecords, asIndex, emptyIndex, indexToStore, localDay, parseScan, scannedBytes, SCAN_SCRIPT, sessionOf, summarize } from './usage'
import type { UsageIndex } from './usage'
import { writeAtomic } from './writes'

/**
 * Tokens counted from this machine's transcripts. The count is the machine's,
 * kept in files under the mod's folder, and every session may add to it, so
 * one session counts at a time, under a lock, starting from the count as the
 * files hold it: a session that counted from a copy it read earlier would
 * write back a count that lacks what another session added meanwhile.
 */

/** What counting reads and shows beyond the machine. */
export type CountContext = {
  io: Io
  messages: () => Messages
  usagePeriod: () => Promise<number>
  usageSummary: (summary: UsageSummary) => Promise<void>
  usageScan: (scan: { done: number; total: number } | null) => Promise<void>
  usageError: Cell<string | null>
  /** Whether the Usage tab is on screen, so a long first count goes on chunk after chunk. */
  isUsageShown: () => Promise<boolean>
}

/** Bytes of transcripts one count reads before it lets the pane draw and goes on. */
const USAGE_SCAN_BYTES = 256 * 1024 * 1024
/** How deep transcripts sit under the projects folder: `<project>/<session>/subagents/<agent>.jsonl`. */
const TRANSCRIPT_DEPTH = 4
/** The count's lock, touched after each chunk; a chunk takes two minutes at most. */
const COUNT_LOCK = { staleMs: 4 * 60 * 1000, tries: 1 }
/** Waiting for another session's count to finish before a cleanup counts to the end. */
const COUNT_LOCK_WAITING = { staleMs: 4 * 60 * 1000, tries: 150 }

/** The count as last read or written by this session, and the files' time and size then. */
let cached: { index: UsageIndex; seen: Set<string>; stamp: string } | null = null
/** Whether a count is running in this session. */
let isCounting = false

async function folder(io: Io): Promise<string> {
  return `${await claudeDirectory(io)}/sc-accounts`
}

async function indexPath(io: Io): Promise<string> {
  return `${await folder(io)}/usage-index.json`
}

/** The file holding the `n`th part of the counted message ids. */
async function idsPath(io: Io, n: number): Promise<string> {
  return `${await folder(io)}/usage-ids-${n}.json`
}

/** The index file's time and size, which change with every write by any session. */
async function stampOf(io: Io): Promise<string> {
  const path = await indexPath(io)
  if (!(await io.exists(path))) return 'none'
  const { mtimeMs, size } = await io.stat(path)

  return `${mtimeMs}:${size}`
}

/** The count as the files hold it, read again only when another session wrote it since. */
export async function loadUsageIndex(ctx: CountContext): Promise<{ index: UsageIndex; seen: Set<string> }> {
  const { io } = ctx
  const stamp = await stampOf(io)
  if (cached?.stamp === stamp) return cached
  let index = emptyIndex()
  try {
    if (stamp !== 'none') {
      const raw = JSON.parse(await io.read(await indexPath(io))) as { idFiles?: unknown }
      const read = asIndex(raw)
      // The ids live in files of their own; an index written before that holds them itself.
      const ids = [...read.ids]
      const parts = typeof raw.idFiles === 'number' ? raw.idFiles : 0
      for (let n = 0; n < parts; n += 1) ids.push(...(JSON.parse(await io.read(await idsPath(io, n))) as string[]))
      index = { ...read, ids }
    }
  } catch (error) {
    // A count that does not read is counted again from the start.
    io.log(message(error))
    index = emptyIndex()
  }
  cached = { index, seen: new Set(index.ids), stamp }

  return cached
}

/** Writes the count, each file replaced whole: its ids in files of their own, then the index naming how many. */
async function saveUsageIndex(ctx: CountContext, index: UsageIndex, seen: Set<string>): Promise<void> {
  const { io } = ctx
  const { isWindows } = await platformOf(io)
  const stored = indexToStore(index, [...seen])
  for (const [n, part] of stored.idFiles.entries()) await writeAtomic(io, await idsPath(io, n), JSON.stringify(part), { isPrivate: false, isWindows })
  await writeAtomic(io, await indexPath(io), JSON.stringify(stored.index), { isPrivate: false, isWindows })
  cached = { index, seen, stamp: await stampOf(io) }
}

/** Takes the count's lock: once, or waiting for another session's count when `isWaiting`; null when it stays held. */
async function takeCountLock(ctx: CountContext, isWaiting: boolean): Promise<Lock | null> {
  const { isWindows } = await platformOf(ctx.io)
  try {
    return await acquire(ctx.io, `${await folder(ctx.io)}/locks/usage-count.lock`, { ...(isWaiting ? COUNT_LOCK_WAITING : COUNT_LOCK), isWindows })
  } catch (error) {
    if (error instanceof LockBusyError) return null
    throw error
  }
}

/**
 * Every transcript under the config directory with its size: each session's,
 * and each subagent's, which counts toward the session that started it.
 */
async function transcriptFiles(io: Io): Promise<{ path: string; session: string; size: number }[]> {
  const root = `${await claudeDirectory(io)}/projects`
  if (!(await io.exists(root))) return []
  const files: { path: string; session: string; size: number }[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    for (const entry of await io.list(`${root}/${relative}`)) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.kind === 'dir' && depth < TRANSCRIPT_DEPTH) await walk(child, depth + 1)
      else if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && depth >= 2) files.push({ path: `${root}/${child}`, session: sessionOf(child), size: entry.size })
    }
  }
  await walk('', 1)

  return files
}

/** The Usage tab's figures for its period, from the count as the files hold it. */
export async function refreshUsageSummary(ctx: CountContext): Promise<void> {
  const { index } = await loadUsageIndex(ctx)
  const period = await ctx.usagePeriod()
  const today = localDay(new Date(await ctx.io.now()).toISOString())
  await ctx.usageSummary(summarize(index, period === 0 ? null : period, today))
}

/**
 * Counts what the transcripts gained since the last count, up to
 * `USAGE_SCAN_BYTES` at a time, saying how far it has got; while the Usage tab
 * is on screen it goes on until every transcript is counted. With
 * `isToTheEnd` it counts everything in this call, waiting for another
 * session's count first (before a cleanup deletes transcripts, so their tokens
 * are counted first).
 *
 * @returns the transcripts that could not be counted; with `isToTheEnd`, a
 *          count another session held past the wait is all of them
 */
export async function countUsage(ctx: CountContext, isToTheEnd = false): Promise<string[]> {
  const { io } = ctx
  if (isCounting && !isToTheEnd) return []
  // A count to the end waits for one already running here, then reads what it left.
  while (isCounting) await io.sleep(200)
  isCounting = true
  try {
    const lock = await takeCountLock(ctx, isToTheEnd)
    if (lock === null) {
      // Another session counts now: its figures show once it has written them.
      if (!isToTheEnd) {
        await refreshUsageSummary(ctx)

        return []
      }

      return (await transcriptFiles(io)).map(file => file.path)
    }
    try {
      return await countHolding(ctx, lock, isToTheEnd)
    } finally {
      await lock.release().catch((error: unknown) => io.log(message(error)))
    }
  } finally {
    isCounting = false
  }
}

async function countHolding(ctx: CountContext, lock: Lock, isToTheEnd: boolean): Promise<string[]> {
  const { io } = ctx
  await ctx.usageError.set(null)
  const loaded = await loadUsageIndex(ctx)
  let index = loaded.index
  const seen = new Set(loaded.seen)
  const all = await transcriptFiles(io)
  const pending = all.filter(file => (index.files[file.path]?.offset ?? 0) < file.size)
  if (pending.length === 0) {
    await ctx.usageScan(null)
    await refreshUsageSummary(ctx)

    return []
  }
  // The progress is of every transcript: those counted before, in an earlier session too, are done.
  const total = all.length
  await ctx.usageScan({ done: total - pending.length, total })
  let budget = isToTheEnd ? Number.POSITIVE_INFINITY : USAGE_SCAN_BYTES
  let done = 0
  let hasMoved = false
  const failed: string[] = []
  for (const file of pending) {
    if (budget <= 0) break
    // A transcript is read a chunk at a time, so one of gigabytes never meets the time limit whole.
    let offset = index.files[file.path]?.offset ?? 0
    let isFailed = false
    while (offset < file.size && budget > 0) {
      const to = Math.min(file.size, offset + USAGE_SCAN_BYTES, offset + budget)
      const { exitCode, stdout, stderr } = await io.run(['sh', '-c', SCAN_SCRIPT, 'sh', file.path, String(to), String(offset + 1), String(to - offset)], { timeoutMs: 120_000 })
      await lock.touch()
      if (exitCode === -1 && /failed to start|ENOENT/.test(stderr)) {
        await ctx.usageError.set(ctx.messages().usageNeedsShell)

        return [file.path]
      }
      if (exitCode !== 0) {
        io.log(`usage count of ${file.path} exited ${exitCode}: ${stderr.trim()}`)
        isFailed = true
        break
      }
      const next = offset + scannedBytes(stdout)
      index = addRecords(index, seen, file.path, file.session, parseScan(stdout), next)
      budget -= to - offset
      // Only a line still being written is left: the file is done for this pass.
      if (next === offset) break
      hasMoved = true
      offset = next
    }
    if (isFailed) failed.push(file.path)
    // A failed file counts as done for this pass, so the count never retries it without end.
    if (isFailed || budget > 0 || offset >= file.size) done += 1
  }
  await saveUsageIndex(ctx, index, seen)
  await refreshUsageSummary(ctx)
  const left = pending.length - done
  if (left > 0 && hasMoved && (await ctx.isUsageShown())) {
    await ctx.usageScan({ done: total - left, total })
    io.after(100, () => void countUsage(ctx).catch((error: unknown) => io.log(message(error))))
  } else {
    await ctx.usageScan(null)
  }

  return failed
}

/** Forgets the offsets of transcripts a cleanup deleted, under the count's lock; their tokens stay counted. */
export async function forgetTranscripts(ctx: CountContext, deleted: readonly string[]): Promise<void> {
  const lock = await takeCountLock(ctx, true)
  if (lock === null) throw new Error(`the usage count is held by another session`)
  try {
    const { index, seen } = await loadUsageIndex(ctx)
    const gone = (file: string) => deleted.some(path => file === path || file.startsWith(`${path}/`))
    await saveUsageIndex(ctx, { ...index, files: Object.fromEntries(Object.entries(index.files).filter(([file]) => !gone(file))) }, seen)
  } finally {
    await lock.release().catch((error: unknown) => ctx.io.log(message(error)))
  }
}
