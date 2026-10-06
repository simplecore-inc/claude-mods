import { expect, test } from 'claude-code/testing'
import type { SettingsSource } from 'claude-code'

import { beginSession, effortShown, followEffortPick, noteEffortCommand, noteRequestEffort } from '../hooks/sessionStatus'
import type { StatusContext } from '../hooks/sessionStatus'
import type { EffortSettings } from '../hooks/status'
import { fakeMachine } from './machine'

type Sources = Partial<Record<SettingsSource, EffortSettings>>

/** The user's settings with a level saved for a model, as `/effort` saves one. */
function saved(level: string, model = 'claude-opus-5-5'): EffortSettings {
  return { modelSettings: { [model]: { effortLevel: level } } }
}

/**
 * A session's status context over a machine in memory: the settings sources
 * every session on the machine shares, the model this session runs, and the
 * session's own state, which a /clear empties and a reload keeps.
 */
function session(sources: Sources, model = 'claude-opus-5-5') {
  const machine = fakeMachine()
  const shared = { sources }
  let held: { level: string | null } | null = null
  const ctx = {
    accounts: { io: machine.io },
    model: async () => model,
    settingsOf: async (source: SettingsSource) => shared.sources[source] ?? {},
    sessionEffort: { get: async () => held, set: async (value: { level: string | null } | null) => void (held = value) },
  } as unknown as StatusContext

  return { ctx, machine, shared, clearState: () => void (held = null) }
}

test('a session shows the effort it started with, not a level another session saves later', async () => {
  const one = session({ user: saved('xhigh') })
  await beginSession(one.ctx, 's1', false)
  // Another window runs `/effort low`, which saves the level for new sessions.
  one.shared.sources = { user: saved('low') }
  await followEffortPick(one.ctx)
  expect(await effortShown(one.ctx)).toBe('xhigh')
})

test('a session starts at the level its settings sources settle for its model', async () => {
  const sources = { user: { effortLevel: 'xhigh', ...saved('medium', 'claude-sonnet-5-5') }, local: undefined }
  const sonnet = session(sources, 'claude-sonnet-5-5')
  await beginSession(sonnet.ctx, 's1', false)
  expect(await effortShown(sonnet.ctx)).toBe('medium')
  const opus = session({ user: saved('xhigh'), local: { effortLevel: 'low' } })
  await beginSession(opus.ctx, 's2', false)
  expect(await effortShown(opus.ctx)).toBe('low')
})

test('this session\'s /effort shows at once; a request\'s effort, a subagent\'s left out by the caller, after it', async () => {
  const one = session({ user: saved('xhigh') })
  await beginSession(one.ctx, 's1', false)
  await noteEffortCommand(one.ctx, 'max', one.shared.sources.user ?? {})
  expect(await effortShown(one.ctx)).toBe('max')
  await noteRequestEffort(one.ctx, 'high')
  expect(await effortShown(one.ctx)).toBe('high')
  // A model that takes no effort is sent none: the band shows none.
  await noteRequestEffort(one.ctx, undefined)
  expect(await effortShown(one.ctx)).toBeNull()
})

test('a level picked from /effort\'s list is this session\'s, saved while the command runs or after it, within a minute', async () => {
  const one = session({ user: saved('xhigh') })
  await beginSession(one.ctx, 's1', false)
  // Saved while the command ran.
  one.shared.sources = { user: saved('medium') }
  await noteEffortCommand(one.ctx, '', saved('xhigh'))
  expect(await effortShown(one.ctx)).toBe('medium')
  // The list still open when the command returned: the save comes at a later status read.
  await noteEffortCommand(one.ctx, '', saved('medium'))
  await one.machine.advance(10_000)
  one.shared.sources = { user: saved('low') }
  await followEffortPick(one.ctx)
  expect(await effortShown(one.ctx)).toBe('low')
  // A pick kept to this session saves nothing: a level another window saves past the minute is not it.
  await noteEffortCommand(one.ctx, '', saved('low'))
  await one.machine.advance(61_000)
  one.shared.sources = { user: saved('high') }
  await followEffortPick(one.ctx)
  expect(await effortShown(one.ctx)).toBe('low')
  // A request ends the wait: its effort is the session's own.
  await noteEffortCommand(one.ctx, '', saved('high'))
  await noteRequestEffort(one.ctx, 'max')
  one.shared.sources = { user: saved('medium') }
  await followEffortPick(one.ctx)
  expect(await effortShown(one.ctx)).toBe('max')
})

test('a reload keeps the session\'s effort from its state, and a /clear from the module, never the shared level', async () => {
  const one = session({ user: saved('xhigh') })
  await beginSession(one.ctx, 's1', false)
  await noteEffortCommand(one.ctx, 'max', saved('xhigh'))
  one.shared.sources = { user: saved('low') }
  // A reload: session.start again, the state kept.
  await beginSession(one.ctx, 's1', false)
  expect(await effortShown(one.ctx)).toBe('max')
  // A /clear: a new session id in this process, its state empty.
  one.clearState()
  await beginSession(one.ctx, 's2', true)
  expect(await effortShown(one.ctx)).toBe('max')
  // A new session in another process starts from the settings as they are then.
  const two = session(one.shared.sources)
  await beginSession(two.ctx, 's3', false)
  expect(await effortShown(two.ctx)).toBe('low')
})
