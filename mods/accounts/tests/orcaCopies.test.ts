import { expect, test } from 'claude-code/testing'

import type { AccountsContext } from '../hooks/accounts'
import { messagesFor } from '../hooks/i18n'
import { ORCA_COPY_MARGIN_MS, keepOrcaCopiesFresh } from '../hooks/orcaCopies'
import type { OrcaClaude } from '../hooks/orca'
import { fakeMachine, response } from './machine'

const HOUR = 60 * 60 * 1000
const ORCA_ITEM = 'Orca Claude Code Managed Credentials'
const MINA = { accountUuid: 'u1', emailAddress: 'mina@example.com', organizationUuid: 'org-mina' }
const JUN = { accountUuid: 'u2', emailAddress: 'jun@example.org', organizationUuid: 'org-jun' }
const ORCA: OrcaClaude = {
  accounts: [
    { id: 'o-mina', email: MINA.emailAddress, organizationUuid: MINA.organizationUuid },
    { id: 'o-jun', email: JUN.emailAddress, organizationUuid: JUN.organizationUuid },
  ],
  activeId: 'o-mina',
}

const login = (token: string, refresh: string, expiresAt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt, scopes: ['user:inference'], ...extra } })

/**
 * Two saved accounts, Mina live and selected in Orca, Jun kept by Orca too:
 * the keychain as `security` answers it, and the token endpoint answering
 * with `refreshed`, or with the status a test sets.
 */
function world(copies: (now: number) => { saved: string; orca: string | null }, refusal?: number) {
  const machine = fakeMachine()
  const { saved: junSaved, orca: junOrca } = copies(machine.now())
  const keychain: Record<string, string> = { 'account-switch|u1': login('a-mina', 'r-mina', machine.now() + 8 * HOUR), 'account-switch|u2': junSaved }
  if (junOrca !== null) keychain[`${ORCA_ITEM}|o-jun`] = junOrca
  const refreshes: string[] = []
  const toasts: string[] = []
  machine.setRunner((argv, init) => {
    const answer = (exitCode: number, stdout = '') => ({ exitCode, stdout, stderr: '' }) as never
    if (argv[0] === 'security' && argv[1] === 'find-generic-password') {
      const key = `${argv[argv.indexOf('-s') + 1]}|${argv[argv.indexOf('-a') + 1]}`
      return key in keychain ? answer(0, keychain[key]) : answer(44)
    }
    if (argv[0] === 'security' && argv[1] === '-i') {
      const line = /-a "([^"]*)" -s "([^"]*)" -X "([0-9a-f]+)"/.exec(init?.stdin ?? '')
      if (line?.[3]) keychain[`${line[2]}|${line[1]}`] = new TextDecoder().decode(new Uint8Array((line[3].match(/../g) ?? []).map(pair => parseInt(pair, 16))))
      return answer(0)
    }
    return undefined
  })
  machine.setFetch(async (url, init) => {
    if (!url.endsWith('/v1/oauth/token')) throw new Error(`unexpected request: ${url}`)
    refreshes.push(String(init?.body ?? ''))
    if (refusal) return response(refusal, { error: 'invalid_grant' })
    return response(200, { access_token: 'a-jun-2', refresh_token: 'r-jun-2', expires_in: 28_800 })
  })
  machine.store['oauthAccount:u1'] = MINA
  machine.store['oauthAccount:u2'] = JUN
  const accounts = [
    { uuid: 'u1', email: MINA.emailAddress, savedAt: 0 },
    { uuid: 'u2', email: JUN.emailAddress, savedAt: 0 },
  ]
  const ctx = {
    io: machine.io,
    accounts: { get: async () => accounts, set: async () => undefined },
    live: { get: async () => 'u1', set: async () => undefined },
    toast: (text: string) => void toasts.push(text),
    messages: () => messagesFor('en'),
  } as unknown as AccountsContext
  const oauth = (key: string) => (JSON.parse(keychain[key] ?? '{}') as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth

  return { machine, ctx, keychain, refreshes, toasts, oauth }
}

test('a copy Orca keeps that expires within the hour is refreshed, and the new grant written to Orca\'s copy and this mod\'s', async () => {
  const one = world(now => ({ saved: login('a-jun', 'r-jun', now + ORCA_COPY_MARGIN_MS / 2), orca: login('a-jun', 'r-jun', now + ORCA_COPY_MARGIN_MS / 2, { subscriptionType: 'max' }) }))
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes.length).toBe(1)
  expect(one.oauth('account-switch|u2')).toMatchObject({ accessToken: 'a-jun-2', refreshToken: 'r-jun-2' })
  // Orca's copy keeps what else it holds.
  expect(one.oauth(`${ORCA_ITEM}|o-jun`)).toMatchObject({ accessToken: 'a-jun-2', refreshToken: 'r-jun-2', subscriptionType: 'max' })
  // Fresh now: the next check refreshes nothing.
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes.length).toBe(1)
})

test('the live login and the one Orca has selected are never refreshed here, nor a copy not yet near expiry', async () => {
  // Mina is live here while Orca has Jun selected: both expire within the minute.
  const one = world(now => ({ saved: login('a-jun', 'r-jun', now + 60_000), orca: login('a-jun', 'r-jun', now + 60_000) }))
  const now = one.machine.now()
  one.keychain[`${ORCA_ITEM}|o-mina`] = login('a-mina', 'r-mina', now + 60_000)
  one.keychain['account-switch|u1'] = login('a-mina', 'r-mina', now + 60_000)
  await keepOrcaCopiesFresh(one.ctx, { ...ORCA, activeId: 'o-jun' })
  expect(one.refreshes).toEqual([])
  // Neither selected nor live, Jun's copy three hours from expiry is fresh enough.
  const later = world(at => ({ saved: login('a-jun', 'r-jun', at + 3 * HOUR), orca: login('a-jun', 'r-jun', at + 3 * HOUR) }))
  await keepOrcaCopiesFresh(later.ctx, ORCA)
  expect(later.refreshes).toEqual([])
})

test('a copy Orca holds of another grant is left alone, and so is this mod\'s', async () => {
  const one = world(now => ({ saved: login('a-jun', 'r-jun', now + 60_000), orca: login('a-jun-orca', 'r-jun-orca', now + 60_000) }))
  const ours = one.keychain['account-switch|u2']
  const orcas = one.keychain[`${ORCA_ITEM}|o-jun`]
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes).toEqual([])
  expect(one.keychain[`${ORCA_ITEM}|o-jun`]).toBe(orcas)
  expect(one.keychain['account-switch|u2']).toBe(ours)
})

test('a copy the server refuses is said once and not asked about again until it changes', async () => {
  const one = world(now => ({ saved: login('a-jun', 'r-jun', now - HOUR), orca: login('a-jun', 'r-jun', now - HOUR) }), 400)
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes.length).toBe(1)
  expect(one.toasts).toEqual([messagesFor('en').orcaCopyRefused(JUN.emailAddress)])
})

test('a refresh the server could not answer is tried again at the next check', async () => {
  const one = world(now => ({ saved: login('a-jun', 'r-jun', now - HOUR), orca: login('a-jun', 'r-jun', now - HOUR) }), 503)
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes.length).toBe(2)
  expect(one.toasts).toEqual([])
})
