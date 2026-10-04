import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountView, UsageView } from '../types'
import {
  AnthropicError,
  PROFILE_URL,
  TOKEN_URL,
  USAGE_URL,
  applyRefresh,
  failedReading,
  lookedUpOnly,
  withMeasured,
  needsRefresh,
  parseProfile,
  parseUsage,
  refreshInit,
  usageInit,
} from './anthropic'
import { describeLimits, pick, releaseDateOf } from './format'
import { messagesFor, resolveLocale } from './i18n'
import { Header, Tiles } from './shared/kit'
import { AccountsTab, STALE_MARK } from './views/accounts'
import { StatusBand } from './views/band'
import { parseStatusInfo } from './statusline'
import { LIVE_POLL_MS, afterRateLimit, afterSuccess, isAutomaticLookupDue, readShared } from './schedule'
import type { Locale, Messages } from './i18n'
import {
  ITEM_NOT_FOUND,
  KeychainError,
  LIVE_SERVICE,
  VAULT_SERVICE,
  addLine,
  attributesArgv,
  deleteArgv,
  findArgv,
  parseAccountName,
  parseCredential,
} from './keychain'
import type { Credential } from './keychain'
import { deleteFileArgv, detectPlatform, privateWriteArgv, vaultFilePath } from './platform'
import type { Platform } from './platform'

const accounts = atom({ plugin: 'sc-accounts', key: 'accounts' } as const, [])
const usage = atom({ plugin: 'sc-accounts', key: 'usage' } as const, {})
const live = atom({ plugin: 'sc-accounts', key: 'live' } as const, null)
const pendingConfirm = atom({ plugin: 'sc-accounts', key: 'pendingConfirm' } as const, null)
const isRefreshing = atom({ plugin: 'sc-accounts', key: 'isRefreshing' } as const, false)
const isGuideOpen = atom({ plugin: 'sc-accounts', key: 'isGuideOpen' } as const, false)
const statusInfo = atom({ plugin: 'sc-accounts', key: 'status' } as const, null)

const PANE = 'account-switch'
/** The product name heading the pane; a name, so it is not translated. */
const BRAND = 'SimpleCORE Mods'
/** The `/config` row of the plugin's `showStatusBand` setting. */
const BAND_SETTING = 'sc-accounts.showStatusBand'
/** The plugin `sc` declares /sc:accounts in `commands/accounts.md`; this hook answers it. */
const COMMAND = 'sc:accounts'
/** Every session wakes this often: to adopt a new login, and to share or take the automatic lookup. */
const TICK_MS = 60 * 1000
const USAGE_KEY = 'usage'
const LOOKUP_KEY = 'lookup'
const INDEX_KEY = 'accounts'
const oauthAccountKey = (uuid: string) => `oauthAccount:${uuid}`

/** The display language, settled at every session start (a reload starts one). */
let locale: Locale = 'en'
/** When this session last saw the live account change, by a switch or a login. */
let liveChangedAt = 0
/** This build's version and release date, read from the plugin's own files at session start. */
let release: { version?: string; date?: string } = {}
/** When this session's current model turn began; 0 before the first. */
let turnStartedAt = 0
/** The `$.store` key holding when any session last looked the live account up. */
const LIVE_LOOKUP_KEY = 'liveLookupAt'
/** How often the status file the status line command writes is read. */
const STATUS_POLL_MS = 2000
let m: Messages = messagesFor(locale)

/** The `oauthAccount` object Claude Code keeps in its global config, kept whole. */
type OauthAccount = {
  accountUuid: string
  emailAddress: string
  organizationName?: string
  [field: string]: unknown
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── credential storage ────────────────────────────────────────────────────

/** Directory under Claude Code's config directory holding saved logins on the file backend. */
const VAULT_DIRECTORY = 'account-switch'

let platformCache: Platform | undefined

async function platformOf($: EngineInterface): Promise<Platform> {
  if (platformCache) return platformCache
  const osVariable = await $.env.get('OS')
  let kernelName: string | undefined
  if (osVariable !== 'Windows_NT') {
    try {
      const uname = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
      kernelName = uname.exitCode === 0 ? uname.stdout : undefined
    } catch (error) {
      $.ui.log(`account-switch: uname: ${message(error)}`, { to: 'debug' })
    }
  }
  platformCache = detectPlatform(osVariable, kernelName)

  return platformCache
}

/** Writes owner-only on POSIX; on Windows the profile directory's ACL already is. */
async function writePrivateFile($: EngineInterface, path: string, text: string): Promise<void> {
  if ((await platformOf($)).isWindows) {
    await $.fs.write(path, text)

    return
  }
  const { exitCode, stderr } = await $.process.run(privateWriteArgv(path), { stdin: text, timeoutMs: 5000 })
  if (exitCode !== 0) throw new Error(`cannot write ${path}: ${stderr.trim()}`)
}

async function readFileIfPresent($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : null
}

async function liveCredentialPath($: EngineInterface): Promise<string> {
  return `${await claudeDirectory($)}/.credentials.json`
}

async function vaultPath($: EngineInterface, account: string): Promise<string> {
  return vaultFilePath(await claudeDirectory($), VAULT_DIRECTORY, account)
}

async function findSecret($: EngineInterface, service: string, account?: string): Promise<string | null> {
  const { exitCode, stdout, stderr } = await $.process.run(findArgv(service, account), { timeoutMs: 5000 })
  if (exitCode === ITEM_NOT_FOUND) return null
  if (exitCode !== 0) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)

  return stdout
}

async function storeSecret($: EngineInterface, service: string, account: string, text: string): Promise<void> {
  const { exitCode, stderr } = await $.process.run(['security', '-i'], {
    stdin: addLine(service, account, text),
    timeoutMs: 5000,
  })
  if (exitCode !== 0) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
}

/** The login Claude Code uses now. */
async function readLiveCredential($: EngineInterface): Promise<Credential | null> {
  const text =
    (await platformOf($)).backend === 'keychain'
      ? await findSecret($, LIVE_SERVICE)
      : await readFileIfPresent($, await liveCredentialPath($))

  return text === null ? null : parseCredential(text)
}

/** One saved account's login. */
async function readVault($: EngineInterface, uuid: string): Promise<Credential | null> {
  const text =
    (await platformOf($)).backend === 'keychain'
      ? await findSecret($, VAULT_SERVICE, uuid)
      : await readFileIfPresent($, await vaultPath($, uuid))

  return text === null ? null : parseCredential(text)
}

async function writeVault($: EngineInterface, uuid: string, credential: Credential): Promise<void> {
  const text = JSON.stringify(credential)
  if ((await platformOf($)).backend === 'keychain') {
    await storeSecret($, VAULT_SERVICE, uuid, text)
  } else {
    await writePrivateFile($, await vaultPath($, uuid), text)
  }
}

async function writeLiveCredential($: EngineInterface, credential: Credential): Promise<void> {
  if ((await platformOf($)).backend === 'file') return
  const attributes = await $.process.run(attributesArgv(LIVE_SERVICE), { timeoutMs: 5000 })
  const account = parseAccountName(attributes.stdout) ?? (await $.env.get('USER'))
  if (!account) throw new KeychainError('cannot tell which keychain account Claude Code uses')
  await storeSecret($, LIVE_SERVICE, account, JSON.stringify(credential))
}

/**
 * Writes `.credentials.json`: the login itself on the file backend, and on
 * macOS the plaintext fallback, only when that file exists. Claude Code
 * compares the file's mtime before each token check, so the write is what
 * makes a running session drop its cached login at once.
 */
async function writeLiveCredentialFile($: EngineInterface, credential: Credential): Promise<void> {
  const path = await liveCredentialPath($)
  if ((await platformOf($)).backend === 'keychain' && !(await $.fs.exists(path))) return
  await writePrivateFile($, path, JSON.stringify(credential))
}

async function deleteVault($: EngineInterface, uuid: string): Promise<void> {
  const platform = await platformOf($)
  if (platform.backend === 'file') {
    const path = await vaultPath($, uuid)
    const { exitCode, stderr } = await $.process.run(deleteFileArgv(path, platform.isWindows), { timeoutMs: 5000 })
    if (exitCode !== 0) throw new Error(`cannot delete ${path}: ${stderr.trim()}`)

    return
  }
  const { exitCode, stderr } = await $.process.run(deleteArgv(VAULT_SERVICE, uuid), { timeoutMs: 5000 })
  if (exitCode !== 0 && exitCode !== ITEM_NOT_FOUND) {
    throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
  }
}

// ── Claude Code's global config ───────────────────────────────────────────

/** `HOME`, or `USERPROFILE` on Windows. */
async function homeDirectory($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) throw new Error('neither HOME nor USERPROFILE is set')

  return home.replaceAll('\\', '/')
}

/** Claude Code's config directory, which holds `.credentials.json`. */
async function claudeDirectory($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await homeDirectory($)}/.claude`
}

async function globalConfigPath($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')

  return configDir ? `${configDir}/.claude.json` : `${await homeDirectory($)}/.claude.json`
}

async function liveOauthAccount($: EngineInterface): Promise<OauthAccount | null> {
  const config = JSON.parse(await $.fs.read(await globalConfigPath($))) as { oauthAccount?: OauthAccount }

  return typeof config.oauthAccount?.accountUuid === 'string' ? config.oauthAccount : null
}

async function writeLiveOauthAccount($: EngineInterface, account: OauthAccount): Promise<void> {
  const path = await globalConfigPath($)
  const config = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
  await $.fs.write(path, `${JSON.stringify({ ...config, oauthAccount: account }, null, 2)}\n`)
}

// ── accounts ──────────────────────────────────────────────────────────────

/**
 * The saved accounts: the list the store holds, with every account it lost
 * put back. An account is saved when both its details (`oauthAccount:<id>`)
 * and its credential are kept, so a session running an older build that wrote
 * back a shorter list cannot drop one; removing an account deletes both.
 */
async function storedIndex($: EngineInterface): Promise<AccountView[]> {
  const stored = await $.store.get(INDEX_KEY)
  const list = Array.isArray(stored) ? (stored as AccountView[]) : []
  const listed = new Set(list.map(one => one.uuid))
  const lost: AccountView[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('oauthAccount:')) continue
    const uuid = key.slice('oauthAccount:'.length)
    if (listed.has(uuid)) continue
    const account = (await $.store.get(key)) as OauthAccount | undefined
    const credential = account ? await readVault($, uuid).catch(() => null) : null
    if (!account || !credential) continue
    lost.push({
      uuid,
      email: account.emailAddress,
      organizationName: account.organizationName,
      subscriptionType: credential.claudeAiOauth.subscriptionType,
      savedAt: 0,
    })
  }

  return [...list, ...lost.sort((a, b) => a.email.localeCompare(b.email))]
}

/**
 * Changes the saved accounts. The change is applied to the list the store
 * holds now, never to this session's copy: a session that has not loaded the
 * list yet, or holds an older one, would otherwise write back only the
 * accounts it knows and drop the rest.
 */
async function changeIndex($: EngineInterface, change: (list: AccountView[]) => AccountView[]): Promise<AccountView[]> {
  const list = change(await storedIndex($))
  await $.store.set(INDEX_KEY, list)
  await update($, accounts, () => list)

  return list
}

async function loadIndex($: EngineInterface): Promise<void> {
  const list = await storedIndex($)
  await update($, accounts, () => list)
}

/**
 * Reads the login Claude Code uses now and files it in the vault: a new
 * account is added, a known one gets the credential Claude Code last refreshed.
 *
 * @returns the live account's uuid, or null with no Claude login
 */
async function syncLive($: EngineInterface): Promise<string | null> {
  const [configured, credential] = await Promise.all([liveOauthAccount($), readLiveCredential($)])
  if (configured === null || credential === null) {
    await update($, live, () => null)

    return null
  }

  let account = configured
  const stored = await readVault($, configured.accountUuid)
  if (JSON.stringify(stored) !== JSON.stringify(credential)) {
    // The token changed: ask whose it is. During a login the config and the
    // keychain can name different accounts for a moment, and filing a token
    // under the wrong account would show one account's usage as another's.
    const owner = await tokenOwner($, credential)
    if (owner === null) return read($, live)
    account =
      owner.accountUuid === configured.accountUuid
        ? configured
        : (((await $.store.get(oauthAccountKey(owner.accountUuid))) as OauthAccount | undefined) ?? owner)
    await writeVault($, account.accountUuid, credential)
  }
  if ((await read($, live)) !== account.accountUuid) liveChangedAt = await $.clock.now()
  await update($, live, () => account.accountUuid)
  await $.store.set(oauthAccountKey(account.accountUuid), account)

  const now = await $.clock.now()
  let isNew = false
  await changeIndex($, list => {
    const known = list.find(one => one.uuid === account.accountUuid)
    const view: AccountView = {
      uuid: account.accountUuid,
      email: account.emailAddress,
      organizationName: account.organizationName,
      subscriptionType: credential.claudeAiOauth.subscriptionType,
      savedAt: known?.savedAt ?? now,
    }
    isNew = known === undefined

    return known ? list.map(one => (one.uuid === view.uuid ? view : one)) : [...list, view]
  })
  if (isNew) $.ui.toast(m.saved(account.emailAddress))

  return account.accountUuid
}

/** Takes the status line command's latest forward, when it changed. */
async function readStatus($: EngineInterface, path: string): Promise<void> {
  if (!(await $.fs.exists(path))) return
  const next = parseStatusInfo(JSON.parse(await $.fs.read(path)))
  if (next === null) return
  const current = await read($, statusInfo)
  if (current?.updatedAt !== next.updatedAt) await update($, statusInfo, () => next)
}

/** The version `plugin.json` states and the date `CHANGELOG.md` gives that version. */
async function readRelease($: EngineInterface): Promise<{ version?: string; date?: string }> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    if (typeof manifest.version !== 'string') return {}
    const changelogPath = `${$.plugin.root}/CHANGELOG.md`
    const changelog = (await $.fs.exists(changelogPath)) ? await $.fs.read(changelogPath) : ''

    return { version: manifest.version, date: releaseDateOf(changelog, manifest.version) }
  } catch (error) {
    $.ui.log(`account-switch: cannot read the release: ${message(error)}`, { to: 'debug' })

    return {}
  }
}

/** Whose the token is, or null when the profile endpoint cannot say now. */
async function tokenOwner($: EngineInterface, credential: Credential): Promise<OauthAccount | null> {
  try {
    const response = await $.http.fetch(PROFILE_URL, usageInit({ token: credential.claudeAiOauth.accessToken }))
    if (!response.ok) return null

    return parseProfile(response.text)
  } catch (error) {
    $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' })

    return null
  }
}

/** Refreshes a saved, inactive account's access token when it is near expiry. */
async function ensureFresh($: EngineInterface, uuid: string, credential: Credential): Promise<Credential> {
  const now = await $.clock.now()
  if (!needsRefresh(credential, now)) return credential
  const response = await $.http.fetch(TOKEN_URL, refreshInit(credential))
  if (!response.ok) throw new AnthropicError(`token refresh answered ${response.status}`, response.status)
  const fresh = applyRefresh(credential, response.text, now)
  await writeVault($, uuid, fresh)

  return fresh
}

/** Makes a saved account the one Claude Code logs in with. */
async function switchTo($: EngineInterface, uuid: string): Promise<string> {
  const target = (await read($, accounts)).find(one => one.uuid === uuid)
  if (!target) throw new Error('no saved account with that id')

  // File the outgoing login first: Claude Code may have rotated its tokens.
  await syncLive($)
  const credential = await readVault($, uuid)
  const account = (await $.store.get(oauthAccountKey(uuid))) as OauthAccount | undefined
  if (credential === null || !account) throw new Error(`${target.email}: ${m.noStoredLogin}`)

  const fresh = await ensureFresh($, uuid, credential)
  await writeLiveCredential($, fresh)
  await writeLiveOauthAccount($, account)
  // Last, so a session that notices the change finds everything already in place.
  await writeLiveCredentialFile($, fresh)
  liveChangedAt = await $.clock.now()
  await update($, live, () => uuid)
  await refreshLive($)

  return m.switched(target.email)
}

async function remove($: EngineInterface, uuid: string): Promise<string> {
  const target = (await read($, accounts)).find(one => one.uuid === uuid)
  if ((await read($, live)) === uuid) throw new Error(m.cannotRemoveLive)
  await deleteVault($, uuid)
  await $.store.delete(oauthAccountKey(uuid))
  await changeIndex($, list => list.filter(one => one.uuid !== uuid))
  await update($, usage, map => {
    const { [uuid]: _dropped, ...rest } = map

    return rest
  })

  return m.removed(target?.email ?? uuid)
}

// ── usage ─────────────────────────────────────────────────────────────────

async function readingFor($: EngineInterface, uuid: string, liveUuid: string | null): Promise<UsageView> {
  let init
  if (uuid === liveUuid) {
    // The live login is Claude Code's to refresh, never this mod's: a refresh
    // rotates the token under Claude Code. Its token says whose usage comes back.
    const credential = await readLiveCredential($)
    if (credential === null) throw new Error(m.noStoredLogin)
    init = usageInit({ token: credential.claudeAiOauth.accessToken })
  } else {
    const credential = await readVault($, uuid)
    if (credential === null) throw new Error(m.noStoredLogin)
    init = usageInit({ token: (await ensureFresh($, uuid, credential)).claudeAiOauth.accessToken })
  }
  const response = await $.http.fetch(USAGE_URL, init)
  if (!response.ok) {
    throw new AnthropicError(`usage endpoint answered ${response.status}`, response.status, response.headers['retry-after'])
  }

  return { limits: parseUsage(JSON.parse(response.text)), fetchedAt: await $.clock.now(), source: 'lookup' }
}

/** Reads the live account alone and shares the reading; what a switch and Claude Code's own readings ask for. */
async function refreshLive($: EngineInterface): Promise<void> {
  const liveUuid = await syncLive($)
  if (liveUuid === null) return
  await $.store.set(LIVE_LOOKUP_KEY, await $.clock.now())
  let reading: UsageView
  try {
    reading = await readingFor($, liveUuid, liveUuid)
  } catch (error) {
    reading = failedReading((await read($, usage))[liveUuid], error, await $.clock.now(), m)
  }
  await update($, usage, map => ({ ...map, [liveUuid]: reading }))
  await $.store.set(USAGE_KEY, { ...lookedUpOnly(await $.store.get(USAGE_KEY)), [liveUuid]: reading })
}

/** Shows the readings the last lookup, by any session on this machine, stored. */
async function adoptSharedUsage($: EngineInterface): Promise<void> {
  const stored = lookedUpOnly(await $.store.get(USAGE_KEY))
  await update($, usage, map => ({ ...lookedUpOnly(map), ...stored }))
}

/**
 * Reads every saved account's rate limits, one after another, and shares
 * them with the other sessions. `isAsked` is a lookup the person asked for:
 * it runs at once, past the shared schedule and any 429 wait.
 */
async function refreshAll($: EngineInterface, isAsked: boolean): Promise<void> {
  if (await read($, isRefreshing)) return
  const startedAt = await $.clock.now()
  let shared = readShared(await $.store.get(LOOKUP_KEY))
  if (!isAsked && !isAutomaticLookupDue(shared, startedAt)) {
    // Reusing another session's lookup still needs this session to know which account is live.
    await syncLive($)
    await adoptSharedUsage($)

    return
  }
  // Claim the slot before the requests go out, so a session ticking meanwhile reuses this lookup.
  shared = { ...shared, startedAt }
  await $.store.set(LOOKUP_KEY, shared)
  await update($, isRefreshing, () => true)
  let retryAfter: string | undefined
  let isRateLimited = false
  try {
    const liveUuid = await syncLive($)
    for (const account of await read($, accounts)) {
      try {
        const reading = await readingFor($, account.uuid, liveUuid)
        await update($, usage, map => ({ ...map, [account.uuid]: reading }))
      } catch (error) {
        if (error instanceof AnthropicError && error.status === 429) {
          isRateLimited = true
          retryAfter = error.retryAfter ?? retryAfter
        }
        const now = await $.clock.now()
        await update($, usage, map => ({ ...map, [account.uuid]: failedReading(map[account.uuid], error, now, m) }))
      }
    }
  } finally {
    await $.store.set(USAGE_KEY, lookedUpOnly(await read($, usage)))
    const now = await $.clock.now()
    await $.store.set(LOOKUP_KEY, isRateLimited ? afterRateLimit(shared, now, retryAfter) : afterSuccess(shared))
    await update($, isRefreshing, () => false)
  }
}

async function refresh($: EngineInterface, isAsked: boolean): Promise<void> {
  try {
    await refreshAll($, isAsked)
  } catch (error) {
    $.ui.toast(message(error))
  }
}

async function listText($: EngineInterface): Promise<string> {
  const list = await read($, accounts)
  const liveUuid = await read($, live)
  const readings = await read($, usage)
  const now = await $.clock.now()
  if (list.length === 0) return m.noAccounts

  return list
    .map((one, index) => {
      const reading = readings[one.uuid]
      const detail = reading?.error ?? describeLimits(reading?.limits ?? [], now, m.now, locale)

      return `${index + 1}. ${one.email}${one.uuid === liveUuid ? m.activeTag : ''}${reading?.isStale ? ` ${STALE_MARK}` : ''}  ${detail}`
    })
    .join('\n')
}

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  // The `showStatusBand` setting; a change in /config reloads the module with the new value.
  const isBandShown = options.showStatusBand !== false

  on('session.start', async ($, e, next) => {
    const { language } = await $.settings.read()
    const localeVariables = [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]
    locale = resolveLocale(language, localeVariables)
    m = messagesFor(locale)
    release = await readRelease($)
    $.ui.status(undefined)
    await loadIndex($)
    // Readings no lookup produced (a figure copied from another login, a message an older build kept) go.
    await update($, usage, map => lookedUpOnly(map))
    await $.store.set(USAGE_KEY, lookedUpOnly(await $.store.get(USAGE_KEY)))
    // Starting (a reload too) reuses a fresh shared lookup instead of making one of its own.
    void refresh($, false)
    // The status line command forwards this session's status to a file; follow it.
    const statusPath = `${await homeDirectory($)}/.claude/cache/statusline/${await $.session.id()}.json`
    $.clock.every(STATUS_POLL_MS, () => {
      void readStatus($, statusPath).catch((error: unknown) =>
        $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }),
      )
    })
    $.clock.every(TICK_MS, () => {
      void syncLive($)
        .catch((error: unknown) => $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }))
        .then(() => refresh($, false))
        .then(async () => {
          // The live account is kept current between Claude Code's own readings too.
          const lastLiveLookup = Number((await $.store.get(LIVE_LOOKUP_KEY)) ?? 0)
          const { backoffUntil } = readShared(await $.store.get(LOOKUP_KEY))
          const now = await $.clock.now()
          if (now >= backoffUntil && now - lastLiveLookup >= LIVE_POLL_MS) await refreshLive($)
        })
        .catch((error: unknown) => $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }))
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()

    return next(e)
  })

  // Claude Code's own response reported its windows. They are the live account's
  // only when this turn began after the live account last changed: a turn begun
  // before a switch was answered by the previous login, so its figures prompt a
  // lookup instead of being copied onto the account now live.
  on('session.measure', async ($, e, next) => {
    const liveUuid = await read($, live)
    if (liveUuid !== null && e.rateLimits.length > 0) {
      if (turnStartedAt > liveChangedAt) {
        const now = await $.clock.now()
        const reading = withMeasured((await read($, usage))[liveUuid], e.rateLimits, now)
        await update($, usage, map => ({ ...map, [liveUuid]: reading }))
        await $.store.set(USAGE_KEY, { ...lookedUpOnly(await $.store.get(USAGE_KEY)), [liveUuid]: reading })
            } else {
        void refreshLive($).catch((error: unknown) => $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }))
      }
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const query = rest.join(' ')
    try {
      if (verb === '') {
        // The release line, a five-line card per account, then the one-row footer below a blank line.
        const rows = Math.max(1, (await read($, accounts)).length) * 5 + 3
        await $.ui.open({ id: PANE, title: m.paneTitle, rows })

        return { text: m.paneOpened }
      }
      if (verb === 'list') return { text: await listText($) }
      if (verb === 'refresh') {
        await refresh($, true)

        return { text: await listText($) }
      }
      if (verb === 'add') return { text: m.addGuide }
      if (verb === 'band') {
        if (query !== 'on' && query !== 'off') return { text: m.bandUsage }
        const { deny } = await $.config.set({ key: BAND_SETTING, value: query === 'on' })

        return { text: deny ?? (query === 'on' ? m.bandShown : m.bandHidden) }
      }
      if (verb === 'use' || verb === 'remove') {
        const target = pick(await read($, accounts), query)
        if (!target) return { text: `${m.noMatch(query)}\n${await listText($)}` }

        return { text: verb === 'use' ? await switchTo($, target.uuid) : await remove($, target.uuid) }
      }

      return { text: m.unknownVerb(verb) }
    } catch (error) {
      return { text: `account-switch: ${message(error)}` }
    }
  })

  // The status on the band above the prompt, left-aligned, in two lines: what the
  // status line command forwards (context, model, effort, fast, task, place, PR),
  // then the live account, its usage with the pane's thin bars, and the lines
  // changed. Cells move to a new row when the band is too narrow.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !isBandShown) return next(e)
    const status = await read($, statusInfo)
    const liveUuid = await read($, live)
    const account = (await read($, accounts)).find(one => one.uuid === liveUuid)
    const reading = liveUuid ? (await read($, usage))[liveUuid] : undefined
    const windows = (reading?.limits ?? []).filter(limit => limit.label === '5h' || limit.label === 'wk')
    const contextUsed = (await $.session.usage()).context.percent ?? status?.contextUsed ?? null
    if (!status && contextUsed === null && (!account || windows.length === 0)) return next(e)

    return StatusBand($.ui.resolve(e), {
      status,
      account,
      reading,
      windows,
      contextUsed,
      now: await $.clock.now(),
      locale,
      room: Math.max(20, e.props.bodyColumns),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const bodyColumns = e.props.bodyColumns ?? 60
    const isBusy = await read($, isRefreshing)
    const act = (work: () => Promise<string | void>) => () => {
      void work()
        .then(text => text && $.ui.toast(text))
        .catch((error: unknown) => $.ui.toast(message(error)))
    }

    return (
      <Box flexDirection="column">
        {Header(ui, BRAND, release.version ? m.release(release.version, release.date) : undefined)}
        {AccountsTab(
          ui,
          {
            list: await read($, accounts),
            liveUuid: await read($, live),
            readings: await read($, usage),
            pendingConfirm: await read($, pendingConfirm),
            isGuideShown: await read($, isGuideOpen),
            now: await $.clock.now(),
            locale,
            m,
            bodyColumns,
          },
          {
            switchTo: uuid => act(() => switchTo($, uuid))(),
            arm: key => act(async () => {
              await update($, pendingConfirm, () => key)
            })(),
            remove: uuid =>
              act(async () => {
                await update($, pendingConfirm, () => null)

                return remove($, uuid)
              })(),
          },
        )}
        {Tiles(ui, bodyColumns, [
          { key: 'refresh', label: isBusy ? m.refreshingButton : m.refreshButton, isMain: true, onPress: act(() => refresh($, true)) },
          {
            key: 'add',
            label: m.addButton,
            onPress: act(async () => {
              await update($, isGuideOpen, shown => !shown)
            }),
          },
          { key: 'close', label: m.closeButton, isDismiss: true, onPress: act(() => $.ui.close({ id: PANE })) },
        ])}
      </Box>
    )
  })
}
