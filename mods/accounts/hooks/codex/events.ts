// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

// Reads what `codex app-server` reports while a turn runs. Each notification
// becomes a line of progress for the agent's transcript, the run's answer is
// its last agent message, and its usage is what the agent's row counts.

import type { ModelUsage } from 'claude-code'

import type { CodexRun } from '../../types'

export type Run = {
  threadId?: string
  answer?: string
  error?: string
  usage?: ModelUsage
  isDone?: boolean
  // The thread's token total before this turn's first request, which the
  // turn's output is counted from.
  before?: ModelUsage
  // The thread's token total as Codex counts it, cached tokens inside input.
  tokens?: CodexRun['tokens']
}

// What a run stopped before Codex finished answers: what Codex said on the
// way is shown in the agent's view, never handed back as its report.
export const STOPPED = 'codex: stopped before Codex finished.'

// The run's answer: Codex's last message once the turn ended, its failure, or
// that it was stopped first.
export function answerOf(run: Run): string {
  if (run.error) return `${run.answer ? `${run.answer}\n\n` : ''}codex failed: ${run.error}`
  return run.isDone ? (run.answer ?? 'codex: the turn ended without a message.') : STOPPED
}

// What a thread/start or thread/resume answer says the session runs with.
export function reportOf(answer: any): Omit<CodexRun, 'tokens'> {
  const policy = answer?.approvalPolicy
  return {
    threadId: String(answer?.thread?.id),
    model: String(answer?.model),
    effort: answer?.reasoningEffort ?? null,
    sandbox: String(answer?.sandbox?.type ?? 'unknown').replace(/[A-Z]/g, c => `-${c.toLowerCase()}`),
    approvals: typeof policy === 'string' ? policy : JSON.stringify(policy),
  }
}

// Codex counts cached tokens inside `inputTokens`; the engine's shape counts
// them apart, as the Messages API does.
export function usageOf(usage: any): ModelUsage {
  const cached = Number(usage?.cachedInputTokens) || 0
  return {
    input_tokens: Math.max(0, (Number(usage?.inputTokens) || 0) - cached),
    output_tokens: Number(usage?.outputTokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: Number(usage?.cacheWriteInputTokens) || 0,
  }
}

function minus(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    cache_read_input_tokens: Math.max(0, (a.cache_read_input_tokens ?? 0) - (b.cache_read_input_tokens ?? 0)),
    cache_creation_input_tokens: Math.max(0, (a.cache_creation_input_tokens ?? 0) - (b.cache_creation_input_tokens ?? 0)),
  }
}

// Splits streamed text into complete lines, keeping the unfinished tail.
export function lines(buffer: string, text: string): { done: string[]; rest: string } {
  const parts = (buffer + text).split('\n')
  return { done: parts.slice(0, -1), rest: parts.at(-1) ?? '' }
}

// `/bin/zsh -lc 'cat go.mod'` reads `cat go.mod`: the command the shell runs,
// its quoting undone as the shell undoes it, so a command asked about reads as
// it will run. In double quotes a backslash escapes only $ ` " \, and one
// before a newline joins the lines; in single quotes nothing is escaped, and
// '\'' closes the quote, adds a quote and opens it again.
export function commandOf(command: string): string {
  const match = /^\S*sh -lc (['"])(.*)\1$/s.exec(command)
  if (!match) return command
  const [, quote, body = ''] = match

  return quote === '"' ? body.replace(/\\([$`"\\\n])/g, (_, char: string) => (char === '\n' ? '' : char)) : body.replaceAll("'\\''", "'")
}

// Folds one notification into the run and returns the progress it shows.
// Notifications of another thread (none, while the mod runs one) are not
// this run's.
export function apply(run: Run, method: string, params: any): string | undefined {
  if (params?.threadId && run.threadId && params.threadId !== run.threadId) return undefined
  const item = params?.item
  switch (method) {
    case 'item/started':
      return item?.type === 'commandExecution' ? `$ ${commandOf(item.command)}\n` : undefined
    case 'item/completed':
      if (item?.type === 'agentMessage') {
        run.answer = item.text
        return `${item.text.trimEnd()}\n\n`
      }
      if (item?.type === 'commandExecution') return item.exitCode ? `  exit ${item.exitCode}\n` : undefined
      if (item?.type === 'fileChange') return `edited ${(item.changes ?? []).map((c: any) => c.path).join(', ')}\n`
      if (item?.type === 'webSearch') return `searched the web: ${item.query}\n`
      if (item?.type === 'mcpToolCall') return `${item.server}.${item.tool}${item.error ? ' failed' : ''}\n`
      return undefined
    case 'guardianWarning':
      return `auto review: ${params.message}\n`
    case 'thread/tokenUsage/updated': {
      // The agent's row counts as Claude Code counts a Claude subagent: the
      // latest step's input (fresh, cache read and cache write) replaces the
      // last, and each step's output adds to the outputs before it. So the
      // turn reports its last request's input, which is Codex's current
      // context, and the output the whole turn generated. The thread's
      // running total, which counts every cached re-read, goes to
      // /codex-status instead.
      const total = usageOf(params.tokenUsage?.total)
      const last = usageOf(params.tokenUsage?.last)
      const raw = params.tokenUsage?.total
      run.tokens = { input: Number(raw?.inputTokens) || 0, cached: Number(raw?.cachedInputTokens) || 0, output: Number(raw?.outputTokens) || 0 }
      run.before ??= minus(total, last)
      run.usage = { ...last, output_tokens: minus(total, run.before).output_tokens }
      return undefined
    }
    case 'error':
      // A retried error is one Codex recovers from; the turn says how it ended.
      if (params.willRetry) return undefined
      run.error = params.error?.message
      return `error: ${run.error}\n`
    case 'turn/completed': {
      run.isDone = true
      const turn = params.turn
      if (turn?.status === 'completed') run.error = undefined
      else run.error = turn?.error?.message ?? run.error ?? `the turn ended ${turn?.status ?? 'without a status'}`
      return undefined
    }
    default:
      return undefined
  }
}
