// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

// What Codex asks while a turn runs (an approval, a question for the user, an
// MCP server's form) goes back to Claude as the agent's report, and Claude's
// next message to the agent is the answer. These turn one into the other.

import { commandOf } from './events'

export type Asked = { id: number | string; method: string; params: any }

export type Reply = { result: unknown } | { error: { code: number; message: string } }

const APPROVAL = 'Reply "approve", "approve for session", "decline", or "cancel" (decline and stop the turn).'

// The question as Claude reads it, or undefined for a request no person can
// answer, which the mod refuses for Codex.
export function questionOf(asked: Asked): string | undefined {
  const p = asked.params ?? {}
  const why = p.reason ? `\nReason: ${p.reason}` : ''
  switch (asked.method) {
    case 'item/commandExecution/requestApproval':
      return `Codex asks to run:\n  ${commandOf(p.command ?? '(no command given)')}\nin ${p.cwd ?? 'its working directory'}${why}\n${APPROVAL}`
    case 'item/fileChange/requestApproval':
      return `Codex asks to change files${p.grantRoot ? ` under ${p.grantRoot}` : ''}.${why}\n${APPROVAL}`
    case 'item/permissions/requestApproval':
      return `Codex asks for more permissions: ${JSON.stringify(p.permissions)}${why}\nReply "approve", "approve for session", or "decline".`
    case 'item/tool/requestUserInput': {
      const questions = (p.questions ?? []) as any[]
      const listed = questions.map((q, i) => {
        const options = (q.options ?? []).map((o: any) => o.label ?? o.value ?? String(o)).join(' / ')
        return `${i + 1}. ${q.question}${options ? ` (${options})` : ''}`
      })
      return `Codex asks:\n${listed.join('\n')}\nReply with the answer${questions.length > 1 ? 's, one line each, in order' : ''}.`
    }
    case 'mcpServer/elicitation/request':
      return `The ${p.serverName} MCP server asks: ${p.message ?? JSON.stringify(p)}\nReply "accept" (with the JSON it asks for on the next lines, if any), "decline", or "cancel".`
    default:
      return undefined
  }
}

const SAID = (reply: string) => reply.trim().toLowerCase().replace(/[.!]+$/, '')

function decisionOf(reply: string): 'accept' | 'acceptForSession' | 'decline' | 'cancel' | undefined {
  const said = SAID(reply)
  if (/^(approve|accept|yes|y|ok|allow)( it)?$/.test(said)) return 'accept'
  if (/^(approve|accept|allow) (for (the )?session|always)$/.test(said)) return 'acceptForSession'
  if (/^(decline|deny|no|n|reject)$/.test(said)) return 'decline'
  if (/^(cancel|stop|abort)$/.test(said)) return 'cancel'
  return undefined
}

// Codex's response to what it asked, from Claude's reply; undefined when the
// reply does not answer it, so the question is asked again.
export function replyOf(asked: Asked, reply: string): Reply | undefined {
  const p = asked.params ?? {}
  switch (asked.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      const decision = decisionOf(reply)
      return decision && { result: { decision } }
    }
    case 'item/permissions/requestApproval': {
      const decision = decisionOf(reply)
      if (!decision) return undefined
      const isGranted = decision === 'accept' || decision === 'acceptForSession'
      return {
        result: {
          permissions: isGranted ? p.permissions : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        },
      }
    }
    case 'item/tool/requestUserInput': {
      const questions = (p.questions ?? []) as any[]
      const said = reply.trim().split('\n').map(l => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean)
      if (said.length === 0) return undefined
      const answers: Record<string, { answers: string[] }> = {}
      questions.forEach((q, i) => {
        answers[q.id] = { answers: [questions.length === 1 ? reply.trim() : (said[i] ?? '')] }
      })
      return { result: { answers } }
    }
    case 'mcpServer/elicitation/request': {
      const [first = '', ...rest] = reply.trim().split('\n')
      const action = SAID(first)
      if (action === 'decline' || action === 'cancel') return { result: { action, content: null } }
      if (action !== 'accept') return undefined
      if (rest.join('\n').trim() === '') return { result: { action, content: null } }
      try {
        return { result: { action, content: JSON.parse(rest.join('\n')) } }
      } catch (error) {
        if (error instanceof SyntaxError) return undefined
        throw error
      }
    }
    default:
      return { error: { code: -32601, message: `sc-accounts cannot answer ${asked.method}` } }
  }
}

// A report that is Codex's question, as questionOf words it.
const ASKS = /^(?:That does not answer Codex\.\s+)?(?:Codex asks|The \S+ MCP server asks)/

// Whether a message is a decision sent to a question whose Codex is gone (the
// session was resumed, the mod reloaded, or Codex exited while it waited):
// the agent's last report was the question and the message decides it. Such
// a message is not passed to Codex as a new turn.
export function expiredAnswer(lastReport: string | undefined, message: string): boolean {
  return lastReport !== undefined && ASKS.test(lastReport) && decisionOf(message) !== undefined
}
