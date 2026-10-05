/**
 * Deleting files by argv on every platform, with no shell to read the paths.
 *
 * Claude Code starts a plugin's command without a shell. On a POSIX system
 * `rm -f -- <paths>` takes each path as one argument. Windows has no `rm`,
 * and `cmd.exe /c del` would read the paths again by cmd's own rules (`%VAR%`
 * expanded, quotes stripped), so there PowerShell runs `Remove-Item
 * -LiteralPath` from an encoded script: the paths travel inside the script as
 * single-quoted literals and are never parsed as a command line.
 */

/** The script as PowerShell's `-EncodedCommand` takes it: UTF-16LE, then base64. */
export function encodePowerShell(script: string): string {
  let bytes = ''
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index)
    bytes += String.fromCharCode(unit & 0xff, unit >> 8)
  }

  return btoa(bytes)
}

/**
 * A path as a PowerShell single-quoted literal: nothing in it is special but
 * a single quote, which PowerShell also reads in its curly forms (‘ ’ ‚ ‛);
 * each is doubled.
 */
export function powerShellLiteral(path: string): string {
  return `'${path.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`
}

/** argv deleting `paths`, absent or not; relative paths resolve against the command's working directory. */
export function removeArgv(paths: readonly string[], isWindows: boolean): string[] {
  if (!isWindows) return ['rm', '-f', '--', ...paths]
  // Only files are deleted, and an absent path is passed over: Remove-Item on a directory with
  // children asks whether to go on, a question no plugin answers. A file that cannot be deleted
  // stops the script, which exits 1.
  const script = `foreach ($p in @(${paths.map(powerShellLiteral).join(',')})) { if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } }`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/**
 * argv deleting `paths` with everything under them, absent or not: a session's
 * transcript and its folder of subagent transcripts and tool output. The
 * caller checks every path lies where it means to delete; nothing here does.
 */
export function removeTreeArgv(paths: readonly string[], isWindows: boolean): string[] {
  if (!isWindows) return ['rm', '-rf', '--', ...paths]
  // -Recurse with -Force asks nothing: a folder with children is deleted whole.
  const script = `foreach ($p in @(${paths.map(powerShellLiteral).join(',')})) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } }`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}
