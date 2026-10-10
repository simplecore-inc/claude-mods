// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import type { Hook, TurnStepChunk, TurnUsage } from 'claude-code'

import type { CodexOpenings, CodexOptions, CodexRun, CodexRuns, CodexSent } from '../../types'
import { TYPES } from './agents'
import { answersOf, isCommand, threadParamsOf } from './commands'
import { answerOf, apply, reportOf, STOPPED, type Run } from './events'
import { flagsOf, type Flags, type Pin } from './flags'
import { labelOf } from './model'
import { expiredAnswer, questionOf, replyOf, type Asked } from './questions'
import { HANDBACK, handsBack, lastAnswer, requestOf, rowsOf, undeliveredReport, type ApiTurn } from './request'
import { NO_CODEX, open, type Host, type Server } from './server'
import { openView, setReply } from './view'

// One step of a codex agent's loop: its model request answered by driving
// `codex app-server`, Codex's steps streamed as the agent's text, and Codex's
// answer or question handed back.

// A value of the session's state, read whole and changed in one step.
export type Shared<T> = { get: () => Promise<T>; update: (change: (value: T) => T) => Promise<void> }

// What a codex agent's step reaches the engine through. The hooks module
// builds it over `$`; a test drives the step through the engine instead.
export type CodexContext = {
  // The agent's type, from the engine's agent list; undefined for no such agent.
  agentType: (agentId: string) => Promise<string | undefined>
  // The agent's conversation as the model would be sent it.
  messages: (agentId: string) => Promise<readonly ApiTurn[]>
  cwd: () => Promise<string>
  host: Host
  read: (path: string) => Promise<string>
  // Appends a notice to the agent's conversation, which refreshes its row's activity line.
  note: (agentId: string, text: string) => Promise<void>
  // Redraws the band, where a command's reply shows.
  invalidate: () => void
  sent: Shared<CodexSent>
  openings: Shared<CodexOpenings>
  options: Shared<CodexOptions>
  runs: Shared<CodexRuns>
}

type StepInput = Parameters<Hook<'turn.step'>>[1]
type StepNext = Parameters<Hook<'turn.step'>>[2]

// A Codex turn paused on a question, by agent id: the server stays up until
// the agent's next message answers it.
const held = new Map<string, { server: Server; asked: Asked; threadId: string }>()

// The Codex turn each codex agent is running now, by agent id, so a message
// sent to the agent meanwhile can join it rather than wait for it to end.
const working = new Map<string, { server: Server; threadId: string; turnId: string }>()

// Adds a message to the agent's running Codex turn; false when no turn runs
// or Codex refused (the turn had just ended), so the message takes the usual
// way: the agent's next turn.
export async function steer(agentId: string, text: string): Promise<boolean> {
  const turn = working.get(agentId)
  if (!turn) return false
  try {
    await turn.server.call('turn/steer', { threadId: turn.threadId, expectedTurnId: turn.turnId, input: [{ type: 'text', text }] })
    return true
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return false
  }
}

// Ends every Codex turn left waiting on a question.
export function closeHeld(): void {
  for (const { server } of held.values()) server.close()
  held.clear()
}

// Records what Codex reported the agent's session runs with (or keeps the
// last), with its token total once Codex has counted it.
async function record(ctx: CodexContext, agentId: string, report: Omit<CodexRun, 'tokens'> | undefined, tokens?: CodexRun['tokens']): Promise<void> {
  await ctx.runs.update(all => {
    const base = report ?? all[agentId]
    return base ? { ...all, [agentId]: { ...base, tokens: tokens ?? all[agentId]?.tokens ?? { input: 0, cached: 0, output: 0 } } } : all
  })
}

const shown = (text: string): TurnStepChunk => ({ kind: 'text', index: 0, text })

// Codex's progress also as notices in the agent's conversation, appended as
// it happens: a notice is what refreshes the agent list's activity line, while
// the agent's view shows the step's text. The model never reads a notice, and
// only the detailed transcript (ctrl+o) shows both. Display only, so a refused
// append changes nothing else.
async function note(ctx: CodexContext, agentId: string, text: string): Promise<void> {
  await ctx.note(agentId, text.trimEnd()).catch(() => undefined)
}

// Resolves undefined when the step is aborted first; the listener goes once
// the wait settles, so a long turn does not pile them up on the signal.
export function unlessAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  let stop = () => {}
  const aborted = new Promise<undefined>(resolve => {
    stop = () => resolve(undefined)
    signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', stop))
}

const EXPIRED =
  'codex: the question Codex asked has expired: the Codex turn that asked it is gone (Codex exited, the session was resumed, or the mod reloaded), so nothing was answered. Send the task again to start a new turn.'

// The agent's `/codex-*` commands, answered in order; a setting is kept for
// its next Codex turn.
async function answered(ctx: CodexContext, agentId: string, commands: string[], pin?: Pin): Promise<string[]> {
  const last = (await ctx.runs.get())[agentId]
  let replies: string[] = []
  await ctx.options.update(all => {
    const answers = answersOf(commands, all[agentId] ?? {}, pin, last)
    replies = answers.replies
    return { ...all, [agentId]: answers.options }
  })
  return replies
}

// A registered /codex- command acts on the agent whose view is open and
// answers in that view's band; the main conversation is not sent the reply.
// Undefined when the open view is no codex agent's: the caller says so.
export async function command(ctx: CodexContext, name: string, args: string): Promise<'answered' | undefined> {
  const id = openView()
  const type = id === undefined ? undefined : TYPES[(await ctx.agentType(id)) ?? '']
  if (id === undefined || !type) return undefined
  const [reply = ''] = await answered(ctx, id, [`/${name} ${args}`.trim()], type.pin)
  setReply(id, reply)
  ctx.invalidate()
  return 'answered'
}

// Whether the agent is a codex agent, whose loop `step` answers.
export async function isCodexAgent(ctx: CodexContext, agentId: string | undefined): Promise<boolean> {
  return agentId !== undefined && TYPES[(await ctx.agentType(agentId)) ?? ''] !== undefined
}

export async function* step(ctx: CodexContext, e: StepInput, next: StepNext) {
  const agentId = e.agentId
  if (!agentId) return yield* next(e)
  const type = TYPES[(await ctx.agentType(agentId)) ?? '']
  if (!type) return yield* next(e)

  const rows = rowsOf(await ctx.messages(agentId))
  const given = (await ctx.sent.get())[agentId] ?? []
  const request = requestOf(rows, given, (await ctx.openings.get())[agentId])
  // Codex's progress is the transcript's text; the report goes back with a
  // handback call, or as the final text where the loop has no such tool.
  const handback = handsBack(rows)

  const run: Run = {}
  let progress = ''
  let question: string | undefined
  let model = 'codex'
  let server: Server | undefined
  const show = (text: string) => {
    progress += text
    return shown(text)
  }
  // A `/codex-*` message is the mod's to answer; the rest is Codex's.
  const asked = request?.texts.filter(text => !isCommand(text)) ?? []
  const replies = request ? await answered(ctx, agentId, request.texts.filter(isCommand), type.pin) : []
  for (const reply of replies) {
    yield show(`${reply}\n\n`)
    await note(ctx, agentId, reply)
  }
  let report: Omit<CodexRun, 'tokens'> | undefined
  // Whether Codex took this step's messages: it started their turn, or its
  // question was answered. From then they are passed on, finished or not.
  let isTaken = false
  if (request) {
    const prompt = asked.join('\n\n')
    // A question whose Codex has gone holds nothing: a decision sent to it
    // expires below, and a new task starts a new turn of the session.
    const waiting = held.get(agentId)
    if (waiting?.server.isEnded()) held.delete(agentId)
    const pending = waiting?.server.isEnded() ? undefined : waiting
    const reply = pending && replyOf(pending.asked, prompt)
    const cwd = await ctx.cwd()
    try {
      if (asked.length === 0) {
        // Commands alone: Codex is not asked, and a question it asked still waits.
      } else if (!pending && expiredAnswer(lastAnswer(rows), prompt)) {
        question = EXPIRED
      } else if (pending && !reply) {
        // Not an answer: ask again, Codex still waiting.
        question = `That does not answer Codex.\n\n${questionOf(pending.asked)}`
      } else if (pending && reply) {
        held.delete(agentId)
        server = pending.server
        run.threadId = pending.threadId
        await server.respond(pending.asked.id, reply)
        isTaken = true
        yield show(`answered Codex\n`)
        await note(ctx, agentId, 'answered Codex')
      } else {
        // Once Codex has taken a message the agent's session goes on, even
        // where the conversation keeps no session line (a step stopped first).
        const sessionId = given.length > 0 ? (request.sessionId ?? (await ctx.runs.get())[agentId]?.threadId) : undefined
        const first = sessionId === undefined
        // The spawn prompt's flags hold for every run of the agent; they are
        // not part of the task.
        const flags = flagsOf(request.opening, type.pin)
        if ('error' in flags) throw new Error(flags.error)
        const set = threadParamsOf((await ctx.options.get())[agentId] ?? {})
        server = await open(ctx.host, flags.args, cwd)
        const where = flags.cwd ?? cwd
        const config = { ...set.config, ...(await rootsOf(server, flags.addDirs)) }
        const overrides = { ...set, ...(Object.keys(config).length > 0 ? { config } : {}) }
        const thread = first
          ? await server.call('thread/start', { cwd: where, ...(flags.ephemeral ? { ephemeral: true } : {}), ...overrides })
          : await server.call('thread/resume', { threadId: sessionId, cwd: where, ...overrides })
        // What the session runs on, as Codex reports it.
        report = reportOf(thread)
        run.threadId = report.threadId
        // Known now, for /codex-status while the turn runs.
        await record(ctx, agentId, report)
        model = report.model
        yield show(`codex ${labelOf({}, { model: report.model, effort: report.effort ?? undefined })} · ${type.shown}\ncodex session ${run.threadId}\n\n`)
        const images = flags.images.map(path => ({ type: 'localImage', path }))
        const schema = flags.outputSchema ? { outputSchema: JSON.parse(await ctx.read(flags.outputSchema)) } : {}
        const opens = asked[0] === request.opening
        const text = opens ? (flagsOf(prompt, type.pin) as Flags).prompt : prompt
        // The spawn prompt's images go with its own turn, not again with each follow-up.
        const started = await server.call('turn/start', { threadId: run.threadId, input: [{ type: 'text', text }, ...(opens ? images : [])], ...schema })
        isTaken = true
        if (started?.turn?.id) working.set(agentId, { server, threadId: run.threadId!, turnId: started.turn.id })
      }
      while (server && !question) {
        const message = await unlessAborted(next.signal, server.next())
        if (!message) {
          if (!next.signal.aborted) run.error = `codex app-server exited: ${server.stderr().trim().split('\n').at(-1) || 'no reason given'}`
          break
        }
        if (message.id !== undefined) {
          const asked = { id: message.id, method: message.method, params: message.params }
          question = questionOf(asked)
          if (question) held.set(agentId, { server, asked, threadId: run.threadId! })
          else await server.respond(message.id, replyOf(asked, '')!)
          continue
        }
        const step = apply(run, message.method, message.params)
        if (step !== undefined) {
          yield show(step)
          await note(ctx, agentId, step)
        }
        if (run.isDone) break
      }
    } catch (err) {
      // Stopped while Codex was starting (the engine ends the child, and the
      // wait fails with it): a cut-off, not a failure, so nothing untaken is
      // marked passed on.
      if (!next.signal.aborted) {
        run.error = (err as Error).message
        // Only a missing CLI, or one too old for app-server, earns the hint.
        if (`${run.error}\n${server?.stderr() ?? ''}`.includes(NO_CODEX) || /unrecognized subcommand '?app-server/.test(`${run.error}\n${server?.stderr() ?? ''}`)) {
          run.error += '. sc-accounts needs the Codex CLI with `codex app-server` (0.159 or newer): `npm install -g @openai/codex`, then `codex login`.'
        }
      }
    } finally {
      working.delete(agentId)
      if (server && !held.has(agentId)) server.close()
      // A step cut off (interrupted, or closed) before Codex took its messages,
      // asked or failed has passed nothing on: the next step sends them again.
      const isCutOff = asked.length > 0 && !isTaken && !question && !run.error
      // The commands were answered either way, so they are never answered again.
      const passed = isCutOff ? request.texts.filter(isCommand) : request.texts
      if (passed.length > 0) await ctx.sent.update(all => ({ ...all, [agentId]: [...(all[agentId] ?? []), ...passed] }))
      // What Codex reported this session runs with, and its token total.
      await record(ctx, agentId, report, run.tokens)
    }
  }

  // Codex's own token counts, so the agent's row shows what the run cost.
  const usage: TurnUsage | null = run.usage ? { ...run.usage, model } : null
  const codexSaid = question || (asked.length > 0 ? answerOf(run) : undefined)
  // A report that never reached the caller goes ahead of this step's answer;
  // with nothing new (the engine ran the loop again) the loop says only that.
  // A stopped step says only that it stopped, which is never such a report.
  const undelivered = undeliveredReport(rows)
  const message =
    codexSaid === STOPPED
      ? STOPPED
      : request
        ? [...(undelivered ? [undelivered] : []), ...replies, ...(codexSaid ? [codexSaid] : [])].join('\n\n')
        : (undelivered ?? 'codex: nothing new to send to Codex.')
  if (!handback) {
    // The session line lets a follow-up resume this run (see requestOf).
    const text = run.threadId ? `${message}\n\ncodex session ${run.threadId}` : message
    yield { kind: 'text', index: 1, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage }
  }
  if (progress === '' && !question) yield show(run.error ? `codex: ${run.error}\n` : 'codex: nothing to run.\n')
  const input = { message }
  yield { kind: 'tool', index: 1, id: `toolu_codex_${crypto.randomUUID().replaceAll('-', '')}`, name: HANDBACK }
  yield { kind: 'input', index: 1, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage }
  return { turnId: e.turnId, index: e.index, answer: progress, toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage }
}

// `add-dir`: the config's writable roots plus the ones asked for, since a
// thread's setting replaces the config's list rather than adding to it.
async function rootsOf(server: Server, dirs: readonly string[]): Promise<Record<string, unknown>> {
  if (dirs.length === 0) return {}
  const { config } = await server.call('config/read', {})
  return { 'sandbox_workspace_write.writable_roots': [...(config?.sandbox_workspace_write?.writable_roots ?? []), ...dirs] }
}
