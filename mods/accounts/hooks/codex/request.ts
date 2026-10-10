// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { STOPPED } from './events'

// What a codex agent's loop is being asked: every message in its conversation
// not yet passed on. Position is no guide, since the engine moves messages
// (a message sent while the agent runs is placed twice: wrapped, in its
// first turn even ahead of the spawn prompt, and as typed, maybe a turn
// later), so the caller keeps the words already passed on (`sent`) and
// messages are counted: the same words count as often as they stand in the
// form, wrapped or as typed, that holds them more often. Sent twice, they are
// asked twice. The copies not yet passed on go in the order they stand.

export const HANDBACK = 'SubagentHandback'

const SESSION = /^codex session ([0-9a-f-]{36})$/m

// Text the engine adds to a subagent's loop that is not the caller's words:
// reminders, handback nudges, and the marker an interruption leaves.
function isEngineText(text: string): boolean {
  return text.startsWith('<system-reminder>') || text.startsWith('[handback') || text.startsWith('[Request interrupted by user')
}

// A message sent to an agent may arrive wrapped in the engine's words: a
// first line naming who sent it ("The user sent a new message while you were
// working:", "The coordinator sent a message while you were working:",
// "Another Claude session sent a message …"), the message, a blank line and
// one paragraph of instructions to a Claude subagent. Codex gets the message
// as it was sent.
const WRAPPED = /^[^\n]* sent a (?:new )?message while you were working:\n([\s\S]*)\n\n[^\n]+$/

// The sender's words, and whether the engine wrapped them.
export function formOf(text: string): { words: string; isWrapped: boolean } {
  const wrapped = WRAPPED.exec(text.trim())?.[1]
  return wrapped === undefined ? { words: text.trim(), isWrapped: false } : { words: wrapped.trim(), isWrapped: true }
}

// One turn of the conversation: its words, and its tool calls with the text
// of each one's result, once there is one.
export type Row = {
  role: 'user' | 'assistant'
  text: string
  texts: readonly string[]
  toolUses: readonly { tool: string; input: Record<string, unknown>; result?: string }[]
}

type ApiBlock = { type: string; [field: string]: unknown }
export type ApiTurn = { role: 'user' | 'assistant'; content: readonly ApiBlock[] }

// The conversation as the model would be sent it. The engine's own rows
// (`$.session.messages()`) leave out meta rows, and a message queued while the
// agent ran is one, so the API form is the one that holds every request.
export function rowsOf(turns: readonly ApiTurn[]): Row[] {
  const results = new Map<unknown, string>()
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === 'tool_result') results.set(block.tool_use_id, resultText(block.content))
    }
  }
  return turns.map(turn => {
    const texts = turn.content
      .filter(b => b.type === 'text' && typeof b.text === 'string' && !isEngineText(b.text))
      .map(b => b.text as string)
    return {
      role: turn.role,
      text: texts.join('\n\n'),
      texts,
    toolUses: turn.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        tool: String(b.name),
        input: (b.input ?? {}) as Record<string, unknown>,
        ...(results.has(b.id) ? { result: results.get(b.id) } : {}),
      })),
    }
  })
}

// `opening` is the spawn prompt, which carries the agent's options; `texts`
// are the words this request passes on, for the caller to add to `sent`.
export type Request = { prompt: string; opening: string; texts: string[]; sessionId?: string }

// `spawned` is the prompt the agent was spawned with, as recorded at spawn.
export function requestOf(rows: readonly Row[], sent: readonly string[], spawned?: string): Request | undefined {
  const forms = rows.filter(r => r.role === 'user').flatMap(r => r.texts).map(formOf)
  // The opening carries the agent's options: the spawn prompt as recorded,
  // since the engine may place a later message ahead of it, even before it
  // is first passed on (a first run cut off). Unrecorded (an agent spawned
  // before the mod loaded), the first text passed to Codex, else the first.
  const opening = spawned?.trim() ?? sent[0] ?? forms[0]?.words
  if (opening === undefined) return undefined

  // Where each copy of the same words stands, wrapped and as typed.
  const places = new Map<string, { wrapped: number[]; typed: number[] }>()
  forms.forEach(({ words, isWrapped }, at) => {
    const place = places.get(words) ?? { wrapped: [], typed: [] }
    place[isWrapped ? 'wrapped' : 'typed'].push(at)
    places.set(words, place)
  })
  // The copies not yet passed on are the latest ones, in the form that holds
  // more; they go in the order they stand in.
  const left: { at: number; words: string }[] = []
  for (const [words, { wrapped, typed }] of places) {
    const copies = wrapped.length >= typed.length ? wrapped : typed
    const count = Math.max(0, copies.length - sent.filter(text => text === words).length)
    for (const at of copies.slice(copies.length - count)) left.push({ at, words })
  }
  const texts = left.sort((a, b) => a.at - b.at).map(copy => copy.words)
  if (texts.length === 0) return undefined
  // Until the opening is passed on, it is what Codex reads first.
  const at = texts.indexOf(opening)
  if (at > 0 && !sent.includes(opening)) texts.unshift(...texts.splice(at, 1))

  let sessionId: string | undefined
  for (const row of rows) {
    if (row.role === 'assistant') sessionId = SESSION.exec(row.text)?.[1] ?? sessionId
  }
  return { prompt: texts.join('\n\n'), opening, texts, sessionId: sent.length > 0 ? sessionId : undefined }
}

// A tool result's content: a string, or text blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

// Claude Code's error for a call to a tool the loop does not have.
const NO_SUCH_TOOL = 'No such tool available'

// Whether this loop reports through a SubagentHandback call. An interactive
// session gives subagents the tool and insists on it; a headless or SDK run
// has none and takes the final text as the report. Nothing the loop can read
// says which ahead of time, so it hands back until a handback has failed for
// want of the tool. Any other failure (the person interrupted it) says the
// tool is there.
export function handsBack(rows: readonly Row[]): boolean {
  return !rows.some(r => r.toolUses.some(u => u.tool === HANDBACK && u.result?.includes(NO_SUCH_TOOL)))
}

// Claude Code's result for a handback that reached the caller (2.1.287
// records it inside a JSON object).
const DELIVERED = 'Report delivered to your caller.'

// The report of the last handback the loop sent, unless it was delivered: a
// handback that failed (no such tool) or was interrupted never reached the
// caller, so it is given again, once: a later turn that carries it as text
// (the loop then reports as text) has given it. A stopped run's line is no
// report: the one before it is the last.
export function undeliveredReport(rows: readonly Row[]): string | undefined {
  let last: { use: Row['toolUses'][number]; at: number } | undefined
  rows.forEach((row, at) => {
    for (const use of row.toolUses) {
      if (use.tool === HANDBACK && typeof use.input.message === 'string' && use.input.message !== STOPPED) last = { use, at }
    }
  })
  if (!last || last.use.result?.includes(DELIVERED)) return undefined
  const report = last.use.input.message as string
  return rows.slice(last.at + 1).some(r => r.role === 'assistant' && r.text.includes(report)) ? undefined : report
}

// What the agent last reported: its last turn's handback, or its text where
// the loop reports as text (headless).
export function lastAnswer(rows: readonly Row[]): string | undefined {
  const row = rows.findLast(r => r.role === 'assistant')
  if (!row) return undefined
  const use = row.toolUses.findLast(u => u.tool === HANDBACK && typeof u.input.message === 'string')
  return use ? (use.input.message as string) : row.text
}
