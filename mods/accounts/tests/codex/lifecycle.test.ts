// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import type { CodexAccountView } from '../../types'
import { refreshCodexAccount } from '../../hooks/codexAccount'
import { STOPPED } from '../../hooks/codex/events'
import { HANDBACK, type ApiTurn } from '../../hooks/codex/request'
import { open, type Host } from '../../hooks/codex/server'
import { step as codexStep, type CodexContext, type Shared } from '../../hooks/codex/step'
import { refresh } from '../../hooks/paneControl'
import { messagesFor } from '../../hooks/i18n'
import { fakeMachine } from '../machine'
import { codex, engine, REMINDER, step, TASK, THREAD } from './fake'

// How a codex agent's step and its Codex server end, and what they leave
// behind: a stop while Codex starts, a server that has gone, a write that
// failed, and the work the pane and the band no longer wait on.

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))

// A message typed in the agent's view, as the engine wraps it.
const typed = (text: string) => `The user sent a new message while you were working:\n${text}\n\nAddress the message above as you continue this turn.`

function reply(turns: ApiTurn[], done: { text: string; report: string }, text: string, id: string): void {
  turns.push(
    { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id, name: HANDBACK, input: { message: done.report } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Report delivered to your caller.' }, { type: 'text', text: typed(text) }] },
  )
}

/**
 * A Codex server behind the mod's shell that prints its FIFO and then never
 * answers; `answers` names the requests it does answer. Ending it, as the
 * engine ends a child when a step's signal aborts, ends its output. `failOn`
 * names a method whose write fails.
 */
function quietHost(answers: Record<string, unknown> = {}, failOn?: string) {
  const counts = { started: 0, closed: 0 }
  const out: string[] = []
  let wake: (() => void) | undefined
  let isClosed = false
  const end = () => {
    if (isClosed) return
    counts.closed += 1
    isClosed = true
    wake?.()
  }
  const host: Host = {
    spawn: () => {
      counts.started += 1
      isClosed = false
      const stream = (async function* () {
        yield { stream: 'stdout' as const, text: 'codex-mod fifo /tmp/codex-mod.test/in\n' }
        while (!isClosed) {
          if (out.length === 0) await new Promise<void>(resolve => (wake = resolve))
          const line = out.shift()
          if (line !== undefined) yield { stream: 'stdout' as const, text: `${line}\n` }
        }
        return { code: 0, signal: null }
      })()
      const child = {
        [Symbol.asyncIterator]: () => child,
        next: () => stream.next(),
        return: (value: never) => {
          end()
          return stream.return(value)
        },
        throw: (error: unknown) => stream.throw(error),
      }

      return child as never
    },
    write: async (_path, text) => {
      for (const line of text.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method?: string }
        if (failOn && message.method === failOn) throw new Error('ENOSPC: no space left on device')
        const answer = message.method ? answers[message.method] : undefined
        if (message.id !== undefined && answer !== undefined) out.push(JSON.stringify({ id: message.id, result: answer }))
      }
      wake?.()
    },
    stat: async () => ({ kind: 'other', isLink: false }),
  }

  return { host, counts, end }
}

function shared<T>(value: T): Shared<T> & { now: () => T } {
  let held = value
  return { get: async () => held, update: async change => void (held = change(held)), now: () => held }
}

describe('a codex agent stopped while Codex starts', () => {
  test('passes nothing on but the commands it already answered, and answers with the stopped line', async () => {
    const controller = new AbortController()
    const server = quietHost()
    // The engine ends the child when the step's signal aborts.
    controller.signal.addEventListener('abort', () => server.end())
    const sent = shared<Record<string, string[]>>({})
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'Do it.' }, { type: 'text', text: '/codex-effort high' }] }]
    const ctx: CodexContext = {
      agentType: async () => 'sc-accounts:codex-run',
      messages: async () => turns,
      cwd: async () => '/work',
      host: server.host,
      read: async () => '',
      note: async () => undefined,
      invalidate: () => undefined,
      sent,
      openings: shared({ a1: 'Do it.' }),
      options: shared({}),
      runs: shared({}),
    }
    const next = Object.assign(
      async function* () {
        throw new Error('a codex agent never reaches the model')
      },
      { signal: controller.signal },
    )
    const stream = codexStep(ctx, { turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' } as never, next as never)
    const finished = (async () => {
      let item = await stream.next()
      while (!item.done) item = await stream.next()
      return item.value
    })()
    await pause(20)
    controller.abort()
    const result = await finished
    expect(sent.now()).toEqual({ a1: ['/codex-effort high'] })
    expect(result.toolUses[0]?.input).toEqual({ message: STOPPED })
    expect(server.counts.closed).toBe(1)
  })
})

describe('a codex agent between turns', () => {
  test('sends the spawn prompt\'s images with its own turn only, not again with a follow-up', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'image: /tmp/shot.png\nDescribe it.' }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    const done = await step($, 0)
    reply(turns, done, 'And the colours.', 'h1')
    await step($, 1)
    expect(fake.prompts).toEqual(['Describe it.', 'And the colours.'])
    expect(fake.inputs).toEqual([2, 1])
  })

  test('a new task sent after the Codex that asked a question has gone starts a turn; only a decision expires', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'crash')
    const asked = await step($, 0)
    expect(asked.report).toContain('Codex asks to run:')
    await pause(30)
    expect(fake.isClosed).toBe(true)
    reply(turns, asked, 'Skip that and list the files instead.', 'h1')
    const next = await step($, 1)
    expect(next.report).not.toContain('expired')
    expect(fake.prompts.at(-1)).toBe('Skip that and list the files instead.')
    expect(fake.threads.at(-1)).toMatchObject({ threadId: THREAD })
  })
})

test('one failed write to Codex fails that request alone; the next still reaches it', async () => {
  const server = quietHost({ initialize: {}, 'account/read': { account: null } }, 'bad/method')
  const codexServer = await open(server.host, [], '/work')
  await expect(codexServer.call('bad/method')).rejects.toThrow('ENOSPC')
  expect(await codexServer.call('account/read')).toEqual({ account: null })
  codexServer.close()
})

describe('what the pane and the band no longer wait on', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 } }

  test('a codex reply shows in the band of the surface whose view it was run in, not in another surface\'s', async ($, on) => {
    const agents: AgentInfo[] = [{ id: 'c5', type: 'sc-accounts:codex-read', description: 'Review', status: 'running' }]
    on('agent.list', () => ({ value: agents }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
    on('state.get', () => ({ value: { value: undefined, version: 1 } as never }))
    on('state.set', () => ({ value: { isSet: true, version: 2 } as never }))
    const desktop = await $.ui.mount({ plugin: 'sc-accounts', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'c5' } } as never })
    await $.command.run({ command: 'codex-model', args: 'gpt-6-astra' } as never)
    expect(await desktop.find({ type: 'Text', text: 'codex: model gpt-6-astra from the next Codex turn.' })).toBeDefined()
    const terminal = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: {} } as never })
    expect(await terminal.find({ type: 'Text', text: 'codex: model gpt-6-astra from the next Codex turn.' })).toBeUndefined()
    await desktop.redraw({ ...BAND, view: {} } as never)
  })

  test('the band asks for an agent missing from the engine\'s list at most every ten seconds', async ($, on) => {
    let asked = 0
    on('agent.list', () => {
      asked += 1
      return { value: [] as AgentInfo[] }
    })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
    const clock = mock.clock(on, { now: 5_000_000 })
    const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'gone' } } as never })
    await band.redraw({ ...BAND, view: { agentId: 'gone' } } as never)
    expect(asked).toBe(1)
    await clock.advance(10_000)
    await band.redraw({ ...BAND, view: { agentId: 'gone' } } as never)
    expect(asked).toBe(2)
  })

  test('Refresh does not wait on the Codex lookup, which can take longer than a command may', async () => {
    const machine = fakeMachine({ now: 9_000_000 })
    const server = quietHost()
    let card: CodexAccountView | null = { lookedAt: 0 }
    const codexCtx = {
      io: machine.io,
      host: server.host,
      cwd: async () => '/work',
      cell: { get: async () => card, set: async (value: CodexAccountView | null) => void (card = value) },
      messages: () => messagesFor('en'),
    }
    const toasts: string[] = []
    // Everything else the refresh touches fails at once and says so in a toast.
    const ctx = { accounts: { io: machine.io }, status: {}, codex: codexCtx, ui: { toast: (text: string) => toasts.push(text) } } as never
    const outcome = await Promise.race([refresh(ctx, true).then(() => 'returned'), pause(200).then(() => 'still waiting')])
    expect(outcome).toBe('returned')
    expect(server.counts.started).toBe(1)
    // The lookup gives up after its fifteen seconds and ends the server it started.
    await machine.advance(15_000)
    await pause(10)
    await refreshCodexAccount(codexCtx, false)
    expect(server.counts.closed).toBe(1)
  })
})
