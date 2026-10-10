// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { apply, lines, type Run } from '../../hooks/codex/events'

const THREAD = '01a0f943-da7f-76c1-acf4-46885543b001'

// Notifications as `codex app-server` (codex-cli 0.159) sends them, cut to the
// fields the mod reads.
const NOTES: [string, object][] = [
  ['turn/started', { threadId: THREAD, turn: { id: 't1', status: 'inProgress' } }],
  ['item/completed', { threadId: THREAD, item: { type: 'agentMessage', text: 'Reading go.mod.\n' } }],
  ['item/started', { threadId: THREAD, item: { type: 'commandExecution', command: "/bin/zsh -lc 'cat go.mod'", exitCode: null } }],
  ['item/completed', { threadId: THREAD, item: { type: 'commandExecution', command: "/bin/zsh -lc 'cat go.mod'", exitCode: 0 } }],
  ['item/completed', { threadId: THREAD, item: { type: 'agentMessage', text: 'example.com/m go 1.26' } }],
  ['turn/completed', { threadId: THREAD, turn: { id: 't1', status: 'completed', error: null } }],
]

describe('events', () => {
  test('lines keeps a line split across chunks whole', () => {
    const a = lines('', '{"a":1}\n{"b"')
    expect(a.done).toEqual(['{"a":1}'])
    const b = lines(a.rest, ':2}\n')
    expect(b.done).toEqual(['{"b":2}'])
    expect(b.rest).toBe('')
  })

  test('a turn yields commands and messages, and answers with the last message', () => {
    const run: Run = { threadId: THREAD }
    const shown = NOTES.map(([method, params]) => apply(run, method, params)).filter(Boolean).join('')
    expect(run.answer).toBe('example.com/m go 1.26')
    expect(run.isDone).toBe(true)
    expect(run.error).toBeUndefined()
    expect(shown).toContain('$ cat go.mod')
    expect(shown).not.toContain('exit 0')
  })

  test('a failed turn records its error', () => {
    const run: Run = { threadId: THREAD }
    apply(run, 'turn/completed', { threadId: THREAD, turn: { status: 'failed', error: { message: 'quota' } } })
    expect(run.error).toBe('quota')
  })

  test('another thread is not this run', () => {
    const run: Run = { threadId: THREAD }
    expect(apply(run, 'item/completed', { threadId: 'other', item: { type: 'agentMessage', text: 'x' } })).toBeUndefined()
    expect(run.answer).toBeUndefined()
  })

  test('the automatic reviewer is shown', () => {
    expect(apply({}, 'guardianWarning', { message: 'approved (risk: low)' })).toBe('auto review: approved (risk: low)\n')
  })
})
