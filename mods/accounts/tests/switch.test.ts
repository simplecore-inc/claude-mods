import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseChanges } from '../hooks/switchlog'

const HOME = '/home/me'
const CONFIG = `${HOME}/.claude.json`
const CREDENTIALS = `${HOME}/.claude/.credentials.json`
const CHANGES = `${HOME}/.claude/sc-accounts/login-changes.jsonl`
const ORCA_DIR = `${HOME}/Library/Application Support/orca`
const LIVE_ITEM = 'Claude Code-credentials|me'
const HOUR = 60 * 60 * 1000
const NOW = 1_000 * HOUR
const SETTLE_MS = 10_000

const MINA = { accountUuid: 'u1', emailAddress: 'mina@example.com', organizationUuid: 'org-mina' }
const JUN = { accountUuid: 'u2', emailAddress: 'jun@example.org', organizationUuid: 'org-jun' }
const ORCA_MINA = { id: 'o-mina', email: MINA.emailAddress, organizationUuid: MINA.organizationUuid, managedAuthRuntime: 'host' }
const ORCA_JUN = { id: 'o-jun', email: JUN.emailAddress, organizationUuid: JUN.organizationUuid, managedAuthRuntime: 'host' }

const login = (token: string, expiresAt = NOW + 8 * HOUR) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } })

type OrcaState = 'absent' | 'down' | { accounts: readonly (typeof ORCA_MINA)[]; activeId: string | null }

/**
 * The machine beneath the plugin: Claude Code's config and credentials file,
 * the keychain, the plugin's store and state, the profile and usage
 * endpoints, and Orca, absent, closed or answering on its socket.
 */
function machine(on: On, start: OrcaState) {
  let orca: OrcaState = start
  const accounts = [
    { uuid: 'u1', email: MINA.emailAddress, savedAt: 0 },
    { uuid: 'u2', email: JUN.emailAddress, savedAt: 0 },
  ]
  const state: Record<string, unknown> = { accounts, live: 'u1', usage: {}, dialog: null, isRefreshing: false }
  const store: Record<string, unknown> = { accounts, 'oauthAccount:u1': MINA, 'oauthAccount:u2': JUN }
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ oauthAccount: MINA, numStartups: 3 }), [CREDENTIALS]: login('a-mina') }
  const keychain: Record<string, string> = { [LIVE_ITEM]: login('a-mina'), 'account-switch|u1': login('a-mina'), 'account-switch|u2': login('a-jun') }
  const orcaCalls: { method: string; params?: unknown }[] = []
  const toasts: string[] = []
  const refreshes: string[] = []
  /** Lock directories made and not yet removed, and every one ever made. */
  const locks = new Set<string>()
  const locksTaken: string[] = []
  /** Each path's modification time, moved on by every write. */
  const mtimes: Record<string, number> = {}
  /** Files whose writing fails, as on a full disk. */
  const failingWrites = new Set<string>()
  let writes = 0
  const wrote = (path: string, text: string) => {
    files[path] = text
    writes += 1
    mtimes[path] = writes
  }
  const placeOrca = (next: OrcaState) => {
    orca = next
    if (next === 'absent') delete files[`${ORCA_DIR}/profiles`]
    else files[`${ORCA_DIR}/profiles`] = ''
    if (next === 'absent') delete files[`${ORCA_DIR}/orca-runtime.json`]
    else files[`${ORCA_DIR}/orca-runtime.json`] = JSON.stringify({ transports: [{ kind: 'unix', endpoint: '/run/orca.sock' }], authToken: 'orca-token' })
  }
  placeOrca(start)

  on('state.get', ($, e) => ({ value: { value: state[e.key], version: 1 } as never }))
  on('state.set', ($, e) => {
    state[e.key] = e.value
    return { value: { isSet: true, version: 2 } as never }
  })
  on('store.get', ($, e) => ({ value: store[e.key] as never }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined as never }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined as never }
  })
  on('store.keys', () => ({ value: Object.keys(store) as never }))
  mock.env(on, { HOME, USER: 'me' })
  on('fs.exists', ($, e) => ({ value: (e.path in files || locks.has(e.path) || Object.keys(files).some(path => path.startsWith(`${e.path}/`))) as never }))
  on('fs.read', ($, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[e.path] as never }
  })
  on('fs.write', ($, e) => {
    wrote(e.path, e.text)
    return { value: undefined as never }
  })
  on('fs.stat', ($, e) => {
    if (!(e.path in files) && !locks.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: locks.has(e.path) ? 'dir' : 'file', size: (files[e.path] ?? '').length, mtimeMs: mtimes[e.path] ?? 0 } as never }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const stdin = e.init?.stdin ?? ''
    const answer = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr } as never })
    if (argv[0] === 'uname') return answer(0, 'Darwin\n')
    if (argv[0] === 'security' && argv[1] === 'find-generic-password') {
      // `security` answers the item of that account, or without -a the first item of the service.
      const service = argv[argv.indexOf('-s') + 1]
      const key = argv.includes('-a') ? `${service}|${argv[argv.indexOf('-a') + 1]}` : Object.keys(keychain).find(one => one.startsWith(`${service}|`))
      return key !== undefined && key in keychain ? answer(0, keychain[key]) : answer(44, '', 'The specified item could not be found in the keychain.')
    }
    if (argv[0] === 'security' && argv[1] === '-i') {
      const line = /-a "([^"]*)" -s "([^"]*)" -X "([0-9a-f]+)"/.exec(stdin)
      if (line?.[3]) keychain[`${line[2]}|${line[1]}`] = new TextDecoder().decode(new Uint8Array((line[3].match(/../g) ?? []).map(pair => parseInt(pair, 16))))
      return answer(0)
    }
    // A file replaced whole: written beside it, then renamed over it.
    if (argv[0] === '/bin/sh' && argv[2]?.includes('mktemp') && argv[3]) {
      if (failingWrites.has(argv[3])) return answer(1, '', 'No space left on device')
      wrote(argv[3], stdin)
      return answer(0)
    }
    // A lock taken: its directory made, which fails while it is there.
    if (argv[0] === '/bin/sh' && argv[2]?.includes('mkdir "$0"') && argv[3]) {
      if (locks.has(argv[3])) return answer(1, '', 'File exists')
      locks.add(argv[3])
      locksTaken.push(argv[3])
      writes += 1
      mtimes[argv[3]] = writes
      return answer(0)
    }
    if (argv[0] === '/bin/sh' && argv[2]?.includes('rmdir "$0"') && argv[3]) {
      locks.delete(argv[3])
      return answer(0)
    }
    if (argv[0] === 'perl') {
      if (typeof orca !== 'object') return answer(2, '', 'Connection refused')
      const request = JSON.parse(stdin) as { id: string; authToken: string; method: string; params?: { accountId?: string } }
      orcaCalls.push(request.params === undefined ? { method: request.method } : { method: request.method, params: request.params })
      if (request.authToken !== 'orca-token') return answer(0, `${JSON.stringify({ id: request.id, ok: false, error: { message: 'bad token' } })}\n`)
      if (request.method === 'accounts.list') {
        const result = { claude: { accounts: orca.accounts, activeAccountId: orca.activeId, activeAccountIdsByRuntime: { host: orca.activeId, wsl: {} } } }
        return answer(0, `{"_keepalive":true}\n${JSON.stringify({ id: request.id, ok: true, result })}\n`)
      }
      if (request.method === 'accounts.selectClaude') {
        orca.activeId = request.params?.accountId ?? null
        return answer(0, `${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`)
      }
    }
    return answer(0)
  })
  on('http.fetch', ($, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    const token = (headers.Authorization ?? '').replace('Bearer ', '')
    if (e.url.endsWith('/api/oauth/profile')) {
      const owner = token.includes('jun') ? JUN : MINA
      const text = JSON.stringify({ account: { uuid: owner.accountUuid, email: owner.emailAddress }, organization: { uuid: owner.organizationUuid } })
      return { value: { ok: true, status: 200, headers: {}, text } as never }
    }
    if (e.url.endsWith('/api/oauth/usage')) return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 10, resets_at: null } }) } as never }
    if (e.url.endsWith('/v1/oauth/token')) {
      refreshes.push(String(e.init?.body ?? ''))
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ access_token: 'a-jun-refreshed', refresh_token: 'r-jun-refreshed', expires_in: 28_800 }) } as never }
    }
    return { value: { ok: false, status: 404, headers: {}, text: '' } as never }
  })
  on('session.cwd', () => ({ value: '/work' as never }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined as never }
  })
  on('ui.log', () => ({ value: undefined as never }))
  const clock = mock.clock(on, { now: NOW })

  return {
    files,
    keychain,
    store,
    state,
    orcaCalls,
    toasts,
    refreshes,
    locks,
    locksTaken,
    failingWrites,
    clock,
    placeOrca,
    orca: () => orca,
    /** Writes a login into Claude Code as Orca or an outside `/login` does: the keychain, the credentials file and the config. */
    writeLogin(account: typeof MINA, token: string, expiresAt?: number) {
      keychain[LIVE_ITEM] = login(token, expiresAt)
      wrote(CREDENTIALS, login(token, expiresAt))
      wrote(CONFIG, JSON.stringify({ oauthAccount: account, numStartups: 3 }))
    },
    liveToken: () => (JSON.parse(keychain[LIVE_ITEM] ?? '{}') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken,
    changes: () => parseChanges(files[CHANGES] ?? ''),
  }
}

const run = async ($: Engine, args: string) => ((await $.command.run({ command: 'sc:accounts', args } as never)) as { text?: string }).text ?? ''

/** Lets a change of the login stand for the settling time, and the work it starts finish. */
async function settle(world: ReturnType<typeof machine>) {
  await world.clock.advance(SETTLE_MS)
  await world.clock.settle()
}

test('with no Orca on the machine, a switch writes the login here and never asks Orca', async ($, on) => {
  const world = machine(on, 'absent')
  expect(await run($, 'use 2')).toBe('Switched to jun@example.org. Running sessions use it from their next request.')
  expect(world.liveToken()).toBe('a-jun')
  expect((JSON.parse(world.files[CONFIG] ?? '{}') as { oauthAccount: typeof JUN }).oauthAccount.emailAddress).toBe('jun@example.org')
  expect(world.orcaCalls).toEqual([])
  expect(world.changes().at(-1)).toMatchObject({ kind: 'switch', orca: 'direct', to: 'jun@example.org' })
})

test('with Orca running and writing another login, a switch selects the account in Orca too, so Orca keeps it', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  expect(await run($, 'use 2')).toBe('Switched to jun@example.org, in Orca too. Running sessions use it from their next request.')
  expect(world.orcaCalls).toEqual([{ method: 'accounts.list' }, { method: 'accounts.selectClaude', params: { accountId: 'o-jun' } }])
  // Written here as well, so Orca takes the fresher of its copy and this one.
  expect(world.liveToken()).toBe('a-jun')
  expect(world.changes().at(-1)).toMatchObject({ kind: 'switch', orca: 'select', to: 'jun@example.org' })
})

test('with Orca running and holding no login for the account, a switch is refused before anything changes', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA], activeId: 'o-mina' })
  expect(await run($, 'use 2')).toBe(
    'account-switch: Orca writes mina@example.com\'s login into Claude Code and holds none for jun@example.org, so a switch would be put back to mina@example.com. Add jun@example.org in Orca (Manage accounts, or orca account add), then switch again.',
  )
  expect(world.liveToken()).toBe('a-mina')
  expect(world.orcaCalls).toEqual([{ method: 'accounts.list' }])
  expect(world.changes()).toEqual([])
})

test('with Orca running but leaving the login alone, a switch is made here only', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: null })
  expect(await run($, 'use 2')).toBe('Switched to jun@example.org. Running sessions use it from their next request.')
  expect(world.orcaCalls).toEqual([{ method: 'accounts.list' }])
  expect(world.liveToken()).toBe('a-jun')
})

test('with Orca closed, a switch is made here, and once Orca starts and puts its own login back, the account is selected there', async ($, on) => {
  const world = machine(on, 'down')
  // What Orca said when it last answered: it keeps both logins and writes Mina's.
  world.store.orca = { claude: { accounts: [ORCA_MINA, ORCA_JUN].map(({ id, email, organizationUuid }) => ({ id, email, organizationUuid })), activeId: 'o-mina' }, seenAt: NOW - HOUR, checkedAt: NOW - HOUR }
  expect(await run($, 'use 2')).toBe('Switched to jun@example.org. Orca is not running; once it runs, jun@example.org is selected in Orca too, so Orca does not put its own login back.')
  expect(world.liveToken()).toBe('a-jun')
  expect(world.store.orcaPending).toMatchObject({ accountId: 'o-jun', activeBefore: 'o-mina' })
  // Orca starts and writes the login it wrote before.
  world.placeOrca({ accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  world.writeLogin(MINA, 'a-mina')
  await run($, 'refresh')
  await settle(world)
  expect(world.orcaCalls.filter(call => call.method === 'accounts.selectClaude')).toEqual([{ method: 'accounts.selectClaude', params: { accountId: 'o-jun' } }])
  expect(world.store.orcaPending).toBeUndefined()
  expect(world.changes().at(-1)).toMatchObject({ kind: 'follow', to: 'jun@example.org' })
  expect(world.toasts).toContain('jun@example.org, chosen while Orca was not running, is now selected in Orca too.')
})

test('a switch made in Orca is said as Orca\'s, and nothing is selected back', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  // This session's own switch sets where the login stands.
  await run($, 'use 1')
  world.orcaCalls.length = 0
  // In Orca, Jun is picked: Orca writes Jun's login.
  ;(world.orca() as { activeId: string | null }).activeId = 'o-jun'
  world.writeLogin(JUN, 'a-jun')
  await run($, 'refresh')
  await settle(world)
  expect(world.changes().at(-1)).toMatchObject({ kind: 'orca', from: 'mina@example.com', to: 'jun@example.org' })
  expect(world.toasts).toContain('Orca switched the login from mina@example.com to jun@example.org.')
  expect(world.orcaCalls.filter(call => call.method === 'accounts.selectClaude')).toEqual([])
})

test('a login changed outside to an account Orca keeps is selected in Orca, so Orca does not put its own back', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  await run($, 'use 1')
  world.orcaCalls.length = 0
  // A /login in another terminal, with no switch of this mod's and none of Orca's.
  world.writeLogin(JUN, 'a-jun-new')
  await run($, 'refresh')
  await settle(world)
  expect(world.orcaCalls.filter(call => call.method === 'accounts.selectClaude')).toEqual([{ method: 'accounts.selectClaude', params: { accountId: 'o-jun' } }])
  expect(world.changes().at(-1)).toMatchObject({ kind: 'follow', to: 'jun@example.org' })
})

test('a write that passes through another login and back is said to nobody', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  await run($, 'use 1')
  const recorded = world.changes().length
  world.orcaCalls.length = 0
  world.writeLogin(JUN, 'a-jun')
  await run($, 'refresh')
  // Orca puts its own login back within the settling time, as its writes do.
  world.writeLogin(MINA, 'a-mina')
  await run($, 'refresh')
  await settle(world)
  expect(world.changes().length).toBe(recorded)
  expect(world.toasts.filter(text => /login/i.test(text) && !text.startsWith('Switched'))).toEqual([])
  expect(world.orcaCalls.filter(call => call.method === 'accounts.selectClaude')).toEqual([])
})

for (const [where, orcaState, isRefreshed] of [
  ['with Orca keeping the login', { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' }, false],
  ['with no Orca', 'absent', true],
] as const) {
  test(`an inactive account whose token is near expiry is ${isRefreshed ? '' : 'not '}refreshed here ${where}`, async ($, on) => {
    const world = machine(on, orcaState)
    // Jun's saved token expires within the refresh margin.
    world.keychain['account-switch|u2'] = login('a-jun', NOW + 60_000)
    // Orca answers first, as at a session's start, so the lookup knows which logins it keeps.
    if (typeof orcaState === 'object') await run($, 'use 1')
    await run($, 'refresh')
    expect(world.refreshes.length > 0).toBe(isRefreshed)
    const reading = (world.state.usage as Record<string, { isHeld?: boolean; error?: string }>).u2
    expect(reading?.isHeld === true).toBe(!isRefreshed)
    expect(reading?.error).toBeUndefined()
  })
}

test('a switch takes Claude Code\'s own locks over its login and its config, and leaves none behind', async ($, on) => {
  const world = machine(on, 'absent')
  await run($, 'use 2')
  expect(world.locksTaken).toContain('/home/me/.claude/.storage-write.lock')
  expect(world.locksTaken).toContain('/home/me/.claude.json.lock')
  expect([...world.locks]).toEqual([])
})

test('a switch that cannot write the config puts the login back and records that it failed', async ($, on) => {
  const world = machine(on, 'absent')
  world.failingWrites.add(CONFIG)
  expect(await run($, 'use 2')).toStartWith('account-switch: cannot write /home/me/.claude.json')
  // Claude Code is never left with Jun's token under Mina's name.
  expect(world.liveToken()).toBe('a-mina')
  expect((JSON.parse(world.files[CREDENTIALS] ?? '{}') as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken).toBe('a-mina')
  expect(world.changes().map(one => ({ kind: one.kind, to: one.to, failed: one.failed }))).toEqual([
    { kind: 'switch', to: 'jun@example.org', failed: undefined },
    { kind: 'switch', to: 'jun@example.org', failed: true },
  ])
})

test('an older copy of an account\'s login is used but never filed over the newer one saved', async ($, on) => {
  const world = machine(on, 'absent')
  world.keychain['account-switch|u1'] = login('a-mina-new', NOW + 9 * HOUR)
  // Another program writes back a copy of Mina's from before, still valid and expiring sooner.
  world.writeLogin(MINA, 'a-mina-old', NOW + HOUR)
  await run($, 'refresh')
  expect((JSON.parse(world.keychain['account-switch|u1'] ?? '{}') as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken).toBe('a-mina-new')
})

test('the grant Claude Code holds is never refreshed, even while the config names another account', async ($, on) => {
  const world = machine(on, 'absent')
  // Claude Code holds Jun's grant, near expiry, while its config still names Mina.
  world.keychain[LIVE_ITEM] = login('a-jun', NOW + 60_000)
  world.keychain['account-switch|u2'] = login('a-jun', NOW + 60_000)
  await run($, 'refresh')
  expect(world.refreshes).toEqual([])
})

test('a lookup refreshes a login Orca keeps a copy of, and writes the new grant to Orca\'s copy too', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  world.store.orca = { claude: { accounts: [ORCA_MINA, ORCA_JUN].map(({ id, email, organizationUuid }) => ({ id, email, organizationUuid })), activeId: 'o-mina' }, seenAt: NOW, checkedAt: NOW }
  // Jun's token has expired, here and in Orca's copy of the same grant.
  world.keychain['account-switch|u2'] = login('a-jun', NOW - HOUR)
  world.keychain['Orca Claude Code Managed Credentials|o-jun'] = login('a-jun', NOW - HOUR)
  await run($, 'refresh')
  expect(world.refreshes.length).toBe(1)
  const token = (key: string) => (JSON.parse(world.keychain[key] ?? '{}') as { claudeAiOauth: { accessToken: string; refreshToken: string } }).claudeAiOauth
  expect(token('account-switch|u2')).toMatchObject({ accessToken: 'a-jun-refreshed', refreshToken: 'r-jun-refreshed' })
  expect(token('Orca Claude Code Managed Credentials|o-jun')).toMatchObject({ accessToken: 'a-jun-refreshed', refreshToken: 'r-jun-refreshed' })
  expect((world.state.usage as Record<string, { isHeld?: boolean }>).u2?.isHeld).toBeUndefined()
})

test('a lookup leaves alone a login Orca keeps where no copy of it can be read, and says so on its card', async ($, on) => {
  const world = machine(on, { accounts: [ORCA_MINA, ORCA_JUN], activeId: 'o-mina' })
  world.store.orca = { claude: { accounts: [ORCA_MINA, ORCA_JUN].map(({ id, email, organizationUuid }) => ({ id, email, organizationUuid })), activeId: 'o-mina' }, seenAt: NOW, checkedAt: NOW }
  world.keychain['account-switch|u2'] = login('a-jun', NOW - HOUR)
  await run($, 'refresh')
  expect(world.refreshes).toEqual([])
  expect((world.state.usage as Record<string, { isHeld?: boolean }>).u2?.isHeld).toBe(true)
})

test('removing by the command takes the account named whole', async ($, on) => {
  const world = machine(on, 'absent')
  expect(await run($, 'remove 2')).toStartWith('Removing deletes the saved login, so name the account whole')
  expect(await run($, 'remove jun')).toStartWith('Removing deletes the saved login, so name the account whole')
  expect(world.store['oauthAccount:u2']).toBeDefined()
  expect(await run($, 'remove jun@example.org')).toBe('Removed the jun@example.org account.')
  expect(world.store['oauthAccount:u2']).toBeUndefined()
})

test('a lookup never writes back the reading of an account another session removed', async ($, on) => {
  const world = machine(on, 'absent')
  // Another session removed Jun: the shared list holds Mina alone, while this session still shows both.
  world.store.accounts = [{ uuid: 'u1', email: MINA.emailAddress, savedAt: 0 }]
  delete world.store['oauthAccount:u2']
  world.state.usage = { u2: { limits: [{ label: '5h', percent: 40 }], fetchedAt: NOW - HOUR, source: 'lookup' } }
  await run($, 'refresh')
  expect(Object.keys((world.store.usage ?? {}) as Record<string, unknown>)).toEqual(['u1'])
})
