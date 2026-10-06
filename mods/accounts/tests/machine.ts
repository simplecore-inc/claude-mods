import type { FsStat, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { EnvName, Io } from '../hooks/io'

/**
 * A machine in memory for the modules: files, folders, the store, a clock
 * that moves only when the test moves it (a sleep moves it at once), and
 * commands answered as macOS answers the ones the modules run. A test sets
 * the network and any other command it needs.
 */
let machines = 0

export function fakeMachine(start: { env?: Partial<Record<EnvName, string>>; now?: number } = {}) {
  machines += 1
  const files: Record<string, string> = {}
  const folders = new Set<string>()
  const mtimes: Record<string, number> = {}
  const store: Record<string, unknown> = {}
  const runs: string[][] = []
  const logs: string[] = []
  const env: Partial<Record<EnvName, string>> = { HOME: '/home/me', USER: 'me', ...start.env }
  const timers: { at: number; fn: () => void; isCancelled: boolean }[] = []
  // Each machine's times apart from every other's: the modules key what they keep by a file's time and size.
  let now = start.now ?? machines * 1_000_000_000
  let stamp = 0
  const touched = (path: string) => {
    stamp += 1
    mtimes[path] = now + stamp
  }
  const write = (path: string, text: string) => {
    files[path] = text
    touched(path)
  }
  let fetcher: (url: string, init?: HttpInit) => Promise<HttpResponse> = async url => {
    throw new Error(`no network in this test: ${url}`)
  }
  let extraRunner: ((argv: string[], init?: ProcessRunInit) => ProcessRunResult | undefined) | undefined
  const answer = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({ exitCode, stdout, stderr }) as ProcessRunResult
  const runner = (argv: string[], init?: ProcessRunInit): ProcessRunResult => {
    const extra = extraRunner?.(argv, init)
    if (extra) return extra
    if (argv[0] === 'uname') return answer(0, 'Darwin\n')
    if (argv[0] === '/bin/sh' && argv[2]?.includes('mkdir "$0"') && argv[3]) {
      if (folders.has(argv[3])) return answer(1, '', 'File exists')
      folders.add(argv[3])
      touched(argv[3])

      return answer(0)
    }
    if (argv[0] === '/bin/sh' && argv[2]?.includes('rmdir "$0"') && argv[3]) {
      folders.delete(argv[3])

      return answer(0)
    }
    if (argv[0] === 'touch' && argv[1]) {
      touched(argv[1])

      return answer(0)
    }
    if (argv[0] === '/bin/sh' && argv[2]?.includes('mktemp') && argv[3]) {
      write(argv[3], init?.stdin ?? '')

      return answer(0)
    }

    return answer(0)
  }
  const io: Io = {
    run: async (argv, init) => {
      runs.push([...argv])

      return runner([...argv], init)
    },
    read: async path => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)

      return files[path] as string
    },
    write: async (path, text) => write(path, text),
    exists: async path => path in files || folders.has(path) || Object.keys(files).some(one => one.startsWith(`${path}/`)),
    stat: async path => {
      if (!(path in files) && !folders.has(path)) throw new Error(`ENOENT: ${path}`)

      return { kind: folders.has(path) ? 'dir' : 'file', size: (files[path] ?? '').length, mtimeMs: mtimes[path] ?? 0 } as FsStat
    },
    list: async path => {
      const names = new Map<string, boolean>()
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${path}/`)) continue
        const [name = '', ...rest] = file.slice(path.length + 1).split('/')
        names.set(name, (names.get(name) ?? false) || rest.length > 0)
      }

      return [...names].map(([name, isDir]) => ({ name, kind: isDir ? 'dir' : 'file', size: (files[`${path}/${name}`] ?? '').length, mtimeMs: mtimes[`${path}/${name}`] ?? 0, isLink: false }))
    },
    env: async name => env[name],
    now: async () => now,
    sleep: async ms => {
      now += ms
    },
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, isCancelled: false }
      timers.push(timer)

      return () => {
        timer.isCancelled = true
      }
    },
    fetch: (url, init) => fetcher(url, init),
    store: {
      get: async key => store[key],
      set: async (key, value) => {
        store[key] = value
      },
      delete: async key => {
        delete store[key]
      },
      keys: async () => Object.keys(store),
    },
    log: text => {
      logs.push(text)
    },
  }

  return {
    io,
    files,
    folders,
    mtimes,
    store,
    runs,
    logs,
    write,
    now: () => now,
    /** Moves the clock on, running each timer that comes due. */
    advance: async (ms: number) => {
      now += ms
      for (const timer of timers.filter(one => !one.isCancelled && one.at <= now)) {
        timer.isCancelled = true
        timer.fn()
      }
      await settled()
    },
    settled,
    setFetch: (next: (url: string, init?: HttpInit) => Promise<HttpResponse>) => {
      fetcher = next
    },
    setRunner: (next: (argv: string[], init?: ProcessRunInit) => ProcessRunResult | undefined) => {
      extraRunner = next
    },
  }
}

/** Lets the work already started run on until it waits on something this machine has not answered. */
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
}

/** An HTTP answer as the engine hands one back. */
export function response(status: number, body: unknown): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: typeof body === 'string' ? body : JSON.stringify(body) } as HttpResponse
}
