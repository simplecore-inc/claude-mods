import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnStepResult } from 'claude-code'

import { agentDefinitionNamed, agentDefinitionOf, agentLabel } from '../hooks/agentModels'
import { displayModel } from '../hooks/status'
import { fakeMachine } from './machine'

const PARENT = { fork: false, isBuiltIn: true, parentModel: 'claude-opus-5-5', parentEffort: 'high' }
const CHECKER = '---\nname: checker\nmodel: claude-sonnet-5-5\neffort: medium\n---\n'

describe('agentLabel', () => {
  test('general-purpose runs on the parent model and effort', () => {
    expect(agentLabel({ ...PARENT, type: 'general-purpose' })).toBe('Opus 5.5 (high)')
  })

  test('a fork runs on the parent model whatever model it names', () => {
    expect(agentLabel({ ...PARENT, type: 'fork', fork: true, model: 'haiku' })).toBe('Opus 5.5 (high)')
  })

  test('an agent file names the model and effort', () => {
    const definition = { name: 'checker', model: 'claude-sonnet-5-5', effort: 'medium' }
    expect(agentLabel({ ...PARENT, type: 'checker', isBuiltIn: false }, definition)).toBe('Sonnet 5.5 (medium)')
  })

  test('another model given to the tool does not take the parent effort', () => {
    expect(agentLabel({ ...PARENT, type: 'general-purpose', model: 'haiku' })).toBe('Haiku')
  })

  test('an agent file asking to inherit runs on the parent', () => {
    expect(agentLabel({ ...PARENT, type: 'x', isBuiltIn: false }, { name: 'x', model: 'inherit' })).toBe('Opus 5.5 (high)')
  })

  test('no label where the model cannot be known before the agent starts', () => {
    expect(agentLabel({ ...PARENT, type: 'Explore' })).toBeUndefined()
    expect(agentLabel({ ...PARENT, type: 'plain', isBuiltIn: false }, { name: 'plain' })).toBeUndefined()
    expect(agentLabel({ ...PARENT, type: 'missing', isBuiltIn: false })).toBeUndefined()
  })

  test('a plugin type labels itself', () => {
    expect(agentLabel({ ...PARENT, type: 'codex:read', model: 'haiku' })).toBeUndefined()
  })

  test('no effort when the parent request had none', () => {
    expect(agentLabel({ ...PARENT, type: 'general-purpose', parentEffort: undefined })).toBe('Opus 5.5')
  })
})

describe('agentDefinitionOf', () => {
  test('reads name, model and effort from the frontmatter', () => {
    const text = '---\nname: checker\ndescription: Reviews.\nmodel: "claude-sonnet-5-5"\neffort: medium\n---\n\nBody.\n'
    expect(agentDefinitionOf(text, 'checker.md')).toEqual({ name: 'checker', model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('the frontmatter name wins over the file name, which stands in for none', () => {
    expect(agentDefinitionOf('---\nname: renamed\n---\n', 'file.md')?.name).toBe('renamed')
    expect(agentDefinitionOf('---\nmodel: opus\n---\n', 'file.md')).toEqual({ name: 'file', model: 'opus', effort: undefined })
  })

  test('a comment after a value, quoted or not, is not part of it', () => {
    expect(agentDefinitionOf('---\nname: checker\nmodel: "haiku" # fast\neffort: low # cheap\n---\n', 'checker.md')).toEqual({ name: 'checker', model: 'haiku', effort: 'low' })
    expect(agentDefinitionOf("---\nmodel: 'claude-opus-5-5'\n---\n", 'x.md')?.model).toBe('claude-opus-5-5')
  })

  test('a file without frontmatter is no agent', () => {
    expect(agentDefinitionOf('# Notes\n', 'notes.md')).toBeUndefined()
  })
})

test('an alias reads as its name, a model id as Claude Code names it', () => {
  expect(displayModel('haiku')).toBe('Haiku')
  expect(displayModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayModel('some-other-model')).toBe('some-other-model')
})

describe('agentDefinitionNamed', () => {
  test('the project\'s agent folder first, then the person\'s; only the person\'s for a user agent', async () => {
    const machine = fakeMachine()
    machine.write('/repo/.claude/agents/checker.md', '---\nname: checker\nmodel: haiku\n---\n')
    machine.write('/home/me/.claude/agents/checker.md', CHECKER)
    machine.write('/home/me/.claude/agents/notes.md', '# Notes\n')
    expect((await agentDefinitionNamed(machine.io, '/repo', 'checker', 'projectSettings'))?.model).toBe('haiku')
    expect((await agentDefinitionNamed(machine.io, '/repo', 'checker', 'user'))?.model).toBe('claude-sonnet-5-5')
    expect(await agentDefinitionNamed(machine.io, '/repo', 'missing', 'projectSettings')).toBeUndefined()
  })

  test('CLAUDE_CONFIG_DIR holds the person\'s agents, and an empty one reads the home folder', async () => {
    const moved = fakeMachine({ env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    moved.write('/cfg/agents/checker.md', CHECKER)
    expect((await agentDefinitionNamed(moved.io, '/repo', 'checker', 'user'))?.effort).toBe('medium')
    const empty = fakeMachine({ env: { CLAUDE_CONFIG_DIR: '' } })
    empty.write('/home/me/.claude/agents/checker.md', CHECKER)
    expect((await agentDefinitionNamed(empty.io, '/repo', 'checker', 'user'))?.effort).toBe('medium')
  })
})

// The engine beneath the plugin: an agent folder holding checker.md, a main
// loop on Opus 5.5 at high effort, and spawns that record the description
// the agent list would show.
function engine(on: On, shown: string[]) {
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/home/me/.claude/agents' }))
  on('fs.list', (_$, e) => ({
    value: e.path === '/home/me/.claude/agents' ? [{ name: 'checker.md', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] : [],
  }))
  on('fs.read', (_$, e) => ({ value: e.path === '/home/me/.claude/agents/checker.md' ? CHECKER : '' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as unknown as TurnStepResult
  })
  on('agent.spawn', (_$, e: AgentSpawnInput) => {
    shown.push(e.description)
    return { model: e.model ?? e.parentModel, agentId: `a${shown.length}` }
  })
}

const SPAWN = { prompt: 'p', description: 'Review auth', fork: false, background: false, parentModel: 'claude-opus-5-5' }

test('the agent list shows a general-purpose agent on the parent model and effort, a user agent on its file, and Explore as it was', async ($, on) => {
  const shown: string[] = []
  engine(on, shown)
  const step = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of step);
  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } } as never)
  await $.agent.spawn({ ...SPAWN, subagentType: 'checker', provider: { plugin: 'user', tier: 'user' } } as never)
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(shown).toEqual(['Review auth · Opus 5.5 (high)', 'Review auth · Sonnet 5.5 (medium)', 'Review auth'])
})
