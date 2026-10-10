// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import type { ApiTurn } from '../../hooks/codex/request'
import { codex, engine, REMINDER, step, TASK } from './fake'

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown

async function until(isTrue: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !isTrue(); i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
}

describe('a message sent to a codex agent while Codex works', () => {
  test('joins the running Codex turn and is not queued for later', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const queued: string[] = []
    on('session.send', (_$, e) => (queued.push(e.text), { isDelivered: true as const }))
    const fake = codex(on, 'busy')
    const running = step($, 0)
    await until(() => fake.prompts.length === 1)

    expect(await $.session.send({ to: 'writer', text: 'Also say banana.', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
    const done = await running
    expect(fake.steers).toEqual(['Also say banana.'])
    expect(fake.prompts).toHaveLength(1)
    expect(queued).toEqual([])
    expect(done.report).toBe('Done, and Also say banana.')
  })

  test('is queued as usual when no Codex turn is running', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const queued: string[] = []
    on('session.send', (_$, e) => (queued.push(e.text), { isDelivered: true as const }))
    const fake = codex(on, 'quiet')
    await step($, 0)

    expect(await $.session.send({ to: 'a1', text: 'Also say banana.', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
    expect(fake.steers).toEqual([])
    expect(queued).toEqual(['Also say banana.'])
  })

  test('is queued as usual when Codex refuses it because its turn just ended', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const queued: string[] = []
    on('session.send', (_$, e) => (queued.push(e.text), { isDelivered: true as const }))
    const fake = codex(on, 'ending')
    const running = step($, 0)
    await until(() => fake.prompts.length === 1)

    expect(await $.session.send({ to: 'a1', text: 'Also say banana.', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
    expect(queued).toEqual(['Also say banana.'])
    expect((await running).report).toBe('Done.')
  })
})
