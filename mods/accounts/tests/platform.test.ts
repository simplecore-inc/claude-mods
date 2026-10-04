import { expect, test } from 'claude-code/testing'

import { deleteFileArgv, detectPlatform, privateWriteArgv, vaultFilePath } from '../hooks/platform'

test('detectPlatform keeps the keychain for macOS alone', async () => {
  expect(detectPlatform(undefined, 'Darwin\n')).toEqual({ backend: 'keychain', isWindows: false })
  expect(detectPlatform(undefined, 'Linux\n')).toEqual({ backend: 'file', isWindows: false })
  expect(detectPlatform('Windows_NT', undefined)).toEqual({ backend: 'file', isWindows: true })
  expect(detectPlatform(undefined, undefined)).toEqual({ backend: 'file', isWindows: false })
})

test('vaultFilePath refuses an id that could leave the vault directory', async () => {
  expect(vaultFilePath('/h/.claude', 'account-switch', 'ab-12_c')).toBe('/h/.claude/account-switch/ab-12_c.json')
  expect(() => vaultFilePath('/h/.claude', 'account-switch', '../x')).toThrow()
})

test('privateWriteArgv passes the path as an argument, never inside the script', async () => {
  const argv = privateWriteArgv('/h/a "b".json')
  expect(argv[argv.length - 1]).toBe('/h/a "b".json')
  expect((argv[2] ?? '').includes('umask 077')).toBe(true)
})

test('deleteFileArgv uses cmd.exe with backslashes on Windows and rm elsewhere', async () => {
  expect(deleteFileArgv('/h/x.json', false)).toEqual(['rm', '-f', '/h/x.json'])
  const windows = deleteFileArgv('C:/Users/u/.claude/account-switch/x.json', true)
  expect(windows[0]).toBe('cmd.exe')
  expect(windows.includes('C:\\Users\\u\\.claude\\account-switch\\x.json')).toBe(true)
})
