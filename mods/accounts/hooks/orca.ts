/**
 * Orca keeps Claude logins of its own. While one of them is selected there,
 * Orca writes it into Claude Code's login (the keychain items, the credentials
 * file and `oauthAccount` in `~/.claude.json`) each time it launches Claude,
 * fetches the rate limits or starts, so a login changed anywhere else is put
 * back at Orca's next write. A switch therefore selects the account in Orca
 * too, and a login Orca keeps a copy of is never refreshed here: refreshing it
 * would spend the refresh token Orca's copy holds.
 *
 * These helpers read what Orca says and build what is sent to it; the hooks
 * module talks to Orca's runtime through them where its `orca-runtime.json`
 * says, as Orca's own CLI does: its Unix socket through `perl` on macOS and
 * Linux, its named pipe through PowerShell on Windows.
 */

/** A Claude account Orca keeps. */
export type OrcaAccount = { id: string; email: string; organizationUuid: string | null }

/** Orca's Claude logins: the accounts it keeps, and the one it writes into Claude Code (null when it leaves the login alone). */
export type OrcaClaude = { accounts: OrcaAccount[]; activeId: string | null }

/** Where Orca's running app answers, from the `orca-runtime.json` it writes: a Unix socket, or a named pipe on Windows. */
export type OrcaRuntime = { endpoint: string; authToken: string }

/** How Orca's runtime is reached on a platform: its Unix socket, or on Windows its named pipe. */
export type OrcaTransport = 'unix' | 'named-pipe'

/** What came of asking Orca: not installed, installed but not running, running but not answering, or its answer. */
export type OrcaReach = { kind: 'absent' } | { kind: 'down' } | { kind: 'unreachable'; reason: string } | { kind: 'ok'; claude: OrcaClaude }

/** The file in Orca's data folder that names its runtime's endpoint (a socket, or a named pipe on Windows) and token. */
export const ORCA_RUNTIME_FILE = 'orca-runtime.json'

/** How long a selection asked while Orca was closed waits for Orca to run again. */
export const ORCA_PENDING_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Orca's data folder, found as Orca's CLI finds it: `ORCA_USER_DATA_PATH`
 * (set in Orca's own terminals), else the platform's application data folder;
 * null on Windows without `APPDATA`.
 */
export function orcaDataDirectory(place: { userDataVariable?: string; home: string; isMac: boolean; isWindows: boolean; xdgConfigHome?: string; appData?: string }): string | null {
  if (place.userDataVariable) return place.userDataVariable
  if (place.isWindows) return place.appData ? `${place.appData.replaceAll('\\', '/')}/orca` : null
  if (place.isMac) return `${place.home}/Library/Application Support/orca`

  return `${place.xdgConfigHome || `${place.home}/.config`}/orca`
}

/** The runtime's endpoint for the transport this platform uses, and its token, from `orca-runtime.json`; null when it names neither. */
export function parseOrcaRuntime(text: string, transport: OrcaTransport): OrcaRuntime | null {
  let metadata: { transports?: unknown; authToken?: unknown }
  try {
    metadata = JSON.parse(text) as { transports?: unknown; authToken?: unknown }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (typeof metadata.authToken !== 'string' || metadata.authToken === '' || !Array.isArray(metadata.transports)) return null
  const found = (metadata.transports as { kind?: unknown; endpoint?: unknown }[]).find(one => one.kind === transport && typeof one.endpoint === 'string' && one.endpoint !== '')

  return found ? { endpoint: found.endpoint as string, authToken: metadata.authToken } : null
}

/** One request to Orca's runtime as a line of JSON; it carries the token, so it goes on stdin, never in argv. */
export function orcaRequestLine(id: string, authToken: string, method: string, params?: unknown): string {
  return `${JSON.stringify(params === undefined ? { id, authToken, method } : { id, authToken, method, params })}\n`
}

/** Orca's answer to one request: its result, or the reason it gave. */
export type OrcaFrame = { ok: true; result: unknown } | { ok: false; reason: string }

/** The answer in what the runtime sent, keepalive lines skipped; null when no answer to `id` is there. */
export function parseOrcaFrame(text: string, id: string): OrcaFrame | null {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let frame: { id?: unknown; ok?: unknown; result?: unknown; error?: { message?: unknown } | null; _keepalive?: unknown }
    try {
      frame = JSON.parse(line) as typeof frame
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
    if (frame._keepalive === true || frame.id !== id) continue
    if (frame.ok === true) return { ok: true, result: frame.result }

    return { ok: false, reason: typeof frame.error?.message === 'string' ? frame.error.message : 'Orca refused the request' }
  }

  return null
}

/** The Claude part of what `accounts.list` answers, or null when it holds none. */
export function parseOrcaClaude(result: unknown): OrcaClaude | null {
  const claude = (result as { claude?: { accounts?: unknown; activeAccountId?: unknown; activeAccountIdsByRuntime?: { host?: unknown } } } | null)?.claude
  if (!claude || !Array.isArray(claude.accounts)) return null
  const accounts = (claude.accounts as { id?: unknown; email?: unknown; organizationUuid?: unknown; managedAuthRuntime?: unknown }[])
    // A login Orca keeps in a WSL distribution is written there, not into this machine's Claude Code.
    .filter(account => typeof account.id === 'string' && typeof account.email === 'string' && (account.managedAuthRuntime ?? 'host') === 'host')
    .map(account => ({
      id: account.id as string,
      email: account.email as string,
      organizationUuid: typeof account.organizationUuid === 'string' && account.organizationUuid !== '' ? account.organizationUuid : null,
    }))
  const host = claude.activeAccountIdsByRuntime?.host
  const active = host === undefined ? claude.activeAccountId : host
  const activeId = typeof active === 'string' && accounts.some(account => account.id === active) ? active : null

  return { accounts, activeId }
}

/**
 * The account Orca keeps for a login, matched as Orca matches its own: the
 * same email, ignoring case, and the same organization. Without the
 * organization the email decides, when only one account holds it.
 */
export function orcaAccountFor(claude: OrcaClaude, email: string, organizationUuid?: string | null): OrcaAccount | undefined {
  const sameEmail = claude.accounts.filter(account => account.email.trim().toLowerCase() === email.trim().toLowerCase())
  if (organizationUuid) return sameEmail.find(account => account.organizationUuid === organizationUuid)

  return sameEmail.length === 1 ? sameEmail[0] : undefined
}

/** The email of the account Orca writes into Claude Code, or null when it leaves the login alone. */
export function orcaActiveEmail(claude: OrcaClaude | null): string | null {
  return claude?.accounts.find(account => account.id === claude.activeId)?.email ?? null
}

/**
 * How a switch to an account goes with Orca as it stands:
 * - `direct`: Orca is not installed, or leaves Claude Code's login alone;
 * - `select`: Orca runs and keeps the account, so it is selected there too;
 * - `refuse`: Orca runs, writes another login and keeps none for this account, so it would put its own back;
 * - `pending`: Orca keeps the account but does not run now; it is selected once Orca answers again;
 * - `warn`: Orca does not run now and keeps no login for the account; it puts its own back when it starts.
 *
 * `remembered` is what Orca said last, for when it does not answer now.
 */
export type OrcaPlan =
  | { kind: 'direct' }
  | { kind: 'select'; account: OrcaAccount; activeId: string | null }
  | { kind: 'refuse'; activeEmail: string | null }
  | { kind: 'pending'; account: OrcaAccount; activeId: string | null }
  | { kind: 'warn'; activeEmail: string | null }

export function planSwitch(reach: OrcaReach, remembered: OrcaClaude | null, email: string, organizationUuid?: string | null): OrcaPlan {
  if (reach.kind === 'absent') return { kind: 'direct' }
  if (reach.kind === 'ok') {
    if (reach.claude.activeId === null) return { kind: 'direct' }
    const account = orcaAccountFor(reach.claude, email, organizationUuid)

    return account ? { kind: 'select', account, activeId: reach.claude.activeId } : { kind: 'refuse', activeEmail: orcaActiveEmail(reach.claude) }
  }
  if (!remembered || remembered.activeId === null) return { kind: 'direct' }
  const account = orcaAccountFor(remembered, email, organizationUuid)

  return account ? { kind: 'pending', account, activeId: remembered.activeId } : { kind: 'warn', activeEmail: orcaActiveEmail(remembered) }
}

/**
 * What a change of the login, made by no switch of this mod, means with Orca:
 * - `none`: Orca is not there, or leaves Claude Code's login alone;
 * - `orca`: the login is now the account Orca writes, so Orca made the change;
 * - `follow`: the login is an account Orca keeps but does not write, so Orca is told to write it, or it would put its own back;
 * - `revert`: the login is an account Orca keeps no copy of; Orca puts its own back at its next write.
 */
export type OrcaFollow = { kind: 'none' } | { kind: 'orca' } | { kind: 'follow'; account: OrcaAccount } | { kind: 'revert'; activeEmail: string | null }

export function planFollow(claude: OrcaClaude | null, email: string, organizationUuid?: string | null): OrcaFollow {
  if (!claude || claude.activeId === null) return { kind: 'none' }
  const account = orcaAccountFor(claude, email, organizationUuid)
  if (account?.id === claude.activeId) return { kind: 'orca' }

  return account ? { kind: 'follow', account } : { kind: 'revert', activeEmail: orcaActiveEmail(claude) }
}

/**
 * Whether Orca keeps a copy of this login, selected or not: refreshing the
 * token here would spend the refresh token that copy holds, and Orca would
 * later write a spent login into Claude Code.
 */
export function isKeptByOrca(claude: OrcaClaude | null, email: string, organizationUuid?: string | null): boolean {
  return claude !== null && orcaAccountFor(claude, email, organizationUuid) !== undefined
}

/** A selection asked while Orca was not running: the account, and the one Orca wrote then. */
export type OrcaPending = { accountId: string; email: string; activeBefore: string | null; at: number }

/**
 * What to do with a pending selection now that Orca answers: `apply` it;
 * `done` when Orca already writes that account; `drop` it when it is a week
 * old, Orca no longer keeps the account, or someone picked another account in
 * Orca since (Orca writes neither the account then nor the one asked).
 */
export function pendingStep(pending: OrcaPending, claude: OrcaClaude, now: number): 'apply' | 'done' | 'drop' {
  if (claude.activeId === pending.accountId) return 'done'
  if (now - pending.at > ORCA_PENDING_KEPT_MS) return 'drop'
  if (!claude.accounts.some(account => account.id === pending.accountId)) return 'drop'

  return claude.activeId === pending.activeBefore ? 'apply' : 'drop'
}

/** Reads a pending selection kept in the store, or null. */
export function asPending(value: unknown): OrcaPending | null {
  const pending = value as Partial<OrcaPending> | null | undefined
  if (!pending || typeof pending.accountId !== 'string' || typeof pending.email !== 'string' || typeof pending.at !== 'number') return null

  return { accountId: pending.accountId, email: pending.email, activeBefore: typeof pending.activeBefore === 'string' ? pending.activeBefore : null, at: pending.at }
}

/** Reads what Orca said last, kept in the store as `{ claude: OrcaClaude }`, or null. */
export function asRemembered(value: unknown): OrcaClaude | null {
  const claude = (value as { claude?: { accounts?: unknown; activeId?: unknown } } | null | undefined)?.claude
  if (!claude || !Array.isArray(claude.accounts)) return null
  const accounts = (claude.accounts as Partial<OrcaAccount>[])
    .filter(account => typeof account.id === 'string' && typeof account.email === 'string')
    .map(account => ({ id: account.id as string, email: account.email as string, organizationUuid: typeof account.organizationUuid === 'string' ? account.organizationUuid : null }))
  const activeId = typeof claude.activeId === 'string' && accounts.some(account => account.id === claude.activeId) ? claude.activeId : null

  return { accounts, activeId }
}

/** How the clients below end: 0 printed an answer; the rest say why there is none. */
export const ORCA_EXIT = { answered: 0, cannotConnect: 2, timedOut: 3, closed: 4, cannotSend: 5 } as const

/** The pipe's name as .NET takes it: the endpoint without its `\\.\pipe\` prefix. */
export function pipeName(endpoint: string): string {
  return endpoint.replace(/^\\\\\.\\pipe\\/i, '').replace(/^\/\/\.\/pipe\//i, '')
}

/**
 * A client for Orca's runtime on Windows, as a PowerShell script: it connects
 * to the named pipe, sends the request line it reads from stdin, and prints the
 * first line back that is not a keepalive, within `seconds`. Its exit codes
 * are those of the Perl client.
 */
export function orcaPipeScript(endpoint: string, seconds: number): string {
  const name = pipeName(endpoint).replace(/'/g, "''")

  return [
    "$ErrorActionPreference = 'Stop'",
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    `$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut)`,
    `try { $pipe.Connect(${Math.min(seconds, 5) * 1000}) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${ORCA_EXIT.cannotConnect} }`,
    '$reader = New-Object System.IO.StreamReader($pipe, $utf8)',
    '$writer = New-Object System.IO.StreamWriter($pipe, $utf8)',
    '$writer.AutoFlush = $true',
    '$request = [Console]::In.ReadToEnd()',
    'if (-not $request.EndsWith("`n")) { $request += "`n" }',
    `try { $writer.Write($request) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${ORCA_EXIT.cannotSend} }`,
    `$deadline = [DateTime]::UtcNow.AddSeconds(${seconds})`,
    'while ($true) {',
    '  $task = $reader.ReadLineAsync()',
    '  $left = ($deadline - [DateTime]::UtcNow).TotalMilliseconds',
    `  if ($left -le 0 -or -not $task.Wait([int]$left)) { [Console]::Error.WriteLine('timed out'); exit ${ORCA_EXIT.timedOut} }`,
    '  $line = $task.Result',
    `  if ($null -eq $line) { [Console]::Error.WriteLine('closed'); exit ${ORCA_EXIT.closed} }`,
    '  if ($line.Trim() -eq \'\' -or $line -match \'^\\s*\\{\\s*"_keepalive"\\s*:\\s*true\\s*\\}\\s*$\') { continue }',
    '  [Console]::Out.WriteLine($line)',
    `  exit ${ORCA_EXIT.answered}`,
    '}',
  ].join('\n')
}

/**
 * A client for Orca's runtime in Perl, which macOS and Linux both carry: it
 * connects to the socket in its first argument, sends the request line it
 * reads from stdin, and prints the first line back that is not a keepalive,
 * within the seconds in its second argument.
 */
export const ORCA_CLIENT_SCRIPT = [
  'use strict; use warnings; use IO::Socket::UNIX; use Socket qw(SOCK_STREAM);',
  `$SIG{ALRM} = sub { print STDERR "timed out\\n"; exit ${ORCA_EXIT.timedOut} };`,
  'alarm($ARGV[1]);',
  `my $socket = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $ARGV[0]) or do { print STDERR "$!\\n"; exit ${ORCA_EXIT.cannotConnect} };`,
  'my $request = do { local $/; <STDIN> };',
  `print {$socket} $request or do { print STDERR "$!\\n"; exit ${ORCA_EXIT.cannotSend} };`,
  '$socket->flush;',
  'while (defined(my $line = <$socket>)) {',
  '  next if $line =~ /^\\s*$/ || $line =~ /^\\s*\\{\\s*"_keepalive"\\s*:\\s*true\\s*\\}\\s*$/;',
  '  print $line;',
  `  exit ${ORCA_EXIT.answered};`,
  '}',
  `print STDERR "closed\\n"; exit ${ORCA_EXIT.closed};`,
].join('\n')
