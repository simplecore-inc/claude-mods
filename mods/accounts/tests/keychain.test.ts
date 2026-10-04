import { expect, test } from 'claude-code/testing'

import { addLine, findArgv, parseAccountName, parseCredential } from '../hooks/keychain'

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
