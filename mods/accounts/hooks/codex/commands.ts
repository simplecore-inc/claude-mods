// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import type { CodexOptionName, CodexRun } from '../../types'
import { groupDigits } from '../format'
import type { Messages } from '../i18n'
import { APPROVALS, flagsOf, SANDBOXES, type Pin } from './flags'

// `/codex-*` messages, which a codex agent answers itself and never passes to
// Codex: settings for its next Codex turns, its status, and help. They are
// typed in the agent's view, where Claude Code hands a command it does not
// know to the agent as a message. A setting is the Codex option line it
// names, so it is checked by the option rules and the agent type's pin.

export type Options = Partial<Record<CodexOptionName, string>>

// The reply, and the agent's settings when the command changed them.
export type Answer = { reply: string; options?: Options }

const SETTINGS: Record<string, { option: CodexOptionName; value: string }> = {
  model: { option: 'model', value: '<id>' },
  effort: { option: 'effort', value: '<level>' },
  sandbox: { option: 'sandbox', value: `<${SANDBOXES.join('|')}>` },
  approvals: { option: 'ask-for-approval', value: `<${APPROVALS.join('|')}>` },
}

// The commands as Claude Code registers them, listed in a codex agent's view,
// described in the person's language.
export function commandSpecs(m: Messages): { name: string; description: string; argumentHint?: string; immediate: true }[] {
  return [
    ...Object.entries(SETTINGS).map(([name, { value }]) => ({
      name: `codex-${name}`,
      description: m.codexCommands[name as keyof Messages['codexCommands']],
      argumentHint: value,
      immediate: true as const,
    })),
    { name: 'codex-status', description: m.codexCommands.status, immediate: true },
    { name: 'codex-help', description: m.codexCommands.help, immediate: true },
  ]
}

const NAMES = [...Object.keys(SETTINGS), 'status', 'help'].map(name => `/codex-${name}`)

const HELP = [
  'Codex commands for this agent (a setting applies from its next Codex turn):',
  ...Object.entries(SETTINGS).map(([name, { value }]) => `  /codex-${name} ${value}`),
  '  /codex-status   what Codex runs with, the session and its tokens',
  '  /codex-help     this list',
].join('\n')

// The footer hint while a codex agent's view is open.
export const HINT = NAMES.join(' ')

const COMMAND = /^\/codex-(\S*)(?:\s+([\s\S]*))?$/

export function isCommand(text: string): boolean {
  return text.trimStart().startsWith('/codex-')
}

// Whether a slash command is one this plugin registers (`codex-model`); a
// command of another's that only starts the same (`codex-review`) is not.
export function isOwnCommand(command: string): boolean {
  return NAMES.includes(`/${command}`)
}

export function answerOf(text: string, options: Options, pin: Pin | undefined, run: CodexRun | undefined): Answer {
  const match = COMMAND.exec(text.trim())
  const name = match?.[1] ?? ''
  const value = (match?.[2] ?? '').trim()
  if (name === 'status') return { reply: statusOf(options, run) }
  const setting = SETTINGS[name]
  if (!setting || value === '') {
    const why = name === 'help' ? '' : setting ? `codex: /codex-${name} needs a value.\n\n` : `codex: no /codex-${name}.\n\n`
    return { reply: `${why}${HELP}` }
  }
  // One plain word: a value that spans lines would carry option lines of its own.
  if (/\s/.test(value)) return { reply: `codex: /codex-${name} takes one plain value, not "${value}".` }
  const parsed = flagsOf(`${setting.option}: ${value}`, pin)
  if ('error' in parsed) return { reply: `codex: ${parsed.error}` }
  if (parsed.prompt !== '') return { reply: `codex: /codex-${name} takes one plain value, not "${value}".` }
  return { reply: `codex: ${name} ${value} from the next Codex turn.`, options: { ...options, [setting.option]: value } }
}

// Commands answered in order, each seeing the settings the ones before it
// left; the replies, and the agent's settings after them.
export function answersOf(texts: readonly string[], options: Options, pin: Pin | undefined, run: CodexRun | undefined): { replies: string[]; options: Options } {
  let mine = options
  const replies = texts.map(text => {
    const answer = answerOf(text, mine, pin, run)
    mine = answer.options ?? mine
    return answer.reply
  })
  return { replies, options: mine }
}

// The settings as thread/start and thread/resume take them: a resumed
// session keeps the model, sandbox and approvals it ran with unless the call
// names others, so they go with every call.
export function threadParamsOf(options: Options): { model?: string; sandbox?: string; approvalPolicy?: string; config?: Record<string, string> } {
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options['ask-for-approval'] ? { approvalPolicy: options['ask-for-approval'] } : {}),
    ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
  }
}

const count = groupDigits

function statusOf(options: Options, run: CodexRun | undefined): string {
  const now: Record<CodexOptionName, string | undefined> = {
    model: run?.model,
    effort: run ? (run.effort ?? 'default') : undefined,
    sandbox: run?.sandbox,
    'ask-for-approval': run?.approvals,
  }
  const rows = Object.entries(SETTINGS).flatMap(([name, { option }]) => {
    const next = options[option]
    if (next !== undefined && next !== now[option]) return [`${name.padEnd(10)}${next} from the next Codex turn${now[option] ? ` (now ${now[option]})` : ''}`]
    return now[option] ? [`${name.padEnd(10)}${now[option]}`] : []
  })
  if (!run) return ['codex: no Codex turn yet.', ...rows].join('\n')
  const { input, cached, output } = run.tokens
  return [...rows, `${'session'.padEnd(10)}${run.threadId}`, `${'tokens'.padEnd(10)}${count(input)} in (${count(cached)} cached), ${count(output)} out, running total`].join('\n')
}
