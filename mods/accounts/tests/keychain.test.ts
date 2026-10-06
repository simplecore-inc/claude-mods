import { expect, test } from 'claude-code/testing'

import { mayHeal, parseProfile } from '../hooks/anthropic'
import {
  addLine,
  credentialsDirectory,
  fileLagsKeychain,
  findArgv,
  isAccountId,
  isOlderGrant,
  isSameGrant,
  keychainAccountName,
  LIVE_SERVICE,
  liveServiceName,
  parseCredential,
} from '../hooks/keychain'

test('an account id is filed only as letters, digits, dashes and underscores, as a UUID is', async () => {
  expect(isAccountId('ab238aed-81e5-4263-b289-3dcbed4c86b5')).toBe(true)
  expect(isAccountId('u1')).toBe(true)
  for (const id of ['', 'a"b', 'a\nb', '../x', 'a b', 42, undefined]) expect(isAccountId(id)).toBe(false)
  // The profile endpoint naming an id this mod cannot file names no account.
  expect(() => parseProfile(JSON.stringify({ account: { uuid: 'u"1\nadd-generic-password', email: 'x@example.com' } }))).toThrow()
  expect(parseProfile(JSON.stringify({ account: { uuid: 'u1', email: 'x@example.com' } })).accountUuid).toBe('u1')
})

test('a keychain line refuses a name that would end the line security -i reads', async () => {
  expect(() => addLine('account-switch', 'u"1', '{}')).toThrow()
  expect(() => addLine('account-switch', 'u1\ndelete-generic-password', '{}')).toThrow()
  expect(() => addLine('svc\\', 'u1', '{}')).toThrow()
})

test('a login is an older copy only as another grant that expires sooner; one grant is the same refresh token', async () => {
  const grant = (refresh: string, expiresAt: number) => ({ claudeAiOauth: { accessToken: `a-${refresh}-${expiresAt}`, refreshToken: refresh, expiresAt } }) as never
  expect(isOlderGrant(grant('old', 1_000), grant('new', 9_000))).toBe(true)
  expect(isOlderGrant(grant('new', 9_000), grant('old', 1_000))).toBe(false)
  // The same grant with its access token refreshed is never an older copy.
  expect(isOlderGrant(grant('same', 1_000), grant('same', 9_000))).toBe(false)
  expect(isOlderGrant(grant('old', 1_000), null)).toBe(false)
  expect(isSameGrant(grant('same', 1_000), grant('same', 9_000))).toBe(true)
  expect(isSameGrant(grant('a', 1_000), grant('b', 1_000))).toBe(false)
  expect(isSameGrant(null, grant('b', 1_000))).toBe(false)
})

test('addLine carries the secret as hex, never in plain text', async () => {
  const secret = '{"claudeAiOauth":{"accessToken":"sk-ant-x"}}'
  const line = addLine('account-switch', 'uuid-1', secret)
  expect(line.includes('sk-ant-x')).toBe(false)
  const hex = /-X "([0-9a-f]+)"/.exec(line)?.[1] ?? ''
  const bytes = new Uint8Array(hex.match(/../g)?.map(pair => parseInt(pair, 16)) ?? [])
  expect(new TextDecoder().decode(bytes)).toBe(secret)
  expect(line.endsWith('\n')).toBe(true)
})

test('findArgv names the account only when given', async () => {
  expect(findArgv('s')).toEqual(['security', 'find-generic-password', '-s', 's', '-w'])
  expect(findArgv('s', 'a')).toEqual(['security', 'find-generic-password', '-s', 's', '-a', 'a', '-w'])
})

test('the keychain service is named as Claude Code names it for its config directory', async () => {
  const home = '/home/me/.claude'
  // The default directory keeps the plain name, as does an empty CLAUDE_SECURESTORAGE_CONFIG_DIR.
  expect(await liveServiceName({}, home)).toBe(LIVE_SERVICE)
  expect(await liveServiceName({ configDir: '' }, home)).toBe(LIVE_SERVICE)
  expect(await liveServiceName({ configDir: '/home/me/work-claude', secureStorageDir: '' }, home)).toBe(LIVE_SERVICE)
  // CLAUDE_CONFIG_DIR, even naming the default folder, hashes the folder as given.
  expect(await liveServiceName({ configDir: '/home/me/.claude' }, home)).toBe('Claude Code-credentials-cb67f5c9')
  expect(await liveServiceName({ configDir: '/home/me/work-claude' }, home)).toBe('Claude Code-credentials-9b768060')
  // CLAUDE_SECURESTORAGE_CONFIG_DIR outranks it, and a folder is hashed in its NFC form.
  expect(await liveServiceName({ configDir: '/home/me/work-claude', secureStorageDir: '/home/me/.claude' }, home)).toBe('Claude Code-credentials-cb67f5c9')
  expect(await liveServiceName({ configDir: '/home/me/café' }, home)).toBe('Claude Code-credentials-cac2ab92')
})

test('the credentials file lives in the secure-storage folder when one is named, else in the config directory', async () => {
  const home = '/home/me/.claude'
  expect(credentialsDirectory({}, home)).toBe(home)
  expect(credentialsDirectory({ configDir: '/home/me/work-claude' }, home)).toBe('/home/me/work-claude')
  expect(credentialsDirectory({ configDir: '/home/me/work-claude', secureStorageDir: '/srv/keys' }, home)).toBe('/srv/keys')
  expect(credentialsDirectory({ configDir: '/home/me/work-claude', secureStorageDir: '' }, home)).toBe(home)
})

test('the keychain account is the user\'s name, or claude-code-user when the name holds other characters', async () => {
  expect(keychainAccountName('mina')).toBe('mina')
  expect(keychainAccountName('mina.k_2-x')).toBe('mina.k_2-x')
  expect(keychainAccountName('mina kim')).toBe('claude-code-user')
  expect(keychainAccountName(undefined)).toBe('claude-code-user')
})

test('parseCredential refuses an item without OAuth tokens', async () => {
  expect(() => parseCredential('{"other":1}')).toThrow()
  expect(parseCredential('{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}\n').claudeAiOauth.refreshToken).toBe('r')
})

test('the credentials file lags the keychain when it holds another token expiring no later, never when it is the newer', async () => {
  const login = (token: string, expiresAt: number) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt, scopes: [], subscriptionType: 'max' } }) as never
  // Claude Code refreshed into the keychain: the file still holds the token whose refresh token that spent.
  expect(fileLagsKeychain(login('old', 1_000), login('new', 9_000))).toBe(true)
  expect(fileLagsKeychain(login('same', 9_000), login('same', 9_000))).toBe(false)
  expect(fileLagsKeychain(login('newer', 12_000), login('new', 9_000))).toBe(false)
  expect(fileLagsKeychain(null, login('new', 9_000))).toBe(false)
})

test('a rejected login is put back only from a saved one that works as it is, once a minute', async () => {
  const login = (token: string, expiresAt: number) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt, scopes: [], subscriptionType: 'max' } }) as never
  const now = 10 * 60 * 60 * 1000
  const hours = (n: number) => now + n * 60 * 60 * 1000
  expect(mayHeal(login('saved', hours(7)), login('spent', 0), now, 0, 60_000)).toBe(true)
  // Nothing saved, or the saved one is the very token rejected.
  expect(mayHeal(null, login('spent', 0), now, 0, 60_000)).toBe(false)
  expect(mayHeal(login('spent', hours(7)), login('spent', 0), now, 0, 60_000)).toBe(false)
  // A saved login that would need refreshing first is left to /login.
  expect(mayHeal(login('saved', now + 60_000), login('spent', 0), now, 0, 60_000)).toBe(false)
  // Put back a moment ago: a login rejected again is left alone, so two writers never loop.
  expect(mayHeal(login('saved', hours(7)), login('spent', 0), now, now - 30_000, 60_000)).toBe(false)
})
