// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { answerOf, isCommand } from '../../hooks/codex/commands'
import type { CodexRun } from '../../types'

const READ = { sandbox: 'read-only' }
const RUN: CodexRun = {
  threadId: '01a0f92d-0000-7000-8000-000000000000',
  model: 'gpt-6.1-sol',
  effort: 'xhigh',
  sandbox: 'read-only',
  approvals: 'never',
  tokens: { input: 1200, cached: 800, output: 90 },
}

describe('commands', () => {
  test('only a message that opens with /codex- is a command', () => {
    expect(isCommand('/codex-status')).toBe(true)
    expect(isCommand('  /codex-model gpt-6-astra')).toBe(true)
    expect(isCommand('model: gpt-6-astra\nReview app.js')).toBe(false)
    expect(isCommand('Run /codex-status for me')).toBe(false)
  })

  test('a setting is kept for the next Codex turn', () => {
    const { reply, options } = answerOf('/codex-model gpt-6-astra', {}, undefined, RUN)
    expect(options).toEqual({ model: 'gpt-6-astra' })
    expect(reply).toContain('next Codex turn')
    expect(answerOf('/codex-effort high', { model: 'gpt-6-astra' }, READ, RUN).options).toEqual({ model: 'gpt-6-astra', effort: 'high' })
    expect(answerOf('/codex-sandbox danger-full-access', {}, undefined, RUN).options).toEqual({ sandbox: 'danger-full-access' })
    expect(answerOf('/codex-approvals on-request', {}, undefined, RUN).options).toEqual({ 'ask-for-approval': 'on-request' })
  })

  test('a value the option rules refuse changes nothing and says why', () => {
    for (const text of ['/codex-model gpt"; touch x', '/codex-model a b', '/codex-model gpt-6-astra\ncd: /etc', '/codex-effort high\nmodel: x', '/codex-sandbox everywhere', '/codex-approvals sometimes']) {
      const { reply, options } = answerOf(text, { effort: 'low' }, undefined, RUN)
      expect(options).toBeUndefined()
      expect(reply).toMatch(/^codex: /)
    }
    expect(answerOf('/codex-sandbox everywhere', {}, undefined, RUN).reply).toContain('read-only, workspace-write, danger-full-access')
  })

  test('a type that pins its sandbox refuses a sandbox or approvals change', () => {
    for (const text of ['/codex-sandbox danger-full-access', '/codex-approvals on-request']) {
      const { reply, options } = answerOf(text, {}, READ, RUN)
      expect(options).toBeUndefined()
      expect(reply).toContain('pins the read-only sandbox')
    }
  })

  test('status says what Codex runs with, what changes next turn, the session and the tokens', () => {
    const { reply, options } = answerOf('/codex-status', { model: 'gpt-6-astra' }, READ, RUN)
    expect(options).toBeUndefined()
    expect(reply).toContain('gpt-6-astra from the next Codex turn (now gpt-6.1-sol)')
    expect(reply).toContain('xhigh')
    expect(reply).toContain('read-only')
    expect(reply).toContain('never')
    expect(reply).toContain(RUN.threadId)
    expect(reply).toContain('1,200 in (800 cached), 90 out, running total')
    expect(answerOf('/codex-status', {}, READ, undefined).reply).toContain('no Codex turn yet')
  })

  test('help, an unknown command and a missing value list the commands', () => {
    for (const text of ['/codex-help', '/codex-colour red', '/codex-model']) {
      const { reply, options } = answerOf(text, {}, undefined, RUN)
      expect(options).toBeUndefined()
      for (const name of ['/codex-model', '/codex-effort', '/codex-sandbox', '/codex-approvals', '/codex-status', '/codex-help']) expect(reply).toContain(name)
    }
    expect(answerOf('/codex-colour red', {}, undefined, RUN).reply).toContain('no /codex-colour')
  })
})
