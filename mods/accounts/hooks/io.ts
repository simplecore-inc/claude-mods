import type { FsEntry, FsStat, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

/**
 * The environment variables the modules read. The engine lists what a module
 * reads from the literal names at its `$.env.get` calls, so each is read by
 * name in the hooks module and no other may be asked for.
 */
export type EnvName = 'OS' | 'HOME' | 'USERPROFILE' | 'USER' | 'CLAUDE_CONFIG_DIR' | 'CLAUDE_SECURESTORAGE_CONFIG_DIR' | 'ORCA_USER_DATA_PATH' | 'XDG_CONFIG_HOME' | 'APPDATA' | 'CODEX_HOME' | 'CLAUDE_CODE_ACCOUNT_UUID' | 'CLAUDE_CODE_USER_EMAIL'

/**
 * What the modules reach the machine through. The hooks module builds each
 * member over `$`, which no other file may hold, so a module takes this and
 * plain data, and a test hands it a machine of its own.
 */
export type Io = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<FsStat>
  list: (path: string) => Promise<readonly FsEntry[]>
  env: (name: EnvName) => Promise<string | undefined>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  after: (ms: number, fn: () => void) => () => void
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
    keys: () => Promise<readonly string[]>
  }
  /** A line for the debug log. */
  log: (text: string) => void
}

/** A value of the session's state, read and written whole. */
export type Cell<T> = { get: () => Promise<T>; set: (value: T) => Promise<void> }

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A request or command that did not answer within its time. */
export class TimeoutError extends Error {}

/**
 * The promise's value, or a `TimeoutError` saying `noAnswer` once `ms` pass:
 * the words the person reads, in their language. The promise runs on either
 * way; `onLate` gets its value if it settles after the deadline.
 */
export async function within<T>(io: Io, promise: Promise<T>, ms: number, noAnswer: string, onLate?: (value: T) => void): Promise<T> {
  let isLate = false
  let cancel = () => {}
  const deadline = new Promise<never>((_, reject) => {
    cancel = io.after(ms, () => {
      isLate = true
      reject(new TimeoutError(noAnswer))
    })
  })
  promise.then(
    value => {
      if (isLate) onLate?.(value)
    },
    () => undefined,
  )
  try {
    return await Promise.race([promise, deadline])
  } finally {
    cancel()
  }
}
