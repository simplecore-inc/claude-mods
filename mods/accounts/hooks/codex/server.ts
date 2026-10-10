// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'

import { lines } from './events'

// One `codex app-server`, spoken to in JSON-RPC over its standard input and
// output. A mod's child takes its input once, so the server reads from a FIFO
// in a private temporary folder that the mod writes each message into. The
// shell around it holds the FIFO open while it lives, so the server sees the
// end of its input, and exits, when the shell does; the folder goes with it.
// Codex runs in a process group of its own, so ending the shell ends every
// process Codex started. If Claude Code dies without stopping the shell (a
// crash, SIGKILL), a watcher sees its parent gone within a second or two and
// ends the shell, and Codex with it.

// What the shell says when there is no `codex` to run.
export const NO_CODEX = 'codex-mod: codex: command not found'

// The line that names the FIFO: the path follows it, as it is, to the end of
// the line, so no character in TMPDIR needs escaping.
const FIFO_LINE = 'codex-mod fifo '

const SHELL = `
command -v codex >/dev/null 2>&1 || { echo '${NO_CODEX}' >&2; exit 127; }
p=$PPID
d=$(mktemp -d "\${TMPDIR:-/tmp}/codex-mod.XXXXXX") || exit 1
trap 'kill -TERM -$c $c $w 2>/dev/null; rm -rf "$d"' EXIT
trap 'exit 143' TERM HUP INT
mkfifo -m 600 "$d/in" || exit 1
set -m
codex app-server "$@" < "$d/in" &
c=$!
set +m
(while kill -0 $p && kill -0 $$; do sleep 1; done; kill -TERM -$c $$; rm -rf "$d") >/dev/null 2>&1 &
w=$!
exec 3> "$d/in"
printf '${FIFO_LINE}%s\\n' "$d/in"
wait $c
`

export type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any }

// What arrives unasked: a notification, or a request Codex waits on.
export type Incoming = { method: string; params: any; id?: number | string }

export type Server = {
  call: (method: string, params?: unknown) => Promise<any>
  respond: (id: number | string, reply: { result: unknown } | { error: { code: number; message: string } }) => Promise<void>
  // The next message Codex sent unasked; undefined once the server is gone.
  next: () => Promise<Incoming | undefined>
  close: () => void
  stderr: () => string
  // Whether the server has gone: its output ended.
  isEnded: () => boolean
}

// What the server needs of the engine: a child process, a file write, and
// what a path leads to (a FIFO is `other`; a missing path throws).
export type Host = {
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  write: (path: string, text: string) => Promise<void>
  stat: (path: string) => Promise<{ kind: string; isLink: boolean }>
}

// `onStart` is handed a way to end the child as soon as it is spawned, so a
// caller that stops waiting can end a server that never finished starting.
// A start that fails ends the child before the failure is passed on.
export async function open(host: Host, args: readonly string[], cwd: string, onStart?: (stop: () => void) => void): Promise<Server> {
  const child = host.spawn({ argv: ['sh', '-c', SHELL, 'codex-mod', ...args], cwd })
  let isStopped = false
  const stop = () => {
    if (isStopped) return
    isStopped = true
    void child.return({ code: null, signal: null })
  }
  onStart?.(stop)
  const failed = (error: unknown): never => {
    stop()
    throw error
  }
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const inbox: Incoming[] = []
  let wake: (() => void) | undefined
  let fifo: (path: string) => void = () => {}
  let errors = ''
  let isEnded = false
  let lastId = 0
  let writing = Promise.resolve()

  const ended = (async () => {
    let buffer = ''
    try {
      for await (const piece of child) {
        if (piece.stream === 'stderr') {
          errors = (errors + piece.text).slice(-4000)
          continue
        }
        const split = lines(buffer, piece.text)
        buffer = split.rest
        for (const line of split.done) receive(line)
      }
    } catch (err) {
      errors += String(err)
    }
    isEnded = true
    for (const { reject } of waiting.values()) reject(gone())
    waiting.clear()
    wake?.()
  })()

  // Why a call or write cannot reach the server: it went, saying this last.
  function gone(): Error {
    return new Error(`codex app-server exited: ${errors.trim().split('\n').at(-1) || 'no reason given'}`)
  }

  function receive(line: string): void {
    if (line.startsWith(FIFO_LINE)) return fifo(line.slice(FIFO_LINE.length))
    let message: Message
    try {
      message = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      if (line.trim()) errors = (errors + line + '\n').slice(-4000)
      return
    }
    if (message.method === undefined && typeof message.id === 'number' && waiting.has(message.id)) {
      const call = waiting.get(message.id)!
      waiting.delete(message.id)
      if (message.error) call.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else call.resolve(message.result)
      return
    }
    if (message.method !== undefined) {
      inbox.push({ method: message.method, params: message.params, id: message.id })
      wake?.()
    }
  }

  const path = await new Promise<string>((resolve, reject) => {
    fifo = resolve
    void ended.then(() => reject(new Error(`codex app-server did not start: ${errors.trim() || 'no output'}`)))
  }).catch(failed)
  // A write creates a path that is not there, so once the shell has removed
  // the FIFO a write would leave a plain file of Codex's answers behind.
  // Nothing is written after the server ends, or to anything but the FIFO. The
  // FIFO is gone only once the shell is on its way out, so the refusal waits
  // for its output to end and gives the reason it gave.
  // A failed write fails its own caller; the writes after it still run.
  const write = (message: object) => {
    const done = writing.then(async () => {
      const at = isEnded ? undefined : await host.stat(path).catch(() => undefined)
      if (isEnded || at?.kind !== 'other' || at.isLink) {
        await ended
        throw gone()
      }
      await host.write(path, `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    })
    writing = done.catch(() => undefined)
    return done
  }

  const server: Server = {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        if (isEnded) return reject(gone())
        const id = ++lastId
        waiting.set(id, { resolve, reject })
        write({ id, method, ...(params === undefined ? {} : { params }) }).catch(reject)
      }),
    respond: (id, reply) => write({ id, ...reply }),
    next: async () => {
      while (inbox.length === 0 && !isEnded) await new Promise<void>(resolve => (wake = resolve))
      return inbox.shift()
    },
    close: stop,
    stderr: () => errors,
    isEnded: () => isEnded,
  }
  await server.call('initialize', { clientInfo: { name: 'sc-accounts-codex', title: 'Claude Code', version: '1' } }).catch(failed)
  await write({ method: 'initialized' }).catch(failed)
  return server
}
