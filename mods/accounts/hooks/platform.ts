/**
 * Where Claude Code keeps its login on this machine. macOS keeps it in the
 * keychain; Linux, WSL and Windows keep it in `<config dir>/.credentials.json`.
 */
export type Backend = 'keychain' | 'file'

export type Platform = {
  backend: Backend
  /** Windows proper (not WSL): no POSIX shell, `cmd.exe` deletes files. */
  isWindows: boolean
}

/**
 * @param osVariable the `OS` environment variable, `Windows_NT` on Windows
 * @param kernelName `uname -s` output, or undefined where `uname` did not run
 */
export function detectPlatform(osVariable: string | undefined, kernelName: string | undefined): Platform {
  if (osVariable === 'Windows_NT') return { backend: 'file', isWindows: true }
  if (kernelName === undefined) return { backend: 'file', isWindows: false }

  return { backend: kernelName.trim() === 'Darwin' ? 'keychain' : 'file', isWindows: false }
}

/** The vault file of one saved account under the file backend. */
export function vaultFilePath(claudeDirectory: string, vaultName: string, account: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error(`unsafe account id: ${account}`)

  return `${claudeDirectory}/${vaultName}/${account}.json`
}

/** argv writing stdin to `path` with owner-only permissions, on a POSIX shell. */
export function privateWriteArgv(path: string): string[] {
  return ['/bin/sh', '-c', 'umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0"', path]
}

/** argv deleting `path`, absent or not. */
export function deleteFileArgv(path: string, isWindows: boolean): string[] {
  return isWindows
    ? ['cmd.exe', '/d', '/c', 'if', 'exist', path.replaceAll('/', '\\'), 'del', '/f', '/q', path.replaceAll('/', '\\')]
    : ['rm', '-f', path]
}
