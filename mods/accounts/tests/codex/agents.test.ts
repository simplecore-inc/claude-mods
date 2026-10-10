// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, mock, test } from 'claude-code/testing'

import { specsOf } from '../../hooks/codex/agents'
import { codexMachine, settle } from './fake'

// Codex's files where the mod looks for them, from the environment.
const FILES: Record<string, string> = {
  '/home/me/.codex/config.toml': 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n',
  '/home/me/.codex/models_cache.json': '{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-astra"}]}',
}

describe('agent types', () => {
  test('the session registers the three types, offering the models Codex knows', async ($, on) => {
    codexMachine(on, FILES)
    const registered: { name: string; description: string }[] = []
    on('agent.register', (_$, e) => {
      registered.push(e)
      return { value: { agent: `sc-accounts:${e.name}` } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
    await settle(() => registered.length === 3)
    expect(registered.map(r => r.name)).toEqual(['codex-read', 'codex-write', 'codex-run'])
    for (const r of registered) expect(r.description).toContain('models: gpt-6.1-sol, gpt-6-astra')
  })

  for (const [where, setup] of [['without a codex on the PATH', { isInstalled: false }], ['on Windows', { os: 'Windows_NT' }]] as const) {
    test(`${where} the session offers no codex agent and no /codex- command`, async ($, on) => {
      codexMachine(on, FILES, setup)
      const registered: string[] = []
      on('agent.register', (_$, e) => {
        registered.push(e.name)
        return { value: { agent: `sc-accounts:${e.name}` } }
      })
      on('command.register', (_$, e) => {
        registered.push(e.name)
        return { value: undefined as never }
      })
      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
      await settle()
      expect(registered).toEqual([])
    })
  }

  test('with no Codex model cache (a fresh install) the descriptions name no models and still read whole', () => {
    for (const { description } of specsOf([])) {
      expect(description).not.toContain('models:')
      expect(description).toContain('(`model: <id>`, `effort: <level>`); left out, Codex uses its own config.')
    }
  })

  test('a spawned agent is labelled with the model and effort it will run on', async ($, on) => {
    codexMachine(on, FILES)
    let description = ''
    on('agent.spawn', (_$, e) => {
      description = e.description
      return { model: 'haiku' }
    })
    await $.agent.spawn({ subagentType: 'sc-accounts:codex-read', prompt: 'model: gpt-6-astra\nReview app.js', description: 'Review' } as never)
    expect(description).toBe('Review · Astra 6 (xhigh)')
  })

  test('a Codex config that cannot be read leaves the row unlabelled; the agent starts and its options are kept', async ($, on) => {
    mock.env(on, { HOME: '/home/me' })
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => {
      throw new Error('EACCES: permission denied')
    })
    const spawned: string[] = []
    on('agent.spawn', (_$, e) => {
      spawned.push(e.description)
      return { model: 'haiku', agentId: 'c1' }
    })
    const kept: unknown[] = []
    on('state.get', () => ({ value: { value: undefined, version: 1 } as never }))
    on('state.set', (_$, e) => {
      if (e.key === 'codexOpenings') kept.push(e.value)
      return { value: { isSet: true, version: 2 } as never }
    })
    await $.agent.spawn({ subagentType: 'sc-accounts:codex-read', prompt: 'model: gpt-6-astra\nReview app.js', description: 'Review' } as never)
    expect(spawned).toEqual(['Review'])
    // The spawn prompt carries the agent's options, so it is kept for every later step.
    expect(kept).toEqual([{ c1: 'model: gpt-6-astra\nReview app.js' }])
  })

  // A run the mod does not answer goes to the agent's model, so it must stay
  // the stand-in's Claude model whatever Codex model the prompt or config names.
  test('a spawned agent keeps the stand-in\'s Claude model, never the Codex one', async ($, on) => {
    codexMachine(on, FILES)
    const models: (string | undefined)[] = []
    on('agent.spawn', (_$, e) => (models.push(e.model), { model: e.model ?? 'haiku' }))
    await $.agent.spawn({ subagentType: 'sc-accounts:codex-read', prompt: 'model: gpt-6-astra\nReview app.js', description: 'Review' } as never)
    await $.agent.spawn({ subagentType: 'sc-accounts:codex-read', prompt: 'Review app.js', description: 'Review' } as never)
    expect(models).toEqual([undefined, undefined])
  })

  // The agent list summarises a running agent from its definition's prompt,
  // which only a stand-in model would read: it must read as what the agent
  // does, and still make a stand-in report that Codex did not run.
  test('the stand-in prompt reads as relaying to Codex, and a stand-in reports that Codex did not run', () => {
    for (const { prompt } of specsOf([])) {
      const opening = prompt.split(/(?<=[.:])\s/)[0]!
      expect(opening).toMatch(/Codex/)
      expect(opening).not.toMatch(/fail|did not|error|stand/i)
      expect(prompt).not.toMatch(/failed to start/)
      expect(prompt).toMatch(/report[^.]*Codex did not run/i)
    }
  })
})
