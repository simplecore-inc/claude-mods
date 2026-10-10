// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { HANDBACK, type ApiTurn } from '../../hooks/codex/request'
import { unlessAborted } from '../../hooks/codex/step'
import { codex, engine, INSTALL, REMINDER, step, TASK, THREAD } from './fake'

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown

describe('a codex agent', () => {
  test('hands back what Codex asks, and its next message answers the same paused turn', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on)

    const asked = await step($, 0)
    expect(asked.report).toContain("Codex asks to run:\n  printf hi > note.txt")
    // Every step is the agent's own text, which its view shows; each is also
    // appended as a notice (the test runner stores no appended row).
    expect(asked.text).toBe(`codex Luna 6 · Codex\ncodex session ${THREAD}\n\n`)
    expect(fake.argv).toContain('approvals_reviewer="user"')
    expect(fake.isClosed).toBe(false)

    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: asked.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: asked.report } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'h1', content: 'Report delivered to your caller.' },
          { type: 'text', text: 'The coordinator sent a message while you were working:\napprove\n\nAddress this before completing your current task.\n' },
          { type: 'text', text: 'approve' },
        ],
      },
    )
    const done = await step($, 1)
    expect(fake.decisions).toEqual(['accept'])
    expect(done.report).toBe('Created note.txt.')
    expect(done.text).toBe('answered Codex\nCreated note.txt.\n\n')
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
    expect(fake.isClosed).toBe(true)
  })

  test('a Codex without app-server says what to install, and nothing is written once it is gone', async ($, on) => {
    engine(on, [{ role: 'user', content: [{ type: 'text', text: 'Read go.mod.' }] }])
    const fake = codex(on, 'no-app-server')
    const { report } = await step($, 0)
    expect(report).toContain('codex failed:')
    expect(report).toContain(INSTALL)
    expect(fake.writesAfterClose).toBe(0)
  })

  test('no codex on the PATH says what to install', async ($, on) => {
    engine(on, [{ role: 'user', content: [{ type: 'text', text: 'Read go.mod.' }] }])
    codex(on, 'no-codex')
    expect((await step($, 0)).report).toContain(INSTALL)
  })

  test('a "not found" of Codex\'s own is not taken for a missing CLI', async ($, on) => {
    engine(on, [{ role: 'user', content: [{ type: 'text', text: 'Read go.mod.' }] }])
    codex(on, 'config-not-found')
    const { report } = await step($, 0)
    expect(report).toContain('config profile not found')
    expect(report).not.toContain(INSTALL)
  })

  test('an answer to a question whose Codex has gone says so and starts no new turn', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'crash')
    const asked = await step($, 0)
    expect(asked.report).toContain('Codex asks to run:')
    await new Promise<void>(resolve => setTimeout(() => resolve(), 30))
    expect(fake.isClosed).toBe(true)
    const spawned = fake.argv
    fake.argv = []
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: asked.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: asked.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'Report delivered to your caller.' }, { type: 'text', text: 'approve' }] },
    )
    const { report } = await step($, 1)
    expect(report).toContain('expired')
    expect(fake.decisions).toEqual([])
    expect(fake.argv).toEqual([])
    expect(fake.writesAfterClose).toBe(0)
    expect(spawned.length).toBeGreaterThan(0)
  })
})

describe('unlessAborted', () => {
  test('leaves no listener on the signal once each wait settles', async () => {
    let listeners = 0
    const signal = {
      aborted: false,
      addEventListener: () => void listeners++,
      removeEventListener: () => void listeners--,
    } as unknown as AbortSignal
    for (let i = 0; i < 50; i++) await unlessAborted(signal, Promise.resolve(i))
    expect(listeners).toBe(0)
  })
})
