// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { HANDBACK, type ApiTurn } from '../../hooks/codex/request'
import { codex, engine, REMINDER, step, TASK, THREAD } from './fake'

// The test runner has timers; the mod's own environment declares none.
declare const setTimeout: (run: () => void, ms: number) => unknown

// A message typed in the agent's view, as the engine wraps it.
const typed = (text: string) =>
  `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`

// A delivered handback's result, as Claude Code 2.1.287 records it.
const DELIVERED = [{ type: 'text', text: '{"success":true,"message":"Report delivered to your caller."}' }]

// The agent's last turn handed back, and the next message the user typed.
function reply(turns: ApiTurn[], done: { text: string; report: string }, text: string, id: string): void {
  turns.push(
    { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id, name: HANDBACK, input: { message: done.report } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Report delivered to your caller.' }, { type: 'text', text: typed(text) }] },
  )
}

describe('commands in a codex agent', () => {
  test('a command is answered as the agent\'s reply without starting Codex, and a setting holds from the next Codex turn', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    let done = await step($, 0)
    expect(done.report).toBe('Counted.')

    fake.argv = []
    reply(turns, done, '/codex-model gpt-6-astra', 'h1')
    done = await step($, 1)
    expect(fake.argv).toEqual([])
    expect(done.report).toBe('codex: model gpt-6-astra from the next Codex turn.')
    expect(done.text).toContain('gpt-6-astra from the next Codex turn')

    reply(turns, done, '/codex-sandbox read-only', 'h2a')
    done = await step($, 21)
    reply(turns, done, '/codex-approvals never', 'h2b')
    done = await step($, 22)
    reply(turns, done, '/codex-status', 'h2')
    done = await step($, 2)
    expect(fake.argv).toEqual([])
    expect(done.report).toContain('gpt-6-astra from the next Codex turn (now gpt-6-luna)')
    expect(done.report).toContain('workspace-write')
    expect(done.report).toContain(THREAD)
    expect(done.report).toContain('1,500 in (1,000 cached), 40 out')

    reply(turns, done, 'Count the lines.', 'h3')
    done = await step($, 3)
    // A resumed session keeps the model it started with unless the resume
    // names another, so the setting goes with the resume.
    expect(fake.threads.at(-1)).toMatchObject({ threadId: THREAD, model: 'gpt-6-astra' })
    expect(done.text).toMatch(/^codex Astra 6 · Codex/)
    expect(fake.threads.at(-1)).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(done.report).toBe('Counted.')
  })

  test('a command and a message sent together: the command is answered and the message goes to Codex alone', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    const done = await step($, 0)
    reply(turns, done, '/codex-effort high', 'h1')
    turns.at(-1)!.content = [...turns.at(-1)!.content, { type: 'text', text: typed('Count the lines.') }]
    fake.argv = []
    const both = await step($, 1)
    expect(both.report).toBe('codex: effort high from the next Codex turn.\n\nCounted.')
    expect(fake.threads.at(-1)).toMatchObject({ config: { model_reasoning_effort: 'high' } })
    expect(fake.prompts.at(-1)).toBe('Count the lines.')
  })

  test('a step with nothing new to pass on starts no Codex and does not hand back the last report again', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    const done = await step($, 0)
    expect(done.report).toBe('Counted.')
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: done.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: DELIVERED }] },
    )
    fake.argv = []
    const again = await step($, 1)
    expect(fake.argv).toEqual([])
    expect(again.report).toBe('codex: nothing new to send to Codex.')
  })

  test('where a handback failed for want of the tool, the last report is given again as text', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    const done = await step($, 0)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: done.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: `<tool_use_error>Error: No such tool available: ${HANDBACK}</tool_use_error>`, is_error: true }] },
    )
    fake.argv = []
    const again = await step($, 1)
    expect(fake.argv).toEqual([])
    expect(again.report).toBe('Counted.')
  })

  // As seen live: the session moving host interrupts the agent's handback,
  // which never reaches the caller; Claude Code then runs the loop again.
  test('with nothing new after a handback that was not delivered, that report is handed back again', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'quiet')
    const done = await step($, 0)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: done.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed." }] },
    )
    fake.argv = []
    const again = await step($, 1)
    expect(fake.argv).toEqual([])
    expect(again.report).toBe('Counted.')
  })

  // As seen live: a background agent's handback failed for want of the tool,
  // and a message typed in its view was the next request.
  test('a report whose handback failed goes ahead of the next answer, once', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }] }]
    engine(on, turns)
    codex(on, 'quiet')
    const done = await step($, 0)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: 'The review.' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: `<tool_use_error>Error: No such tool available: ${HANDBACK}</tool_use_error>`, is_error: true }, { type: 'text', text: typed('Count the lines.') }] },
    )
    const both = await step($, 1)
    expect(both.report).toBe(`The review.\n\nCounted.\n\ncodex session ${THREAD}`)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: both.report }] },
      { role: 'user', content: [{ type: 'text', text: typed('Count again.') }] },
    )
    expect((await step($, 2)).report).toBe(`Counted.\n\ncodex session ${THREAD}`)
  })

  test('a report whose handback was interrupted goes ahead of the next answer in the next handback, once', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    codex(on, 'quiet')
    const done = await step($, 0)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: 'The review.' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed." }, { type: 'text', text: typed('Count the lines.') }] },
    )
    const both = await step($, 1)
    expect(both.report).toBe('The review.\n\nCounted.')
    reply(turns, both, 'Count again.', 'h2')
    expect((await step($, 2)).report).toBe('Counted.')
  })

  test('a step cut off before Codex finished leaves its task unsent, so the next step runs it', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'busy')
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
    // The session's header is out, Codex not yet given the task: the step is closed.
    const first = await stream.next()
    expect(first.done).toBe(false)
    await stream.return(undefined as never).catch(() => undefined)
    for (let i = 0; i < 200 && !fake.isClosed; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    expect(fake.isClosed).toBe(true)
    // Claude Code runs the loop again, on the same conversation: Codex is
    // given the task again (here finished by a message steered into it).
    fake.argv = []
    const again = step($, 1)
    for (let i = 0; i < 200 && fake.prompts.length < 1; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    expect(fake.prompts).toEqual(['Create note.txt.'])
    expect(await $.session.send({ to: 'writer', text: 'Go on.', origin: { kind: 'model' } } as never)).toEqual({ isDelivered: true })
    expect((await again).report).toBe('Done, and Go on.')
  })

  // As seen live: the first run stopped, then a message typed in the view,
  // which the engine placed ahead of the spawn prompt.
  test('a cut-off first run runs again with the spawn prompt\'s options, the new message after it', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    const fake = codex(on, 'busy')
    await $.agent.spawn({ subagentType: 'sc-accounts:codex-run', prompt: TASK, description: 'Write note' } as never)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
    await stream.next()
    await stream.return(undefined as never).catch(() => undefined)
    for (let i = 0; i < 200 && !fake.isClosed; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    turns.splice(0, 1,
      { role: 'user', content: [{ type: 'text', text: 'Just reply DONE.' }, { type: 'text', text: TASK }, { type: 'text', text: REMINDER }] },
      { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    )
    fake.argv = []
    const again = step($, 1)
    for (let i = 0; i < 200 && fake.prompts.length < 1; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    expect(fake.argv).toContain('approvals_reviewer="user"')
    expect(fake.prompts).toEqual(['Create note.txt.\n\nJust reply DONE.'])
    await $.session.send({ to: 'writer', text: 'Go on.', origin: { kind: 'model' } } as never)
    await again
  })

  test('a run that failed was passed on: its failure is the report, and a step with nothing new does not run it again', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    const fake = codex(on, 'no-codex')
    const done = await step($, 0)
    expect(done.report).toMatch(/^codex failed: /)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: done.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: DELIVERED }] },
    )
    fake.argv = []
    const again = await step($, 1)
    expect(fake.argv).toEqual([])
    expect(again.report).toBe('codex: nothing new to send to Codex.')
  })

  test('after the person interrupts a handback, the next run still reports through the handback tool', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    codex(on, 'quiet')
    const done = await step($, 0)
    turns.push(
      { role: 'assistant', content: [{ type: 'text', text: done.text }, { type: 'tool_use', id: 'h1', name: HANDBACK, input: { message: done.report } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true } as never, { type: 'text', text: '[Request interrupted by user]' }] },
      { role: 'user', content: [{ type: 'text', text: typed('Count again.') }] },
    )
    const stream = $.turn.step({ turnId: 't', index: 1, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
    let next = await stream.next()
    while (!next.done) next = await stream.next()
    expect(next.value.toolUses.map((u: { name: string }) => u.name)).toEqual([HANDBACK])
  })

  test('/codex-status during the first Codex turn names the session Codex is running', async ($, on) => {
    const turns: ApiTurn[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, { type: 'text', text: REMINDER }] }]
    engine(on, turns)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
    const fake = codex(on, 'busy')
    const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 }, view: { agentId: 'a1' } } })
    const running = step($, 0)
    for (let i = 0; i < 200 && fake.prompts.length < 1; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    await $.command.run({ command: 'codex-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 150 } })
    // The reply was made while Codex worked; the band is read once it is done.
    await $.session.send({ to: 'writer', text: 'Go on.', origin: { kind: 'model' } } as never)
    await running
    await band.redraw({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 }, view: { agentId: 'a1' } })
    expect(await band.find({ text: /no Codex turn yet/ })).toBeUndefined()
    expect(await band.find({ text: new RegExp(`session +${THREAD}`) })).toBeTruthy()
  })
})
