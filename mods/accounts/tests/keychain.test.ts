import { expect, test } from 'claude-code/testing'

import { mayHeal } from '../hooks/anthropic'
import { addLine, fileLagsKeychain, findArgv, parseAccountName, parseCredential } from '../hooks/keychain'

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

test('parseAccountName reads acct from the attribute dump', async () => {
  expect(parseAccountName('    "acct"<blob>="someone"\n    "svce"<blob>="x"')).toBe('someone')
  expect(parseAccountName('nothing here')).toBeUndefined()
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
