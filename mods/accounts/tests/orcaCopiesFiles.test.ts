import { expect, test } from 'claude-code/testing'

import type { AccountsContext } from '../hooks/accounts'
import { messagesFor } from '../hooks/i18n'
import type { OrcaClaude } from '../hooks/orca'
import { keepOrcaCopiesFresh } from '../hooks/orcaCopies'
import { fakeMachine, response } from './machine'

// Off macOS, Orca keeps each account's login in a file of the account's folder, and so does this mod.

const HOUR = 60 * 60 * 1000
const MINA = { accountUuid: 'u1', emailAddress: 'mina@example.com', organizationUuid: 'org-mina' }
const JUN = { accountUuid: 'u2', emailAddress: 'jun@example.org', organizationUuid: 'org-jun' }
const ORCA: OrcaClaude = {
  accounts: [
    { id: 'o-mina', email: MINA.emailAddress, organizationUuid: MINA.organizationUuid },
    { id: 'o-jun', email: JUN.emailAddress, organizationUuid: JUN.organizationUuid },
  ],
  activeId: 'o-mina',
}
const VAULT = '/home/me/.claude/account-switch/u2.json'
const ORCA_HOST = '/home/me/.config/orca/claude-accounts/o-jun/auth'
const ORCA_WSL = '/home/me/.local/share/orca/claude-accounts/o-jun/auth'

const login = (refresh: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `a-${refresh}`, refreshToken: refresh, expiresAt, scopes: ['user:inference'] } })

/** A Linux machine with Jun's login saved here and in the Orca folder given, its marker naming `marked`. */
function linux(folder: string, marked: string) {
  const machine = fakeMachine()
  const refreshes: string[] = []
  machine.setRunner(argv => (argv[0] === 'uname' ? ({ exitCode: 0, stdout: 'Linux\n', stderr: '' } as never) : undefined))
  machine.setFetch(async (_url, init) => {
    const used = (JSON.parse(String(init?.body ?? '{}')) as { refresh_token: string }).refresh_token
    refreshes.push(used)
    return response(200, { access_token: `a-${used}-2`, refresh_token: `${used}-2`, expires_in: 28_800 })
  })
  machine.write(VAULT, login('r-jun', machine.now() - HOUR))
  machine.write(`${folder}/.credentials.json`, login('r-jun', machine.now() - HOUR))
  machine.write(`${folder}/.orca-managed-claude-auth`, `${marked}\n`)
  machine.store['oauthAccount:u2'] = JUN
  const toasts: string[] = []
  const ctx = {
    io: machine.io,
    accounts: { get: async () => [{ uuid: 'u1', email: MINA.emailAddress, savedAt: 0 }, { uuid: 'u2', email: JUN.emailAddress, savedAt: 0 }], set: async () => undefined },
    live: { get: async () => 'u1', set: async () => undefined },
    toast: (text: string) => void toasts.push(text),
    messages: () => messagesFor('en'),
  } as unknown as AccountsContext
  const refreshOf = (path: string) => (JSON.parse(machine.files[path] ?? '{}') as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken

  return { ctx, refreshes, refreshOf, toasts }
}

test('off macOS, the copy in the folder Orca marks as the account\'s is refreshed with this mod\'s', async () => {
  const one = linux(ORCA_HOST, 'o-jun')
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes).toEqual(['r-jun'])
  expect(one.refreshOf(VAULT)).toBe('r-jun-2')
  expect(one.refreshOf(`${ORCA_HOST}/.credentials.json`)).toBe('r-jun-2')
})

test('inside WSL, the copy Orca keeps there for the account is refreshed too', async () => {
  const one = linux(ORCA_WSL, 'o-jun')
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshOf(`${ORCA_WSL}/.credentials.json`)).toBe('r-jun-2')
})

test('a folder whose marker names another account is not Orca\'s copy of this one, and nothing is refreshed', async () => {
  const one = linux(ORCA_HOST, 'o-someone-else')
  await keepOrcaCopiesFresh(one.ctx, ORCA)
  expect(one.refreshes).toEqual([])
  expect(one.refreshOf(`${ORCA_HOST}/.credentials.json`)).toBe('r-jun')
})
