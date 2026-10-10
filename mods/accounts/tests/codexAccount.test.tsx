import { expect, test } from 'claude-code/testing'

import type { CodexAccountView } from '../types'
import { CODEX_LOOKUP_MS, limitsOf, loginOf, refreshCodexAccount, windowLabel } from '../hooks/codexAccount'
import type { CodexAccountContext } from '../hooks/codexAccount'
import type { Host } from '../hooks/codex/server'
import { messagesFor } from '../hooks/i18n'
import { fakeMachine } from './machine'
import { SURFACES, mountPane, seedState } from './paneHarness'

const m = messagesFor('en')

/** `account/read` and `account/rateLimits/read` as codex-cli 0.160 answers them for a ChatGPT login. */
const ACCOUNT = { account: { type: 'chatgpt', email: 'dana@example.com', planType: 'pro' }, requiresOpenaiAuth: true }
const LIMITS = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 4_070_908_800 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: '62500.0000000000' },
    planType: 'pro',
  },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 4_070_908_800 }, secondary: null },
  },
}

test('Codex windows are named as the Claude cards name theirs', () => {
  expect(windowLabel(300)).toBe('5h')
  expect(windowLabel(10_080)).toBe('wk')
  expect(windowLabel(1440)).toBe('1d')
  expect(windowLabel(120)).toBe('2h')
})

test('the login and the limits read from what codex app-server answers', () => {
  expect(loginOf(ACCOUNT)).toEqual({ kind: 'chatgpt', email: 'dana@example.com', plan: 'pro' })
  expect(loginOf({ account: { type: 'apiKey' } })).toEqual({ kind: 'apiKey' })
  expect(loginOf({ account: null, requiresOpenaiAuth: true })).toEqual({ kind: 'none' })
  expect(limitsOf(LIMITS)).toEqual({
    limits: [{ label: 'wk', percent: 35, resetsAt: '2099-01-01T00:00:00.000Z' }],
    credits: { isUnlimited: false, balance: 62_500 },
  })
  // A limit of its own (a model's) shows under its name; no credits, none said.
  const scoped = { rateLimits: { limitId: 'codex', primary: { usedPercent: 5, windowDurationMins: 300 } }, rateLimitsByLimitId: { spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 80, windowDurationMins: 300 } } } }
  expect(limitsOf(scoped)).toEqual({ limits: [{ label: '5h', percent: 5 }, { label: 'Spark', percent: 80 }] })
  // A long name is cut, so the gauges of every card keep the width the Claude cards need.
  const long = { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: { x: { limitId: 'x', limitName: 'GPT-5.3-Codex-Spark-Preview', primary: { usedPercent: 1, windowDurationMins: 300 } } } }
  expect(limitsOf(long).limits[0]?.label).toBe('GPT-5.3-Cod…')
  // A limit with only a weekly window shows; one with two windows names the second by its length.
  const secondOnly = { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: { spark: { limitId: 'spark', limitName: 'Spark', primary: null, secondary: { usedPercent: 100, windowDurationMins: 10_080 } } } }
  expect(limitsOf(secondOnly).limits).toEqual([{ label: 'Spark', percent: 100 }])
  const both = { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: { spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: { usedPercent: 2, windowDurationMins: 10_080 } } } }
  expect(limitsOf(both).limits.map(limit => limit.label)).toEqual(['Spark', 'Spark wk'])
  // A main limit without an id is not drawn a second time from its copy by id.
  const window = { usedPercent: 35, windowDurationMins: 300 }
  const unnamed = { rateLimits: { limitId: null, primary: window }, rateLimitsByLimitId: { codex: { limitId: null, primary: window } } }
  expect(limitsOf(unnamed).limits).toEqual([{ label: '5h', percent: 35 }])
})

/**
 * A `codex app-server` behind the mod's shell that answers each request with
 * `answers[method]`, or never where `answers` has none, and counts its starts
 * and its ends.
 */
function fakeServer(answers: Record<string, unknown>, initialize: 'answer' | 'never' | 'error' = 'answer') {
  const counts = { started: 0, closed: 0 }
  const out: string[] = []
  let wake: (() => void) | undefined
  let isClosed = false
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
          counts.closed += 1
          isClosed = true
          wake?.()
          return stream.return(value)
        },
        throw: (error: unknown) => stream.throw(error),
      }

      return child as never
    },
    write: async (_path, text) => {
      for (const line of text.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method?: string }
        if (message.method === 'initialize' && initialize === 'error') {
          out.push(JSON.stringify({ id: message.id, error: { code: -32603, message: 'not ready' } }))
          continue
        }
        const answer = message.method === 'initialize' ? (initialize === 'answer' ? {} : undefined) : message.method ? answers[message.method] : undefined
        if (message.id !== undefined && answer !== undefined) out.push(JSON.stringify({ id: message.id, result: answer }))
      }
      wake?.()
    },
    stat: async () => ({ kind: 'other', isLink: false }),
  }

  return { host, counts }
}

function codexContext(answers: Record<string, unknown>, start: CodexAccountView | null = { lookedAt: 0 }, initialize: 'answer' | 'never' | 'error' = 'answer') {
  const machine = fakeMachine({ now: 10_000_000 })
  const server = fakeServer(answers, initialize)
  let held = start
  const ctx: CodexAccountContext = {
    io: machine.io,
    host: server.host,
    cwd: async () => '/work',
    cell: { get: async () => held, set: async value => void (held = value) },
    messages: () => m,
  }

  return { ctx, machine, counts: server.counts, held: () => held }
}

test('a lookup files the login, its windows and its credits, and ends the Codex it started', async () => {
  const codex = codexContext({ 'account/read': ACCOUNT, 'account/rateLimits/read': LIMITS })
  await refreshCodexAccount(codex.ctx, false)
  expect(codex.held()).toMatchObject({ login: { kind: 'chatgpt', email: 'dana@example.com' }, reading: { limits: [{ label: 'wk', percent: 35 }] }, credits: { balance: 62_500 } })
  expect(codex.counts).toEqual({ started: 1, closed: 1 })
})

test('the open pane looks Codex up again only after five minutes; Refresh at once; nowhere without the Codex CLI', async () => {
  const codex = codexContext({ 'account/read': ACCOUNT, 'account/rateLimits/read': LIMITS })
  await refreshCodexAccount(codex.ctx, false)
  await codex.machine.advance(CODEX_LOOKUP_MS - 1000)
  await refreshCodexAccount(codex.ctx, false)
  expect(codex.counts.started).toBe(1)
  await refreshCodexAccount(codex.ctx, true)
  expect(codex.counts.started).toBe(2)
  await codex.machine.advance(CODEX_LOOKUP_MS)
  await refreshCodexAccount(codex.ctx, false)
  expect(codex.counts.started).toBe(3)

  const absent = codexContext({ 'account/read': ACCOUNT }, null)
  await refreshCodexAccount(absent.ctx, true)
  expect(absent.counts.started).toBe(0)
  expect(absent.held()).toBeNull()
})

test('a Codex that does not answer is given up after fifteen seconds and ended; the figures before stay, with why', async () => {
  const before: CodexAccountView = { login: { kind: 'chatgpt', email: 'dana@example.com', plan: 'pro' }, reading: { limits: [{ label: 'wk', percent: 20 }], fetchedAt: 1 }, lookedAt: 1 }
  const codex = codexContext({ 'account/read': ACCOUNT }, before)
  const lookup = refreshCodexAccount(codex.ctx, true)
  await codex.machine.settled()
  await codex.machine.advance(15_000)
  await lookup
  expect(codex.held()?.reading).toEqual({ limits: [{ label: 'wk', percent: 20 }], fetchedAt: 1, error: m.codexNoAnswer(15) })
  expect(codex.held()?.login).toEqual(before.login)
  expect(codex.counts).toEqual({ started: 1, closed: 1 })
})

/** A Codex card as a lookup leaves it, figures a minute and more old. */
const CARD: CodexAccountView = {
  login: { kind: 'chatgpt', email: 'dana@example.com', plan: 'pro' },
  reading: { limits: [{ label: 'wk', percent: 35, resetsAt: '2099-01-01T00:00:00Z' }], fetchedAt: 0 },
  credits: { isUnlimited: false, balance: 62_500 },
  lookedAt: 0,
}

test('the Accounts tab draws a Codex card under the Claude ones: the login, its plan, its windows and its credits', async ($, on) => {
  seedState(on, { codexAccount: CARD }, 5 * 60_000)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'codex-card' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(await ui.find({ type: 'Text', text: 'Codex' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  dana@example.com' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  Pro' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^wk / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Credits 62,500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(updated 5m ago\)/ })).toBeDefined()
  }
})

test('credits under one show their decimals; whole ones are grouped', async ($, on) => {
  seedState(on, { codexAccount: { ...CARD, credits: { isUnlimited: false, balance: 0.75 } } })
  expect(await (await mountPane($, 'terminal')).find({ type: 'Text', text: 'Credits 0.75' })).toBeDefined()
})

test('the Codex card says when no one is logged in, and why a lookup failed', async ($, on) => {
  seedState(on, { codexAccount: { login: { kind: 'none' }, reading: { limits: [], fetchedAt: 0, error: m.codexNoAnswer(15) }, lookedAt: 1 } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: m.codexSignedOut })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: m.codexNoAnswer(15) })).toBeDefined()
})

test('without the Codex CLI there is no Codex card', async ($, on) => {
  seedState(on, { codexAccount: null })
  expect(await (await mountPane($, 'terminal')).find({ key: 'codex-card' })).toBeUndefined()
})

test('a Codex card not looked up yet says it is loading', async ($, on) => {
  seedState(on, { codexAccount: { lookedAt: 0 } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'codex-card' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: m.loading })).toBeDefined()
})

test('control characters in what Codex reports never reach the tree, at a narrow width too', async ($, on) => {
  const odd = 'da\u001b[31mna\u0007@example.com'
  seedState(on, { codexAccount: { ...CARD, login: { kind: 'chatgpt', email: odd, plan: 'p\u0008ro' }, reading: { ...CARD.reading, error: 'bad\u009bthing' } } })
  const ui = await mountPane($, 'terminal', 40)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => String(found.text))
  expect(texts.some(text => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text))).toBe(false)
  expect(await ui.find({ key: 'codex-card' })).toBeDefined()
})

test('a Refresh while the tick looks Codex up starts no second Codex', async () => {
  const codex = codexContext({ 'account/read': ACCOUNT, 'account/rateLimits/read': LIMITS })
  await Promise.all([refreshCodexAccount(codex.ctx, false), refreshCodexAccount(codex.ctx, true)])
  expect(codex.counts.started).toBe(1)
})

test('a Codex that never finishes starting, or fails to, is ended all the same', async () => {
  const silent = codexContext({ 'account/read': ACCOUNT }, { lookedAt: 0 }, 'never')
  const lookup = refreshCodexAccount(silent.ctx, true)
  await silent.machine.settled()
  await silent.machine.advance(15_000)
  await lookup
  expect(silent.held()?.reading?.error).toBe(m.codexNoAnswer(15))
  expect(silent.counts).toEqual({ started: 1, closed: 1 })

  const failing = codexContext({ 'account/read': ACCOUNT }, { lookedAt: 0 }, 'error')
  await refreshCodexAccount(failing.ctx, true)
  expect(failing.held()?.reading?.error).toBe('not ready')
  expect(failing.counts).toEqual({ started: 1, closed: 1 })
})
