// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'
import type { AgentInfo, CommandDescribeInput, On } from 'claude-code'

import { HINT } from '../../hooks/codex/commands'
import { codexMachine, settle } from './fake'

const AGENTS: AgentInfo[] = [
  { id: 'c1', type: 'sc-accounts:codex-read', description: 'Review', status: 'completed' },
  { id: 'g1', type: 'general-purpose', description: 'Search', status: 'running' },
]
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 } }
const STATUS: CommandDescribeInput = { command: 'status', description: 'Show status', isHidden: false, immediate: false, provider: { plugin: 'engine', tier: 'core' } }
const CODEX_STATUS: CommandDescribeInput = { ...STATUS, command: 'codex-status', provider: { plugin: 'sc-accounts', tier: 'user' } }
const PRESENTATION = { isFullscreen: false, columns: 150 }

// What the engine beneath the plugin is handed: the footer's tail and each
// command's hidden flag.
function beneath(on: On): { tail: () => string | undefined } {
  let tail: string | undefined
  on('agent.list', () => ({ value: AGENTS }))
  on('ui.render', { component: 'PromptHint' }, (_$, e) => {
    tail = e.props.tail
    return { type: 'Text', props: {}, children: [e.props.hint] } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('command.describe', (_$, e) => ({ description: e.description, isHidden: e.isHidden }))
  return { tail: () => tail }
}

describe('a codex agent\'s view', () => {
  test('names the commands in the footer and hides the others from the menu while it is open, and only then', async ($, on) => {
    const seen = beneath(on)
    const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: {} } })
    const hint = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
    expect(seen.tail()).toBeUndefined()
    expect((await $.command.describe(STATUS)).isHidden).toBe(false)
    expect((await $.command.describe(CODEX_STATUS)).isHidden).toBe(true)

    // The band sees the switch; the footer follows the plugin's redraw.
    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    await hint.find({ type: 'Text' })
    expect(seen.tail()).toBe(HINT)
    expect((await $.command.describe(STATUS)).isHidden).toBe(true)
    expect((await $.command.describe(CODEX_STATUS)).isHidden).toBe(false)

    await band.redraw({ ...BAND, view: { agentId: 'g1' } })
    await hint.find({ type: 'Text' })
    expect(seen.tail()).toBeUndefined()
    expect((await $.command.describe(STATUS)).isHidden).toBe(false)
  })

  test('a /codex- command run there acts on that agent and answers above its prompt, not in the main transcript', async ($, on) => {
    beneath(on)
    on('command.run', () => ({ text: 'no hook answered' }))
    const band = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: {} } })
    const outside = await $.command.run({ command: 'codex-model', args: 'gpt-6-astra', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(outside.text).toContain("Open a codex agent's view")

    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    const inside = await $.command.run({ command: 'codex-model', args: 'gpt-6-astra', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(inside.text).toBeUndefined()
    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    expect(await band.find({ text: 'codex: model gpt-6-astra from the next Codex turn.' })).toBeTruthy()

    // A read-only agent keeps its sandbox; the setting above is kept.
    await $.command.run({ command: 'codex-sandbox', args: 'workspace-write', origin: { kind: 'composer' }, presentation: PRESENTATION })
    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    expect(await band.find({ text: /sandbox/ })).toBeTruthy()
    await $.command.run({ command: 'codex-status', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    expect(await band.find({ text: /model {5}gpt-6-astra from the next Codex turn/ })).toBeTruthy()

    // Leaving the view drops its reply.
    await band.redraw({ ...BAND, view: {} })
    await band.redraw({ ...BAND, view: { agentId: 'c1' } })
    expect(await band.find({ text: /gpt-6-astra/ })).toBeUndefined()
  })

  test('the session registers each /codex- command', async ($, on) => {
    codexMachine(on)
    on('agent.register', (_$, e) => ({ value: { agent: `sc-accounts:${e.name}` } }))
    const names: string[] = []
    on('command.register', (_$, e) => (names.push(e.name), { value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
    await settle(() => names.length === 6)
    expect(names.map(n => `/${n}`).join(' ')).toBe(HINT)
  })
})
