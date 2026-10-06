import type { Io } from './io'
import { encodePowerShell, powerShellLiteral } from './shared/files'

/**
 * Replacing a file whole, so a reader never meets it half written: the text
 * goes to a new file beside it, which is then renamed over it. A file another
 * program reads while this one writes (Claude Code's `.credentials.json` and
 * `~/.claude.json`) is never truncated in place.
 */

/**
 * argv writing stdin over the file `$0` on a POSIX shell. A link is followed
 * to the file it names, so the link stays. A private file is owner-only
 * (mode 600, the temporary file `mktemp` makes), and so is a folder made for
 * it; another gets mode 644.
 */
export function atomicWriteArgv(path: string, isPrivate: boolean): string[] {
  const script = [
    'set -e',
    '[ "$1" = private ] && umask 077',
    'target=$0',
    'while [ -L "$target" ]; do link=$(readlink "$target"); case $link in /*) target=$link ;; *) target=$(dirname "$target")/$link ;; esac; done',
    'dir=$(dirname "$target")',
    'mkdir -p "$dir"',
    'tmp=$(mktemp "$dir/.sc-accounts.XXXXXX")',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat > "$tmp"',
    '[ "$1" = private ] || chmod 644 "$tmp"',
    'mv -f "$tmp" "$target"',
  ].join('\n')

  return ['/bin/sh', '-c', script, path, isPrivate ? 'private' : 'shared']
}

/** argv putting `temporary` in place of `path` on Windows: `File.Replace` over a file there, a move otherwise. */
export function windowsReplaceArgv(temporary: string, path: string): string[] {
  const script = `$t = ${powerShellLiteral(temporary)}; $d = ${powerShellLiteral(path)}; if (Test-Path -LiteralPath $d -PathType Leaf) { [System.IO.File]::Replace($t, $d, $null) } else { [System.IO.File]::Move($t, $d) }`

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/** Replaces `path` with `text` atomically; on Windows the profile folder's access list keeps a private file private. */
export async function writeAtomic(io: Io, path: string, text: string, options: { isPrivate: boolean; isWindows: boolean }): Promise<void> {
  if (options.isWindows) {
    const temporary = `${path}.sc-accounts-${crypto.randomUUID()}.tmp`
    await io.write(temporary, text)
    const moved = await io.run(windowsReplaceArgv(temporary, path), { timeoutMs: 10_000 })
    if (moved.exitCode !== 0) throw new Error(`cannot write ${path}: ${moved.stderr.trim()}`)

    return
  }
  const written = await io.run(atomicWriteArgv(path, options.isPrivate), { stdin: text, timeoutMs: 10_000 })
  if (written.exitCode !== 0) throw new Error(`cannot write ${path}: ${written.stderr.trim()}`)
}
