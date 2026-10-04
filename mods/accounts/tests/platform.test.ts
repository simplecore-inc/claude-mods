import { expect, test } from 'claude-code/testing'

import { deleteFileArgv, detectPlatform, privateWriteArgv, vaultFilePath } from '../hooks/platform'
import { encodePowerShell, powerShellLiteral } from '../hooks/shared/files'

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
  const script = argv[2] ?? ''
  expect(script.includes('umask 077')).toBe(true)
  // A file already there keeps its mode through `cat >`: it is narrowed before the write.
  expect(script.indexOf('chmod 600 "$0"')).toBeGreaterThan(-1)
  expect(script.indexOf('chmod 600 "$0"')).toBeLessThan(script.indexOf('cat > "$0"'))
})

test('deleteFileArgv uses rm on a POSIX system and PowerShell\'s Remove-Item, from an encoded script, on Windows', async () => {
  expect(deleteFileArgv('/h/x.json', false)).toEqual(['rm', '-f', '--', '/h/x.json'])
  const windows = deleteFileArgv("C:/Users/John Doe/.claude/account-switch/x.json", true)
  expect(windows.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(decodePowerShell(windows[4] ?? '')).toContain("-LiteralPath $p")
  expect(decodePowerShell(windows[4] ?? '')).toContain("@('C:/Users/John Doe/.claude/account-switch/x.json')")
})

test('a path reaches PowerShell as one literal, every form of single quote doubled', async () => {
  expect(powerShellLiteral("it's ‘x’ $HOME %TEMP% `a")).toBe("'it''s ‘‘x’’ $HOME %TEMP% `a'")
  expect(decodePowerShell(encodePowerShell('Remove-Item 한글'))).toBe('Remove-Item 한글')
})

/** The script back from `-EncodedCommand`: base64, then UTF-16LE. */
function decodePowerShell(encoded: string): string {
  const bytes = atob(encoded)
  let text = ''
  for (let index = 0; index < bytes.length; index += 2) text += String.fromCharCode(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8))

  return text
}
