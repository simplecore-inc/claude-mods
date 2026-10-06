import { expect, test } from 'claude-code/testing'

import {
  ORCA_CLIENT_SCRIPT,
  ORCA_PENDING_KEPT_MS,
  asPending,
  asRemembered,
  isKeptByOrca,
  orcaAccountFor,
  orcaDataDirectory,
  orcaPipeScript,
  orcaRequestLine,
  pipeName,
  parseOrcaClaude,
  parseOrcaFrame,
  parseOrcaRuntime,
  pendingStep,
  planFollow,
  planSwitch,
} from '../hooks/orca'
import type { OrcaClaude } from '../hooks/orca'

const MINA = { id: 'o-mina', email: 'mina@example.com', organizationUuid: 'org-mina' }
const JUN = { id: 'o-jun', email: 'jun@example.org', organizationUuid: 'org-jun' }
const orca = (activeId: string | null): OrcaClaude => ({ accounts: [MINA, JUN], activeId })

test('Orca\'s data folder is found as its CLI finds it', async () => {
  const place = { home: '/home/me', isMac: false, isWindows: false }
  expect(orcaDataDirectory({ ...place, userDataVariable: '/srv/orca-dev' })).toBe('/srv/orca-dev')
  expect(orcaDataDirectory({ ...place, isMac: true })).toBe('/home/me/Library/Application Support/orca')
  expect(orcaDataDirectory(place)).toBe('/home/me/.config/orca')
  expect(orcaDataDirectory({ ...place, xdgConfigHome: '/home/me/.xdg' })).toBe('/home/me/.xdg/orca')
  expect(orcaDataDirectory({ ...place, isWindows: true, appData: 'C:\\Users\\me\\AppData\\Roaming' })).toBe('C:/Users/me/AppData/Roaming/orca')
  expect(orcaDataDirectory({ ...place, isWindows: true })).toBeNull()
})

test('the runtime metadata names the endpoint this platform reaches Orca on, and the token', async () => {
  const metadata = {
    pid: 1,
    transports: [
      { kind: 'websocket', endpoint: 'ws://0.0.0.0:6768' },
      { kind: 'unix', endpoint: '/run/o.sock' },
      { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\orca-1' },
    ],
    authToken: 't',
  }
  expect(parseOrcaRuntime(JSON.stringify(metadata), 'unix')).toEqual({ endpoint: '/run/o.sock', authToken: 't' })
  expect(parseOrcaRuntime(JSON.stringify(metadata), 'named-pipe')).toEqual({ endpoint: '\\\\.\\pipe\\orca-1', authToken: 't' })
  expect(parseOrcaRuntime(JSON.stringify({ ...metadata, authToken: '' }), 'unix')).toBeNull()
  expect(parseOrcaRuntime(JSON.stringify({ ...metadata, transports: [metadata.transports[0]] }), 'unix')).toBeNull()
  expect(parseOrcaRuntime('{ not json', 'unix')).toBeNull()
})

test('on Windows the client reaches the named pipe by its name, and keeps the Perl client\'s exit codes', async () => {
  expect(pipeName('\\\\.\\pipe\\orca-53414')).toBe('orca-53414')
  expect(pipeName('orca-53414')).toBe('orca-53414')
  const script = orcaPipeScript("\\\\.\\pipe\\it's-orca", 10)
  expect(script.includes("NamedPipeClientStream('.', 'it''s-orca'")).toBe(true)
  expect(script.includes('[Console]::In.ReadToEnd()')).toBe(true)
  expect(script.includes('exit 2')).toBe(true)
  expect(script.includes('authToken')).toBe(false)
})

test('a request is one line of JSON carrying the token, its params left out when it has none', async () => {
  const line = orcaRequestLine('r1', 'secret', 'accounts.selectClaude', { accountId: 'o-jun' })
  expect(line.endsWith('\n')).toBe(true)
  expect(JSON.parse(line)).toEqual({ id: 'r1', authToken: 'secret', method: 'accounts.selectClaude', params: { accountId: 'o-jun' } })
  expect('params' in JSON.parse(orcaRequestLine('r2', 'secret', 'accounts.list'))).toBe(false)
})

test('the answer to a request is found past keepalives, other ids and lines that do not parse', async () => {
  const lines = ['{"_keepalive":true}', 'garbage', '{"id":"other","ok":true,"result":1}', '{"id":"r1","ok":true,"result":{"a":2}}'].join('\n')
  expect(parseOrcaFrame(lines, 'r1')).toEqual({ ok: true, result: { a: 2 } })
  expect(parseOrcaFrame('{"id":"r1","ok":false,"error":{"code":"x","message":"A Claude account switch is already in progress."}}', 'r1')).toEqual({
    ok: false,
    reason: 'A Claude account switch is already in progress.',
  })
  expect(parseOrcaFrame('{"_keepalive":true}\n', 'r1')).toBeNull()
})

test('Orca\'s Claude accounts and its selected one are read from accounts.list, the host runtime first', async () => {
  const result = {
    claude: {
      accounts: [
        { id: 'o-mina', email: 'mina@example.com', managedAuthRuntime: 'host', organizationUuid: 'org-mina' },
        { id: 'o-jun', email: 'jun@example.org', managedAuthRuntime: 'host', organizationUuid: 'org-jun' },
        { id: 'o-wsl', email: 'kai@example.net', managedAuthRuntime: 'wsl', organizationUuid: 'org-kai' },
      ],
      activeAccountId: 'o-wsl',
      activeAccountIdsByRuntime: { host: 'o-jun', wsl: {} },
    },
    codex: { accounts: [] },
  }
  expect(parseOrcaClaude(result)).toEqual(orca('o-jun'))
  // Orca leaves the host's login alone: nothing selected there.
  expect(parseOrcaClaude({ claude: { ...result.claude, activeAccountIdsByRuntime: { host: null } } })?.activeId).toBeNull()
  // An older Orca names one selection only; one it does not keep is no selection.
  expect(parseOrcaClaude({ claude: { accounts: result.claude.accounts, activeAccountId: 'o-mina' } })?.activeId).toBe('o-mina')
  expect(parseOrcaClaude({ claude: { accounts: result.claude.accounts, activeAccountId: 'o-gone' } })?.activeId).toBeNull()
  expect(parseOrcaClaude({ codex: {} })).toBeNull()
})

test('an account is matched as Orca matches it: the email in any case, and the organization when known', async () => {
  expect(orcaAccountFor(orca(null), 'MINA@example.com', 'org-mina')).toEqual(MINA)
  expect(orcaAccountFor(orca(null), 'mina@example.com', 'org-other')).toBeUndefined()
  expect(orcaAccountFor(orca(null), 'mina@example.com')).toEqual(MINA)
  // Without the organization, an email two accounts share decides nothing.
  const twice: OrcaClaude = { accounts: [MINA, { ...MINA, id: 'o-mina-2', organizationUuid: 'org-team' }], activeId: null }
  expect(orcaAccountFor(twice, 'mina@example.com')).toBeUndefined()
  expect(orcaAccountFor(twice, 'mina@example.com', 'org-team')?.id).toBe('o-mina-2')
})

test('a switch selects the account in Orca when Orca runs and writes a login, and refuses one Orca would put back', async () => {
  expect(planSwitch({ kind: 'absent' }, null, 'jun@example.org')).toEqual({ kind: 'direct' })
  // Orca leaves the login alone (its system default): nothing to bring along.
  expect(planSwitch({ kind: 'ok', claude: orca(null) }, null, 'jun@example.org')).toEqual({ kind: 'direct' })
  expect(planSwitch({ kind: 'ok', claude: orca('o-mina') }, null, 'jun@example.org', 'org-jun')).toEqual({ kind: 'select', account: JUN, activeId: 'o-mina' })
  expect(planSwitch({ kind: 'ok', claude: orca('o-mina') }, null, 'kai@example.net')).toEqual({ kind: 'refuse', activeEmail: 'mina@example.com' })
})

test('with Orca closed, a switch is made here and left for Orca by what it said last', async () => {
  for (const reach of [{ kind: 'down' }, { kind: 'unreachable', reason: 'no perl' }] as const) {
    expect(planSwitch(reach, orca('o-mina'), 'jun@example.org', 'org-jun')).toEqual({ kind: 'pending', account: JUN, activeId: 'o-mina' })
    expect(planSwitch(reach, orca('o-mina'), 'kai@example.net')).toEqual({ kind: 'warn', activeEmail: 'mina@example.com' })
    expect(planSwitch(reach, orca(null), 'jun@example.org')).toEqual({ kind: 'direct' })
    expect(planSwitch(reach, null, 'jun@example.org')).toEqual({ kind: 'direct' })
  }
})

test('a login changed outside is Orca\'s own, one Orca must follow, or one it puts back', async () => {
  expect(planFollow(null, 'jun@example.org')).toEqual({ kind: 'none' })
  expect(planFollow(orca(null), 'jun@example.org')).toEqual({ kind: 'none' })
  expect(planFollow(orca('o-jun'), 'jun@example.org', 'org-jun')).toEqual({ kind: 'orca' })
  expect(planFollow(orca('o-mina'), 'jun@example.org', 'org-jun')).toEqual({ kind: 'follow', account: JUN })
  expect(planFollow(orca('o-mina'), 'kai@example.net')).toEqual({ kind: 'revert', activeEmail: 'mina@example.com' })
})

test('a login Orca keeps a copy of is held, selected there or not', async () => {
  expect(isKeptByOrca(orca(null), 'jun@example.org', 'org-jun')).toBe(true)
  expect(isKeptByOrca(orca('o-mina'), 'kai@example.net')).toBe(false)
  expect(isKeptByOrca(null, 'jun@example.org')).toBe(false)
})

test('a selection waiting for Orca is made only while Orca still writes the login it wrote when asked', async () => {
  const pending = { accountId: 'o-jun', email: 'jun@example.org', activeBefore: 'o-mina', at: 1_000 }
  expect(pendingStep(pending, orca('o-mina'), 2_000)).toBe('apply')
  expect(pendingStep(pending, orca('o-jun'), 2_000)).toBe('done')
  // Someone picked another account in Orca since, or Orca dropped the account, or a week went by.
  expect(pendingStep(pending, { accounts: [MINA, JUN, { id: 'o-kai', email: 'kai@example.net', organizationUuid: null }], activeId: 'o-kai' }, 2_000)).toBe('drop')
  expect(pendingStep(pending, { accounts: [MINA], activeId: 'o-mina' }, 2_000)).toBe('drop')
  expect(pendingStep(pending, orca('o-mina'), 1_000 + ORCA_PENDING_KEPT_MS + 1)).toBe('drop')
})

test('what the store keeps of Orca is read back only when whole', async () => {
  expect(asPending({ accountId: 'o-jun', email: 'jun@example.org', activeBefore: null, at: 5 })).toEqual({ accountId: 'o-jun', email: 'jun@example.org', activeBefore: null, at: 5 })
  expect(asPending({ accountId: 'o-jun' })).toBeNull()
  expect(asPending(undefined)).toBeNull()
  // Kept as it was read: the accounts and the selection, so the selection survives the round trip.
  expect(asRemembered({ claude: orca('o-jun'), seenAt: 1 })).toEqual(orca('o-jun'))
  expect(asRemembered({ claude: { accounts: [{ id: 'o-jun', email: 'jun@example.org' }], activeId: 'o-gone' }, seenAt: 1 })?.activeId).toBeNull()
  expect(asRemembered({ checkedAt: 1 })).toBeNull()
})

test('the client takes the socket and the time from argv and the request from stdin, so the token never reaches argv', async () => {
  expect(ORCA_CLIENT_SCRIPT.includes('Peer => $ARGV[0]')).toBe(true)
  expect(ORCA_CLIENT_SCRIPT.includes('alarm($ARGV[1])')).toBe(true)
  expect(ORCA_CLIENT_SCRIPT.includes('<STDIN>')).toBe(true)
  expect(ORCA_CLIENT_SCRIPT.includes('authToken')).toBe(false)
})
