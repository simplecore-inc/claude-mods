// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, CommandDescribeInput } from 'claude-code'

import { agentLabel } from '../../hooks/agentModels'
import { HINT } from '../../hooks/codex/commands'
import { commandOf } from '../../hooks/codex/events'
import { flagsOf } from '../../hooks/codex/flags'
import { openView, setOpenView } from '../../hooks/codex/view'
import { codexMachine } from './fake'

// How the codex agents sit beside the accounts and other plugins: views per
// surface, commands named exactly, a /clear, and the agent list asked once.

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 } }

describe('the codex view, surface by surface', () => {
  test('a terminal and a desktop showing different views each keep their own, so neither redraws the other', () => {
    expect(setOpenView('terminal', 'c1')).toBe(true)
    expect(setOpenView('desktop', undefined)).toBe(false)
    // Drawn again in turn, nothing changes and nothing asks for another draw.
    expect(setOpenView('terminal', 'c1')).toBe(false)
    expect(setOpenView('desktop', undefined)).toBe(false)
    expect(openView()).toBe('c1')
    expect(setOpenView('terminal', undefined)).toBe(true)
    expect(openView()).toBeUndefined()
  })
})

describe('commands', () => {
  test('a command of another plugin that only starts with codex- runs as its own, and shows in the menu', async ($, on) => {
    on('command.run', () => ({ text: 'ran codex-review' }))
    on('command.describe', (_$, e) => ({ description: e.description, isHidden: e.isHidden }))
    const ran = (await $.command.run({ command: 'codex-review', args: '' } as never)) as { text?: string }
    expect(ran.text).toBe('ran codex-review')
    const other: CommandDescribeInput = { command: 'codex-review', description: 'Review', isHidden: false, immediate: false, provider: { plugin: 'other', tier: 'user' } }
    expect((await $.command.describe(other)).isHidden).toBe(false)
  })

  test('in a codex agent\'s view the footer keeps a hint another plugin put there and adds the codex commands', async ($, on) => {
    const agents: AgentInfo[] = [{ id: 'c9', type: 'sc-accounts:codex-read', description: 'Review', status: 'running' }]
    on('agent.list', () => ({ value: agents }))
    let tail: string | undefined
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
    on('ui.render', { component: 'PromptHint' }, (_$, e) => {
      tail = e.props.tail
      return { type: 'Text', props: {}, children: [e.props.hint] } as never
    })
    await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'c9' } } as never })
    const hint = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts', tail: 'other plugin' } as never })
    await hint.find({ type: 'Text' })
    expect(tail).toBe(`other plugin · ${HINT}`)
    await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: {} } as never })
  })
})

test('the band asks the engine for an agent\'s type once, however often it draws that agent\'s view', async ($, on) => {
  let asked = 0
  on('agent.list', () => {
    asked += 1
    return { value: [{ id: 'g7', type: 'general-purpose', description: 'Search', status: 'running' }] as AgentInfo[] }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'g7' } } as never })
  await band.redraw({ ...BAND, view: { agentId: 'g7' } } as never)
  await band.redraw({ ...BAND, view: { agentId: 'g7' } } as never)
  expect(asked).toBe(1)
})

test('after /clear empties the session\'s state, the Codex card and the codex agents are offered again', async ($, on) => {
  codexMachine(on)
  const store: Record<string, unknown> = { codexAccount: null }
  on('state.get', (_$, e) => ({ value: { value: store[e.key], version: 1 } as never }))
  on('state.set', (_$, e) => {
    store[e.key] = e.value
    return { value: { isSet: true, version: 2 } as never }
  })
  const registered: string[] = []
  on('agent.register', (_$, e) => {
    registered.push(e.name)
    return { value: { agent: `sc-accounts:${e.name}` } }
  })
  on('session.end', () => ({ sessionId: 'old' }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.end({ reason: 'clear' } as never)
  await clock.advance(300)
  await clock.settle()
  expect(store.codexAccount).toEqual({ lookedAt: 0 })
  expect(registered).toEqual(['codex-read', 'codex-write', 'codex-run'])
})

test('an alias of the parent\'s family is the parent\'s model, with its effort', () => {
  const parent = { fork: false, isBuiltIn: true, parentModel: 'claude-opus-5-5', parentEffort: 'high' }
  expect(agentLabel({ ...parent, type: 'general-purpose', model: 'opus' })).toBe('Opus 5.5 (high)')
  expect(agentLabel({ ...parent, type: 'general-purpose', model: 'sonnet' })).toBe('Sonnet')
})

test('an approval policy Codex no longer takes is refused with the ones it does', () => {
  const refused = flagsOf('ask-for-approval: untrusted\nRun it.')
  expect(refused).toEqual({ error: 'approval_policy is one of on-request, never' })
  expect('error' in flagsOf('ask-for-approval: on-request\nRun it.')).toBe(false)
})

test('a command Codex asks to run reads as the shell will run it, its quoting undone', () => {
  expect(commandOf(`/bin/zsh -lc "printf 'approved line\\\\n' >> hello.txt"`)).toBe(`printf 'approved line\\n' >> hello.txt`)
  expect(commandOf(`/bin/zsh -lc "echo \\"hi\\" \\$HOME"`)).toBe('echo "hi" $HOME')
  expect(commandOf(`/bin/zsh -lc 'echo '\\''quoted'\\'' \\n'`)).toBe(`echo 'quoted' \\n`)
  expect(commandOf(`/bin/zsh -lc "ls \\\nsrc"`)).toBe('ls src')
  expect(commandOf('git status')).toBe('git status')
})
