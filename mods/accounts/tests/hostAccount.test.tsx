import { expect, test } from 'claude-code/testing'

import type { UsageView } from '../types'
import type { AccountsContext } from '../hooks/accounts'
import { messagesFor } from '../hooks/i18n'
import { adoptMeasured, adoptSessionFigures } from '../hooks/lookups'
import { fakeMachine } from './machine'
import { SURFACES, bandProps, mountPane, seedState } from './paneHarness'

const WINDOWS = [
  { kind: 'five_hour', percentUsed: 2, resetsAt: '2099-01-01T08:50:00Z' },
  { kind: 'seven_day', percentUsed: 89, resetsAt: '2099-01-04T14:00:00Z' },
]

/** An accounts context on a machine whose environment the test sets, its readings kept in memory. */
function world(env: Record<string, string>) {
  const machine = fakeMachine({ env })
  let usage: Record<string, UsageView> = {}
  const ctx = {
    io: machine.io,
    accounts: { get: async () => [], set: async () => undefined },
    live: { get: async () => 'u1', set: async () => undefined },
    usage: { get: async () => usage, update: async (change: (map: Record<string, UsageView>) => Record<string, UsageView>) => void (usage = change(usage)) },
    toast: () => undefined,
    messages: () => messagesFor('en'),
  } as unknown as AccountsContext

  return { ctx, usage: () => usage }
}

/** The environment of a session the app signs in with `uuid`. */
const hostEnv = (uuid: string, email: string) => ({ env: { CLAUDE_CODE_ACCOUNT_UUID: uuid, CLAUDE_CODE_USER_EMAIL: email } })

test('where the app signs the session in, a response\'s figures are filed under the app\'s account, never the live login', async () => {
  const app = world({ CLAUDE_CODE_ACCOUNT_UUID: 'u2', CLAUDE_CODE_USER_EMAIL: 'jun@example.org' })
  // No turn has begun since the live login changed: the host's account is filed all the same.
  await adoptMeasured(app.ctx, WINDOWS, 0)
  expect(app.usage().u1).toBeUndefined()
  expect(app.usage().u2?.limits).toEqual([
    { label: '5h', percent: 2, resetsAt: '2099-01-01T08:50:00Z' },
    { label: 'wk', percent: 89, resetsAt: '2099-01-04T14:00:00Z' },
  ])
  const again = world({ CLAUDE_CODE_ACCOUNT_UUID: 'u2' })
  await adoptSessionFigures(again.ctx, WINDOWS, 0)
  expect(again.usage().u1).toBeUndefined()
  expect(again.usage().u2?.limits.map(limit => limit.label)).toEqual(['5h', 'wk'])
  // Without a host the live login's figures wait for a turn begun after it changed, as before.
  const terminal = world({})
  await adoptSessionFigures(terminal.ctx, WINDOWS, 0)
  expect(terminal.usage()).toEqual({})
})

test('the band names the account the app runs the session with, saved or not', async ($, on) => {
  seedState(on, hostEnv('u2', 'jun@example.org'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface, component: 'AbovePrompt', props: bandProps(160) })
    expect((await ui.find({ key: 'band-account' }))?.text).toBe('jun@example.org')
    await ui.unmount()
  }
})

test('the band names an app account sc-accounts never saved by the email the app passes', async ($, on) => {
  seedState(on, hostEnv('u9', 'app@example.com'))
  const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'desktop', component: 'AbovePrompt', props: bandProps(160) })
  expect((await ui.find({ key: 'band-account' }))?.text).toBe('app@example.com')
  await ui.unmount()
})

test('the Accounts tab marks the app\'s account as this session\'s and says a switch changes the machine\'s login alone', async ($, on) => {
  seedState(on, hostEnv('u2', 'jun@example.org'))
  const ui = await mountPane($, 'desktop', 100)
  // The card in use is the session's, accented, with its badge and the note.
  expect((await ui.find({ key: 'row-u2' }))?.props).toMatchObject({ borderColor: 'cyan' })
  expect((await ui.find({ key: 'row-u1' }))?.props.borderColor).toBeUndefined()
  expect((await ui.find({ key: 'row-u2' }))?.text).toContain(' this session ')
  expect((await ui.find({ key: 'row-u2' }))?.text).toContain("not this session's")
  // The live login keeps its Active badge.
  expect((await ui.find({ key: 'row-u1' }))?.text).toContain(' active ')
  await ui.unmount()
})

test('with no app account, the live login is the account in use and no session badge shows', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal', 100)
  expect((await ui.find({ key: 'row-u1' }))?.props).toMatchObject({ borderColor: 'cyan' })
  expect((await ui.find({ key: 'row-u1' }))?.text).not.toContain('this session')
  await ui.unmount()
})
