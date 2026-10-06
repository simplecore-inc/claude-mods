import type { Io } from './io'
import { encodePowerShell, powerShellLiteral } from './shared/files'

/**
 * Locks held across processes, laid out as proper-lockfile (Claude Code's own
 * locks) lays them: a directory that only one process can make, taken as
 * abandoned once its modification time is older than the lock's stale time.
 * Taking Claude Code's lock before writing a file it guards keeps the write
 * from landing between its read and its write.
 */

/** A lock this process holds. */
export type Lock = {
  /** Gives the lock up; a lock already taken over as stale is left alone. */
  release: () => Promise<void>
  /** Marks the lock alive, for work that holds it longer than half its stale time. */
  touch: () => Promise<void>
}

export class LockBusyError extends Error {}

export type LockOptions = {
  /** How old the lock's time may grow before another process takes it as abandoned. */
  staleMs: number
  /** How many times to try before giving up, waiting longer each time. */
  tries: number
  isWindows: boolean
}

/** The waits between tries: 100 ms, doubling, at most a second. */
export function retryDelay(attempt: number): number {
  return Math.min(1000, 100 * 2 ** attempt)
}

/** argv making the lock directory, its parent first; it fails when the directory is there. */
export function makeLockArgv(path: string, isWindows: boolean): string[] {
  if (!isWindows) return ['/bin/sh', '-c', 'mkdir -p "$(dirname "$0")" && mkdir "$0"', path]
  const script = `$p = ${powerShellLiteral(path)}; if (Test-Path -LiteralPath $p) { exit 1 }; New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p) | Out-Null; try { New-Item -ItemType Directory -Path $p -ErrorAction Stop | Out-Null } catch { exit 1 }`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/** argv removing the lock directory, empty as a lock is; absent is fine. */
export function removeLockArgv(path: string, isWindows: boolean): string[] {
  if (!isWindows) return ['/bin/sh', '-c', '[ ! -d "$0" ] || rmdir "$0"', path]
  const script = `$p = ${powerShellLiteral(path)}; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction Stop }`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/** argv setting the lock directory's time to now. */
export function touchLockArgv(path: string, isWindows: boolean): string[] {
  if (!isWindows) return ['touch', path]
  const script = `(Get-Item -LiteralPath ${powerShellLiteral(path)}).LastWriteTime = Get-Date`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/** Takes the lock at `path`, taking over one abandoned past its stale time; `LockBusyError` when it stays held. */
export async function acquire(io: Io, path: string, options: LockOptions): Promise<Lock> {
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    const made = await io.run(makeLockArgv(path, options.isWindows), { timeoutMs: 10_000 })
    if (made.exitCode === 0) {
      let mtimeMs = (await io.stat(path).catch(() => null))?.mtimeMs ?? 0

      return {
        release: async () => {
          // Taken over as stale and made again by another process: that lock is not this one's to remove.
          const now = (await io.stat(path).catch(() => null))?.mtimeMs
          if (now === undefined || now !== mtimeMs) return
          await io.run(removeLockArgv(path, options.isWindows), { timeoutMs: 10_000 })
        },
        touch: async () => {
          await io.run(touchLockArgv(path, options.isWindows), { timeoutMs: 10_000 })
          mtimeMs = (await io.stat(path).catch(() => null))?.mtimeMs ?? mtimeMs
        },
      }
    }
    const held = await io.stat(path).catch(() => null)
    // Made by nobody yet the directory could not be made: not a lock held but a failure to report.
    if (held === null) throw new Error(`cannot make the lock ${path}: ${made.stderr.trim()}`)
    if ((await io.now()) - held.mtimeMs > options.staleMs) {
      // Removed only while it is still the abandoned one seen: another process may have just taken it over.
      if ((await io.stat(path).catch(() => null))?.mtimeMs === held.mtimeMs) await io.run(removeLockArgv(path, options.isWindows), { timeoutMs: 10_000 })
      continue
    }
    if (attempt + 1 < options.tries) await io.sleep(retryDelay(attempt))
  }

  throw new LockBusyError(`the lock ${path} is held by another process`)
}

/** Runs `work` holding the lock at `path`, and gives the lock up after, whatever `work` did. */
export async function withLock<T>(io: Io, path: string, options: LockOptions, work: (lock: Lock) => Promise<T>): Promise<T> {
  const lock = await acquire(io, path, options)
  try {
    return await work(lock)
  } finally {
    await lock.release().catch((error: unknown) => io.log(`cannot release ${path}: ${error instanceof Error ? error.message : String(error)}`))
  }
}
