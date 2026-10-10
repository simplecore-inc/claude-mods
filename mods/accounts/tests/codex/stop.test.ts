// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { answerOf } from '../../hooks/codex/events'
import { HANDBACK, type ApiTurn } from '../../hooks/codex/request'
import { codex, engine, INTERIM, REMINDER, step, TASK, THREAD } from './fake'

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown

const STOPPED = 'codex: stopped before Codex finished.'

// A message typed in the agent's view, as the engine wraps it.
const typed = (text: string) =>
  `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`

const INTERRUPTED = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."

async function until(isTrue: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !isTrue(); i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
}

describe('a codex agent stopped', () => {
  // The test kit cannot abort a hook's signal, as Esc does, so the answer a
  // stopped run gives is checked where it is made.
  test('before Codex finished answers with the stopped line, none of what Codex said on the way', () => {
    expect(answerOf({ answer: INTERIM })).toBe(STOPPED)
    expect(answerOf({})).toBe(STOPPED)
    expect(answerOf({ answer: 'Done.', isDone: true })).toBe('Done.')
    expect(answerOf({ isDone: true })).toBe('codex: the turn ended without a message.')
    expect(answerOf({ answer: INTERIM, isDone: true, error: 'boom' })).toBe(`${INTERIM}\n\ncodex failed: boom`)
  })

  // The step closed once Codex has taken the turn, as a stop or a host move
  // closes it; the engine keeps nothing of it, so no session line to read.
  test('once Codex took the turn, the next message resumes the same Codex session and passes only that message', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'busy')
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
    let text = ''
    while (!text.includes(INTERIM)) {
      const next = await stream.next()
      if (next.done) break
      if (next.value.kind === 'text') text += next.value.text
    }
    await stream.return(undefined as never).catch(() => undefined)
    await until(() => fake.isClosed)
    expect(fake.isClosed).toBe(true)

    turns.push({ role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, { role: 'user', content: [{ type: 'text', text: typed('Only list the files.') }] })
    const again = step($, 1)
    await until(() => fake.prompts.length === 2)
    expect(fake.threads).toHaveLength(2)
    expect(fake.threads.at(-1)).toMatchObject({ threadId: THREAD })
    expect(fake.prompts.at(-1)).toBe('Only list the files.')
    await $.session.send({ to: 'writer', text: 'Go on.', origin: { kind: 'model' } } as never)
    expect((await again).report).toBe('Done, and Go on.')
  })

  test('hands back a stopped line that never goes ahead of a later answer', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    codex(on, 'quiet')
    const done = await step($, 0)
    // The stopped step's handback, interrupted, then a new message.
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: STOPPED } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: INTERRUPTED }, { type: 'text', text: typed('Count again.') }] },
    )
    expect((await step($, 1)).report).toBe('Counted.')
  })
})
