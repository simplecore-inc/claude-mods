// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { mock } from 'claude-code/testing'
import type { AgentInfo, On, TurnStepChunk } from 'claude-code'

import { HANDBACK, type ApiTurn } from '../../hooks/codex/request'

// A stand-in for `codex app-server` and the rest of the engine one codex
// agent's step reads, shared by the tests that run a step.

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown

// The session the stand-in starts, an id of the shape Codex gives one.
export const THREAD = '01a0f92d-0000-7000-8000-0000000000a1'

// A TMPDIR holding a quote and a backslash, which the FIFO line carries as is.
const FIFO = '/tmp/we"ird\\dir/codex-mod.test/in'
export const TASK = 'model: gpt-6-luna\nsandbox: read-only\nask-for-approval: on-request\nconfig: approvals_reviewer="user"\nCreate note.txt.'
export const INSTALL = 'needs the Codex CLI with `codex app-server`'
// What a busy Codex says on the way, before its answer.
export const INTERIM = "I'll read app.js first."
export const REMINDER = `<system-reminder>\nYour final report is delivered through ${HANDBACK}.\n</system-reminder>`

type Fake = { argv: string[]; threads: any[]; prompts: string[]; inputs: number[]; steers: string[]; decisions: unknown[]; isClosed: boolean; writesAfterClose: number }

// How the stand-in ends: answers and finishes (`ok`), finishes without asking
// (`quiet`), works until a message is steered into its turn and then finishes
// (`busy`), or refuses the message because its turn just ended (`ending`),
// dies while its question waits (`crash`), or the shell finds no
// app-server, no codex, or Codex fails on its own "not found".
export type Mode = 'ok' | 'quiet' | 'busy' | 'ending' | 'crash' | 'no-app-server' | 'no-codex' | 'config-not-found'

// A stand-in for `codex app-server` behind the mod's shell: it reads the
// mod's JSON-RPC from the FIFO, answers it on stdout, asks for one approval
// in its turn, and finishes the turn once that is answered. The FIFO is there
// only while it runs, as the shell removes it on the way out.
export function codex(on: On, mode: Mode = 'ok'): Fake {
  const fake: Fake = { argv: [], threads: [], prompts: [], inputs: [], steers: [], decisions: [], isClosed: false, writesAfterClose: 0 }
  const out: string[] = []
  let wake: (() => void) | undefined
  const send = (message: object) => {
    out.push(JSON.stringify(message))
    wake?.()
  }
  on('process.spawn', async function* (_$, e) {
    // Each spawn is a new app-server, open until it ends.
    fake.argv = [...e.argv]
    fake.isClosed = false
    if (mode === 'no-codex') {
      fake.isClosed = true
      yield { stream: 'stderr' as const, text: 'codex-mod: codex: command not found\n' }
      return { value: { code: 127, signal: null } }
    }
    yield { stream: 'stdout' as const, text: `codex-mod fifo ${FIFO}\n` }
    if (mode === 'no-app-server' || mode === 'config-not-found') {
      fake.isClosed = true
      const said = mode === 'no-app-server' ? "error: unrecognized subcommand 'app-server'" : 'error: config profile not found'
      yield { stream: 'stderr' as const, text: `${said}\n` }
      return { value: { code: 2, signal: null } }
    }
    try {
      for (;;) {
        // Idle, it still yields now and then (a blank line, which the mod
        // skips; an empty chunk is not one the engine takes), so a close
        // reaches it as it reaches a real child.
        if (out.length === 0) await new Promise<void>(resolve => ((wake = resolve), setTimeout(resolve, 5)))
        if (mode === 'crash' && fake.decisions.length === 0 && out.length === 0 && asked) return { value: { code: 1, signal: null } }
        yield { stream: 'stdout' as const, text: out.length > 0 ? `${out.shift()}\n` : '\n' }
      }
    } finally {
      fake.isClosed = true
    }
  })
  let asked = false
  on('fs.stat', (_$, e) => {
    if (e.path === FIFO && !fake.isClosed) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT: no such file or directory, stat '${e.path}'`)
  })
  on('fs.write', (_$, e) => {
    if (e.path !== FIFO) return { value: undefined }
    if (fake.isClosed) fake.writesAfterClose++
    for (const line of e.text.split('\n').filter(Boolean)) {
      const m = JSON.parse(line)
      if (m.method === 'initialize') send({ id: m.id, result: {} })
      if (m.method === 'thread/start' || m.method === 'thread/resume') {
        // The session runs with what the call asked for, over the spawn's own.
        fake.threads.push(m.params)
        const effort = m.params.config?.model_reasoning_effort ?? null
        send({ id: m.id, result: { thread: { id: THREAD }, model: m.params.model ?? 'gpt-6-luna', reasoningEffort: effort, sandbox: { type: 'workspaceWrite' }, approvalPolicy: m.params.approvalPolicy ?? 'on-request' } })
      }
      if (m.method === 'turn/start') fake.prompts.push(m.params.input[0].text)
      // How many parts each turn's input holds: its text, then any images.
      if (m.method === 'turn/start') fake.inputs.push(m.params.input.length)
      if (m.method === 'turn/start' && (mode === 'busy' || mode === 'ending')) {
        send({ id: m.id, result: { turn: { id: 't1' } } })
        send({ method: 'item/completed', params: { threadId: THREAD, item: { type: 'agentMessage', text: INTERIM } } })
      } else if (m.method === 'turn/start' && mode === 'quiet') {
        send({ id: m.id, result: { turn: { id: 't1' } } })
        send({ method: 'thread/tokenUsage/updated', params: { threadId: THREAD, tokenUsage: { total: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 40 }, last: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 40 } } } })
        send({ method: 'item/completed', params: { threadId: THREAD, item: { type: 'agentMessage', text: 'Counted.' } } })
        send({ method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } })
      } else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 't1' } } })
        send({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, command: "/bin/zsh -lc 'printf hi > note.txt'", cwd: '/work' } })
        asked = true
      }
      if (m.method === 'turn/steer') {
        // Steering holds only for the turn that is running, named by its id.
        if (mode === 'ending' || m.params.expectedTurnId !== 't1' || fake.steers.length > 0) {
          send({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } })
          send({ method: 'item/completed', params: { threadId: THREAD, item: { type: 'agentMessage', text: 'Done.' } } })
          send({ method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } })
        } else {
          fake.steers.push(m.params.input[0].text)
          send({ id: m.id, result: { turnId: 't1' } })
          send({ method: 'item/completed', params: { threadId: THREAD, item: { type: 'agentMessage', text: `Done, and ${m.params.input[0].text}` } } })
          send({ method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } })
        }
      }
      if (m.method === undefined && m.id === 0) {
        fake.decisions.push(m.result?.decision)
        send({ method: 'item/completed', params: { threadId: THREAD, item: { type: 'agentMessage', text: 'Created note.txt.' } } })
        send({ method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } })
      }
    }
    return { value: undefined }
  })
  return fake
}

// The rest of the engine one codex agent's step reads.
export function engine(on: On, turns: ApiTurn[]) {
  mock.env(on, { HOME: '/home/me' })
  const agent: AgentInfo = { id: 'a1', type: 'sc-accounts:codex-run', description: 'Write note', status: 'running', name: 'writer' }
  on('agent.list', () => ({ value: [agent] }))
  on('session.messages', () => ({ value: turns as never }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
}

export async function step($: any, index: number): Promise<{ text: string; report: string }> {
  const stream = $.turn.step({ turnId: 't', index, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
  let text = ''
  let next = await stream.next()
  for (; !next.done; next = await stream.next()) {
    const chunk = next.value as TurnStepChunk
    if (chunk.kind === 'text') text += chunk.text
  }
  const result = next.value
  return { text, report: result.toolUses[0]?.input?.message ?? result.answer }
}

// Codex's files where the mod looks for them, and a `codex` on the PATH
// unless `isInstalled` is false; `os` is the `OS` variable (`Windows_NT`).
export function codexMachine(on: On, files: Record<string, string> = {}, { isInstalled = true, os }: { isInstalled?: boolean; os?: string } = {}) {
  mock.env(on, { HOME: '/home/me', ...(os ? { OS: os } : {}) })
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('process.run', (_$, e) => ({ value: { exitCode: isInstalled && e.argv.join(' ') === 'sh -c command -v codex' ? 0 : 1, stdout: '', stderr: '' } as never }))
}

// Lets work a hook started without waiting for it (the Codex offer at session
// start) run on until `isDone` holds, or a quarter of a second passes.
export async function settle(isDone: () => boolean = () => false): Promise<void> {
  for (let turn = 0; turn < 50 && !isDone(); turn += 1) await new Promise<void>(resolve => setTimeout(resolve, 5))
}
