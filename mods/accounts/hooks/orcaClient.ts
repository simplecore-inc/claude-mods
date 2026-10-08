import { homeDirectory, platformOf } from './credentials'
import type { OrcaCopyPlace } from './credentials'
import type { Messages } from './i18n'
import type { Io } from './io'
import { message } from './io'
import { isAccountId } from './keychain'
import {
  ORCA_CLIENT_SCRIPT,
  ORCA_EXIT,
  ORCA_RUNTIME_FILE,
  asPending,
  asRemembered,
  orcaDataDirectory,
  orcaPipeScript,
  orcaRequestLine,
  parseOrcaClaude,
  parseOrcaFrame,
  parseOrcaRuntime,
} from './orca'
import type { OrcaAccount, OrcaClaude, OrcaPending, OrcaReach } from './orca'
import { encodePowerShell } from './shared/files'

/**
 * Asking Orca's running app: its Claude accounts (`accounts.list`) and
 * selecting one (`accounts.selectClaude`), through the socket or named pipe
 * its `orca-runtime.json` names, as Orca's own CLI does. What it said last is
 * kept in the store for every session, Orca closed included.
 */

/** The `$.store` key of what Orca said last. */
const ORCA_KEY = 'orca'
/** The `$.store` key of a selection a switch asked while Orca was not answering, made once it answers. */
const ORCA_PENDING_KEY = 'orcaPending'
/** How often, machine-wide, the tick asks Orca for its accounts again. */
const ORCA_RECHECK_MS = 5 * 60 * 1000
/** How long what Orca said last is trusted while it does not run: after two weeks it is taken as no longer used. */
const ORCA_FORGET_MS = 14 * 24 * 60 * 60 * 1000
/** How long Orca has to answer, in seconds: selecting an account may refresh its token first. */
const ORCA_LIST_SECONDS = 10
const ORCA_SELECT_SECONDS = 30

type OrcaAnswer = { kind: 'absent' } | { kind: 'down' } | { kind: 'unreachable'; reason: string } | { kind: 'ok'; result: unknown }

/** Orca's data folder on this machine, or null where none can be named. */
async function orcaDirectory(io: Io): Promise<string | null> {
  const platform = await platformOf(io)

  return orcaDataDirectory({
    userDataVariable: await io.env('ORCA_USER_DATA_PATH'),
    home: await homeDirectory(io),
    isMac: platform.backend === 'keychain',
    isWindows: platform.isWindows,
    xdgConfigHome: await io.env('XDG_CONFIG_HOME'),
    appData: await io.env('APPDATA'),
  })
}

/**
 * Sends one request to Orca's runtime and reads the answer. Orca is `absent`
 * when its data folder is not there, `down` when nothing answers, and
 * `unreachable` when the client cannot run, times out or Orca refuses.
 */
async function orcaRequest(io: Io, m: Messages, method: string, params: unknown, seconds: number): Promise<OrcaAnswer> {
  const directory = await orcaDirectory(io)
  if (directory === null || !(await io.exists(directory))) return { kind: 'absent' }
  const { isWindows } = await platformOf(io)
  const metadataPath = `${directory}/${ORCA_RUNTIME_FILE}`
  // Installed, but no runtime says where it answers: Orca is not running.
  const runtime = (await io.exists(metadataPath)) ? parseOrcaRuntime(await io.read(metadataPath), isWindows ? 'named-pipe' : 'unix') : null
  if (!runtime) return { kind: 'down' }
  const id = crypto.randomUUID()
  const argv = isWindows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(orcaPipeScript(runtime.endpoint, seconds))]
    : ['perl', '-e', ORCA_CLIENT_SCRIPT, runtime.endpoint, String(seconds)]
  let run: { exitCode: number; stdout: string; stderr: string }
  try {
    run = await io.run(argv, { stdin: orcaRequestLine(id, runtime.authToken, method, params), timeoutMs: (seconds + 5) * 1000 })
  } catch (error) {
    return { kind: 'unreachable', reason: message(error) }
  }
  if (run.exitCode === ORCA_EXIT.cannotConnect) return { kind: 'down' }
  if (run.exitCode === -1 && /failed to start|ENOENT/.test(run.stderr)) return { kind: 'unreachable', reason: isWindows ? m.orcaNeedsPowerShell : m.orcaNeedsPerl }
  if (run.exitCode !== ORCA_EXIT.answered) return { kind: 'unreachable', reason: run.stderr.trim() || `exit ${run.exitCode}` }
  const frame = parseOrcaFrame(run.stdout, id)
  if (!frame) return { kind: 'unreachable', reason: m.orcaNoAnswer }

  return frame.ok ? { kind: 'ok', result: frame.result } : { kind: 'unreachable', reason: frame.reason }
}

/** The marker Orca writes into each account folder it owns, holding the account's id. */
const ORCA_OWNED_MARKER = '.orca-managed-claude-auth'

/**
 * Where Orca keeps its copy of one account's login: the keychain on macOS;
 * elsewhere the account's folder under `claude-accounts` in Orca's data folder,
 * or under `~/.local/share/orca` for an account Orca keeps in WSL, seen from
 * inside WSL. A folder counts only where Orca's marker in it names the account,
 * as Orca itself checks before it uses one. Null when no copy can be reached.
 */
export async function orcaCopyPlace(io: Io, orcaId: string): Promise<OrcaCopyPlace | null> {
  if (!isAccountId(orcaId)) return null
  const platform = await platformOf(io)
  if (platform.backend === 'keychain') return { kind: 'keychain', orcaId }
  const data = await orcaDirectory(io)
  const roots = [data === null ? null : `${data}/claude-accounts`, platform.isWindows ? null : `${await homeDirectory(io)}/.local/share/orca/claude-accounts`]
  for (const root of roots) {
    if (root === null) continue
    const folder = `${root}/${orcaId}/auth`
    const marker = `${folder}/${ORCA_OWNED_MARKER}`
    const path = `${folder}/.credentials.json`
    if (!(await io.exists(marker)) || !(await io.exists(path))) continue
    if ((await io.read(marker)).trim() === orcaId) return { kind: 'file', path }
  }

  return null
}

/** Asks Orca for its Claude logins, and keeps what it says for every session. */
export async function orcaClaude(io: Io, m: Messages): Promise<OrcaReach> {
  const answer = await orcaRequest(io, m, 'accounts.list', undefined, ORCA_LIST_SECONDS)
  const now = await io.now()
  if (answer.kind === 'absent') {
    await io.store.delete(ORCA_KEY)
    await io.store.delete(ORCA_PENDING_KEY)

    return answer
  }
  const kept = ((await io.store.get(ORCA_KEY)) ?? {}) as Record<string, unknown>
  if (answer.kind !== 'ok') {
    await io.store.set(ORCA_KEY, { ...kept, checkedAt: now })

    return answer
  }
  const claude = parseOrcaClaude(answer.result)
  if (!claude) {
    await io.store.set(ORCA_KEY, { ...kept, checkedAt: now })

    return { kind: 'unreachable', reason: m.orcaNoAnswer }
  }
  await io.store.set(ORCA_KEY, { claude, seenAt: now, checkedAt: now })

  return { kind: 'ok', claude }
}

/** What Orca said last, while it is recent enough to trust; null with nothing said. */
export async function rememberedOrca(io: Io): Promise<OrcaClaude | null> {
  const kept = (await io.store.get(ORCA_KEY)) as { seenAt?: unknown } | undefined
  if (typeof kept?.seenAt !== 'number' || (await io.now()) - kept.seenAt > ORCA_FORGET_MS) return null

  return asRemembered(kept)
}

/** Whether the tick asks Orca again now: every few minutes machine-wide, and every tick while a selection waits for it. */
export async function isOrcaCheckDue(io: Io): Promise<boolean> {
  if (asPending(await io.store.get(ORCA_PENDING_KEY))) return true
  const kept = (await io.store.get(ORCA_KEY)) as { checkedAt?: unknown } | undefined

  return typeof kept?.checkedAt !== 'number' || (await io.now()) - kept.checkedAt >= ORCA_RECHECK_MS
}

/** Selects a Claude account in Orca, which then writes it into Claude Code's login itself. */
export async function orcaSelect(io: Io, m: Messages, accountId: string): Promise<void> {
  const answer = await orcaRequest(io, m, 'accounts.selectClaude', { accountId }, ORCA_SELECT_SECONDS)
  if (answer.kind === 'ok') return
  throw new Error(answer.kind === 'unreachable' ? answer.reason : m.orcaNotRunning)
}

/** Keeps a selection for Orca to make once it answers, and the account Orca wrote when it was asked. */
export async function keepPending(io: Io, account: OrcaAccount, activeBefore: string | null): Promise<void> {
  const pending: OrcaPending = { accountId: account.id, email: account.email, activeBefore, at: await io.now() }
  await io.store.set(ORCA_PENDING_KEY, pending)
}

/** Takes the waiting selection off the store, so no other session makes it too; null when none waits. */
export async function takePending(io: Io): Promise<OrcaPending | null> {
  const pending = asPending(await io.store.get(ORCA_PENDING_KEY))
  if (pending) await io.store.delete(ORCA_PENDING_KEY)

  return pending
}

/** Puts a selection back to wait, when making it failed. */
export async function returnPending(io: Io, pending: OrcaPending): Promise<void> {
  await io.store.set(ORCA_PENDING_KEY, pending)
}

/** Drops any waiting selection: a switch with nothing to bring Orca to. */
export async function dropPending(io: Io): Promise<void> {
  await io.store.delete(ORCA_PENDING_KEY)
}
