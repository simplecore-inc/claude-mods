import { expect, test } from 'claude-code/testing'

import { ensureFresh, liveOauthAccount, writeLiveOauthAccount } from '../hooks/credentials'
import { countUsage, loadUsageIndex } from '../hooks/count'
import type { CountContext } from '../hooks/count'
import { feedWebhook, replyExcerpt, resetFeed, upgradeTemplate } from '../hooks/feed'
import type { FeedContext } from '../hooks/feed'
import { messagesFor } from '../hooks/i18n'
import { TimeoutError, within } from '../hooks/io'
import { LockBusyError, acquire, makeLockArgv, removeLockArgv } from '../hooks/lock'
import { beginSession, countLines } from '../hooks/sessionStatus'
import type { StatusContext } from '../hooks/sessionStatus'
import { DEFAULT_TEMPLATE_TEXT, FORMER_DEFAULT_TEXTS } from '../hooks/webhook'
import { atomicWriteArgv, windowsReplaceArgv } from '../hooks/writes'
import type { WebhookSend } from '../types'
import { fakeMachine, response, settled } from './machine'

const m = messagesFor('en')
const REFRESH_NO_ANSWER = m.refreshNoAnswer(30)
const login = (token: string, expiresAt: number) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } })

test('a lock is a directory only one process makes: a held one is waited for, then refused', async () => {
  const machine = fakeMachine()
  const options = { staleMs: 10_000, tries: 3, isWindows: false }
  const first = await acquire(machine.io, '/locks/a.lock', options)
  expect(machine.folders.has('/locks/a.lock')).toBe(true)
  await expect(acquire(machine.io, '/locks/a.lock', options)).rejects.toThrow(LockBusyError)
  await first.release()
  expect(machine.folders.has('/locks/a.lock')).toBe(false)
  const again = await acquire(machine.io, '/locks/a.lock', options)
  await again.release()
})

test('a lock abandoned past its stale time is taken over, and the process that held it leaves the new one alone', async () => {
  const machine = fakeMachine()
  const options = { staleMs: 10_000, tries: 3, isWindows: false }
  const abandoned = await acquire(machine.io, '/locks/b.lock', options)
  await machine.advance(11_000)
  const taken = await acquire(machine.io, '/locks/b.lock', options)
  await abandoned.release()
  expect(machine.folders.has('/locks/b.lock')).toBe(true)
  await taken.release()
  expect(machine.folders.has('/locks/b.lock')).toBe(false)
})

test('the lock and the atomic write take the path as an argument, never inside a script', async () => {
  const path = "/home/me/it's $(odd).json"
  for (const argv of [makeLockArgv(path, false), removeLockArgv(path, false), atomicWriteArgv(path, true)]) {
    expect(argv[0]).toBe('/bin/sh')
    expect(argv[2]?.includes(path)).toBe(false)
    expect(argv[3]).toBe(path)
  }
  expect(atomicWriteArgv(path, true)[4]).toBe('private')
  expect(atomicWriteArgv(path, false)[4]).toBe('shared')
  // The text goes to a file beside the target, renamed over it; nothing truncates the target in place.
  expect(atomicWriteArgv(path, true)[2]?.includes('mv -f "$tmp" "$target"')).toBe(true)
  expect(atomicWriteArgv(path, true)[2]?.includes('cat > "$0"')).toBe(false)
  expect(windowsReplaceArgv('C:/t.tmp', 'C:/d.json')[0]).toBe('powershell.exe')
})

test('the account in Claude Code\'s config is set under Claude Code\'s own lock and the file replaced whole, its other keys kept', async () => {
  const machine = fakeMachine()
  machine.write('/home/me/.claude.json', JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'mina@example.com' }, projects: { '/w': { lastCost: 1 } } }))
  await writeLiveOauthAccount(machine.io, { accountUuid: 'u2', emailAddress: 'jun@example.org' })
  const config = JSON.parse(machine.files['/home/me/.claude.json'] ?? '{}') as { oauthAccount: { emailAddress: string }; projects: unknown }
  expect(config.oauthAccount.emailAddress).toBe('jun@example.org')
  expect(config.projects).toEqual({ '/w': { lastCost: 1 } })
  expect(machine.runs.some(argv => argv[3] === '/home/me/.claude.json.lock' && argv[2]?.includes('mkdir "$0"'))).toBe(true)
  expect(machine.runs.some(argv => argv[3] === '/home/me/.claude.json' && argv[4] === 'private')).toBe(true)
  expect(machine.folders.has('/home/me/.claude.json.lock')).toBe(false)
  expect((await liveOauthAccount(machine.io))?.emailAddress).toBe('jun@example.org')
})

test('the account in Claude Code\'s config is not written while Claude Code holds its lock', async () => {
  const machine = fakeMachine()
  machine.write('/home/me/.claude.json', JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'mina@example.com' } }))
  // Claude Code is writing its config: its lock stands, fresh.
  machine.folders.add('/home/me/.claude.json.lock')
  machine.mtimes['/home/me/.claude.json.lock'] = machine.now()
  await expect(writeLiveOauthAccount(machine.io, { accountUuid: 'u2', emailAddress: 'jun@example.org' })).rejects.toThrow(LockBusyError)
  expect((JSON.parse(machine.files['/home/me/.claude.json'] ?? '{}') as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress).toBe('mina@example.com')
})

test('the grant Claude Code holds is never refreshed here, even when the config names another account', async () => {
  const machine = fakeMachine()
  let refreshed = 0
  machine.setFetch(async () => {
    refreshed += 1
    return response(200, { access_token: 'new', refresh_token: 'r-new', expires_in: 28_800 })
  })
  const nearExpiry = login('a-jun', machine.now() + 60_000)
  expect(await ensureFresh(machine.io, 'u2', nearExpiry, nearExpiry, REFRESH_NO_ANSWER)).toEqual(nearExpiry)
  expect(refreshed).toBe(0)
})

test('a refresh runs under the account\'s lock and reads the saved login again: one another session refreshed is not refreshed twice', async () => {
  const machine = fakeMachine()
  let refreshed = 0
  machine.setFetch(async () => {
    refreshed += 1
    return response(200, { access_token: 'new', refresh_token: 'r-new', expires_in: 28_800 })
  })
  // The keychain holds what another session already refreshed.
  machine.setRunner(argv => (argv[0] === 'security' && argv[1] === 'find-generic-password' ? { exitCode: 0, stdout: JSON.stringify(login('a-jun-2', machine.now() + 8 * 3_600_000)), stderr: '' } : undefined) as never)
  const stale = login('a-jun', machine.now() + 60_000)
  const fresh = await ensureFresh(machine.io, 'u2', stale, null, REFRESH_NO_ANSWER)
  expect(fresh.claudeAiOauth.accessToken).toBe('a-jun-2')
  expect(refreshed).toBe(0)
  expect(machine.runs.some(argv => argv[3]?.endsWith('/sc-accounts/locks/refresh-u2.lock'))).toBe(true)
  expect(machine.folders.has('/home/me/.claude/sc-accounts/locks/refresh-u2.lock')).toBe(false)
})

test('a refresh that answers after its time is saved when the answer comes: its refresh token is already rotated', async () => {
  const machine = fakeMachine()
  let answer: (value: ReturnType<typeof response>) => void = () => {}
  machine.setFetch(() => new Promise(resolve => (answer = resolve)))
  const saved: string[] = []
  machine.setRunner((argv, init) => {
    if (argv[0] === 'security' && argv[1] === 'find-generic-password') return { exitCode: 44, stdout: '', stderr: 'not found' } as never
    if (argv[0] === 'security' && argv[1] === '-i') saved.push(init?.stdin ?? '')

    return undefined
  })
  const pending = ensureFresh(machine.io, 'u2', login('a-jun', machine.now() + 60_000), null, REFRESH_NO_ANSWER)
  await settled()
  await machine.advance(31_000)
  await expect(pending).rejects.toThrow(TimeoutError)
  await expect(pending).rejects.toThrow(REFRESH_NO_ANSWER)
  answer(response(200, { access_token: 'late', refresh_token: 'r-late', expires_in: 28_800 }))
  await settled()
  expect(saved.length).toBe(1)
})

test('within answers with the value, or once its time passes a timeout in the words the caller gave', async () => {
  const machine = fakeMachine()
  expect(await within(machine.io, Promise.resolve(7), 1000, 'x')).toBe(7)
  const late = within(machine.io, new Promise(() => {}), 1000, messagesFor('ko').webhookNoAnswer(1))
  const caught = late.catch((error: unknown) => error)
  await machine.advance(1001)
  const error = await caught
  expect(error).toBeInstanceOf(TimeoutError)
  // The words whole, with nothing added to them.
  expect((error as TimeoutError).message).toBe('수신 서버가 1초 안에 응답하지 않았습니다.')
})

function countContext(machine: ReturnType<typeof fakeMachine>, shown: { scans: unknown[] }): CountContext {
  let error: string | null = null

  return {
    io: machine.io,
    messages: () => m,
    usagePeriod: async () => 30,
    usageSummary: async () => undefined,
    usageScan: async scan => void shown.scans.push(scan),
    usageError: { get: async () => error, set: async next => void (error = next) },
    isUsageShown: async () => false,
  }
}

test('one session counts at a time: with another holding the count\'s lock, nothing is read or written', async () => {
  const machine = fakeMachine()
  machine.write('/home/me/.claude/projects/p/s1.jsonl', '{"type":"user"}\n')
  machine.folders.add('/home/me/.claude/sc-accounts/locks/usage-count.lock')
  machine.mtimes['/home/me/.claude/sc-accounts/locks/usage-count.lock'] = machine.now()
  expect(await countUsage(countContext(machine, { scans: [] }))).toEqual([])
  expect(machine.runs.some(argv => argv[0] === 'sh')).toBe(false)
  expect('/home/me/.claude/sc-accounts/usage-index.json' in machine.files).toBe(false)
})

test('a count starts from the count as the files hold it, reading them again once another session wrote them', async () => {
  const machine = fakeMachine()
  const ctx = countContext(machine, { scans: [] })
  const index = (offset: number) => JSON.stringify({ version: 3, files: { '/x.jsonl': { offset } }, buckets: {}, sessions: {}, ids: [], idFiles: 0 })
  machine.write('/home/me/.claude/sc-accounts/usage-index.json', index(10))
  expect((await loadUsageIndex(ctx)).index.files['/x.jsonl']?.offset).toBe(10)
  // Another session counted further and wrote the files.
  machine.write('/home/me/.claude/sc-accounts/usage-index.json', index(250))
  expect((await loadUsageIndex(ctx)).index.files['/x.jsonl']?.offset).toBe(250)
})

function feedContext(machine: ReturnType<typeof fakeMachine>, lasts: WebhookSend[]): FeedContext {
  return {
    io: machine.io,
    messages: () => m,
    webhookLast: async last => void lasts.push(last),
    liveFigures: async () => ({ email: 'mina@example.com', limits: [] }),
    session: { id: () => 's1', hostname: () => 'host', version: () => '2.1.291' },
  }
}

const STATUS = { updatedAt: 1, model: 'Opus 5.5', effort: 'low', ultracode: false, fast: false, contextUsed: 10, task: '', dir: 'w', branch: 'main', pr: null, linesAdded: 0, linesRemoved: 0 }

test('a receiver that does not answer is said to have not answered, holds one send, and is let go after five minutes', async () => {
  const machine = fakeMachine()
  machine.store.webhook = { enabled: true, url: 'https://example.com/hook', method: 'POST' }
  resetFeed()
  let sent = 0
  machine.setFetch(() => {
    sent += 1
    return new Promise(() => {})
  })
  const lasts: WebhookSend[] = []
  const ctx = feedContext(machine, lasts)
  await feedWebhook(ctx, STATUS, 'claude-opus-5-5', '/w', null)
  await settled()
  expect(sent).toBe(1)
  await machine.advance(10_001)
  expect(lasts.at(-1)?.error).toBe(m.webhookNoAnswer(10))
  // The status changes and the heartbeat comes due, but the send still waits: no second one.
  await machine.advance(40_000)
  await feedWebhook(ctx, { ...STATUS, contextUsed: 20 }, 'claude-opus-5-5', '/w', null)
  await settled()
  expect(sent).toBe(1)
  // Five minutes on, the send is let go and the feed goes on.
  await machine.advance(5 * 60 * 1000)
  await feedWebhook(ctx, { ...STATUS, contextUsed: 30 }, 'claude-opus-5-5', '/w', null)
  await settled()
  expect(sent).toBe(2)
})

test('what the receiver answered is kept with its status, on one line: an HTTP 200 that stored nothing says so', async () => {
  const machine = fakeMachine()
  machine.store.webhook = { enabled: true, url: 'https://example.com/hook', method: 'POST' }
  resetFeed()
  machine.setFetch(async () => response(200, '{"stored":false,\n  "reason":"server_error"}'))
  const lasts: WebhookSend[] = []
  await feedWebhook(feedContext(machine, lasts), STATUS, 'claude-opus-5-5', '/w', null)
  await settled()
  expect(lasts.at(-1)).toMatchObject({ status: 200, error: null, reply: '{"stored":false, "reason":"server_error"}' })
  // An empty answer says nothing; a long one is cut.
  expect(replyExcerpt(' \n ')).toBeNull()
  expect(replyExcerpt('x'.repeat(500))?.length).toBe(200)
})

test('a template file still holding the default an earlier release wrote is brought to the current one; an edited one stays', async () => {
  const machine = fakeMachine()
  const path = '/home/me/.claude/sc-accounts/webhook.json'
  const former = FORMER_DEFAULT_TEXTS[0] ?? ''
  machine.write(path, former)
  expect(await upgradeTemplate(machine.io)).toBe(true)
  expect(machine.files[path]).toBe(DEFAULT_TEMPLATE_TEXT)
  expect(machine.files[path]).toContain('"resets_at": "{{fiveHourResetsAtEpoch}}"')
  // Edited by the person, even to the same length: theirs, as it is.
  const edited = former.replace('{{cwd}}', '{{dir}}')
  expect(edited.length).toBe(former.length)
  machine.write(path, edited)
  expect(await upgradeTemplate(machine.io)).toBe(false)
  expect(machine.files[path]).toBe(edited)
  // No file: nothing to bring up, and none is written.
  delete machine.files[path]
  expect(await upgradeTemplate(machine.io)).toBe(false)
  expect(path in machine.files).toBe(false)
})

test('each session keeps its lines changed under a key of its own; a week-old count and the old shared map go', async () => {
  const machine = fakeMachine()
  machine.store['lines:old'] = { added: 1, removed: 1, at: machine.now() - 8 * 24 * 3_600_000 }
  machine.store['lines:other'] = { added: 4, removed: 0, at: machine.now() - 60_000 }
  machine.store.lines = { s1: { added: 2, removed: 1, at: machine.now() - 60_000 } }
  let effort: { level: string | null } | null = null
  const ctx = {
    accounts: { io: machine.io },
    model: async () => 'claude-opus-5-5',
    settings: async () => ({}),
    settingsOf: async () => ({}),
    sessionEffort: { get: async () => effort, set: async (value: { level: string | null } | null) => void (effort = value) },
  } as unknown as StatusContext
  // The count kept in the old shared map is taken up.
  await beginSession(ctx, 's1', false)
  await countLines(ctx, { added: 3, removed: 0 })
  expect(machine.store['lines:s1']).toMatchObject({ added: 5, removed: 1 })
  expect(machine.store['lines:other']).toMatchObject({ added: 4 })
  expect(machine.store['lines:old']).toBeUndefined()
  expect(machine.store.lines).toBeUndefined()
})
