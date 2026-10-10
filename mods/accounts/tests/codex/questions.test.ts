// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { expiredAnswer, questionOf, replyOf } from '../../hooks/codex/questions'

// A request as `codex app-server` sent it in a live run (read-only sandbox,
// approvals routed to the user).
const COMMAND = {
  id: 0,
  method: 'item/commandExecution/requestApproval',
  params: {
    command: `/bin/zsh -lc "printf 'hi' > hello2.txt"`,
    cwd: '/work',
    reason: `\`/bin/zsh -lc "printf 'hi' > hello2.txt"\` requires approval by policy`,
  },
}

describe('questions', () => {
  test('a command approval reads as the command, where, and why', () => {
    const q = questionOf(COMMAND)!
    expect(q).toContain(`printf 'hi' > hello2.txt`)
    expect(q).toContain('in /work')
    expect(q).toContain('approve for session')
  })

  test('replies become Codex decisions, and a reply that is none asks again', () => {
    expect(replyOf(COMMAND, 'approve')).toEqual({ result: { decision: 'accept' } })
    expect(replyOf(COMMAND, 'Approve for session.')).toEqual({ result: { decision: 'acceptForSession' } })
    expect(replyOf(COMMAND, 'no')).toEqual({ result: { decision: 'decline' } })
    expect(replyOf(COMMAND, 'cancel')).toEqual({ result: { decision: 'cancel' } })
    expect(replyOf(COMMAND, 'what would it change?')).toBeUndefined()
  })

  test('a permissions request grants what it asked for, or nothing', () => {
    const asked = { id: 1, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } }
    expect(replyOf(asked, 'approve')).toEqual({ result: { permissions: { network: { enabled: true } }, scope: 'turn' } })
    expect(replyOf(asked, 'decline')).toEqual({ result: { permissions: {}, scope: 'turn' } })
  })

  test('questions for the user take the answers in order', () => {
    const asked = {
      id: 2,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'a', question: 'Which file?' }, { id: 'b', question: 'Overwrite?', options: [{ label: 'yes' }, { label: 'no' }] }] },
    }
    expect(questionOf(asked)).toContain('2. Overwrite? (yes / no)')
    expect(replyOf(asked, '1. src/app.ts\n2. no')).toEqual({ result: { answers: { a: { answers: ['src/app.ts'] }, b: { answers: ['no'] } } } })
  })

  test('a request no person can answer is refused for Codex', () => {
    const asked = { id: 3, method: 'item/tool/call', params: {} }
    expect(questionOf(asked)).toBeUndefined()
    expect(replyOf(asked, '')).toEqual({ error: { code: -32601, message: 'sc-accounts cannot answer item/tool/call' } })
  })

  test('a decision sent after a question that is no longer held is known as one', () => {
    const asked = questionOf(COMMAND)!
    expect(expiredAnswer(asked, 'approve')).toBe(true)
    expect(expiredAnswer(`That does not answer Codex.\n\n${asked}`, 'Decline.')).toBe(true)
    expect(expiredAnswer(asked, 'Now review app.js')).toBe(false)
    expect(expiredAnswer('Found 3 bugs.', 'approve')).toBe(false)
    expect(expiredAnswer(undefined, 'approve')).toBe(false)
  })
})
