import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountsTabKey, AccountView, BandTarget, StatusInfo, UsageView } from '../types'
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
  parseSpend,
  parseUsage,
  refreshInit,
  usageInit,
} from './anthropic'
import { describeLimits, pick, releaseDateOf } from './format'
import { messagesFor, resolveLocale } from './i18n'
import { ChoiceDialog, Dialog, Header, InputDialog, paneTitle, TabBar, Tiles } from './shared/kit'
import { addRecords, asIndex, emptyIndex, localDay, parseScan, projectOf, scannedBytes, SCAN_SCRIPT, sessionOf, indexToStore, summarize } from './usage'
import type { UsageIndex } from './usage'
import { UsageTab } from './views/usage'
import { StorageTab } from './views/storage'
import { byteSize, cleanupPlan, cleanupTargets, sessionsOf, summarizeStorage } from './storage'
import type { StorageFile } from './storage'
import { removeTreeArgv } from './shared/files'
import { StatusCollector } from './collector'
import { changeKey, webhookRequest, webhookValues, DEFAULT_TEMPLATE_TEXT, parseConfig, renderTemplate, urlProblem, WEBHOOK_HEARTBEAT_MS, WEBHOOK_MIN_GAP_MS } from './webhook'
import type { WebhookConfig } from './webhook'
import { displayModel, editedPath, lineChanges, settledEffort } from './status'
import { WebhookDialog } from './views/webhook'
import { resetClock } from './shared/time'
import type { WebhookDraft } from './views/webhook'
import { AccountsTab, STALE_MARK } from './views/accounts'
import { isBesideOtherPanes } from './shared/panes'
import { StatusBand, toolboxCell } from './views/band'
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
import { serialQueue } from './queue'
import { isOwnSwitch, parseChanges, withChange } from './switchlog'
import type { LoginChange } from './switchlog'
import { deleteFileArgv, detectPlatform, privateWriteArgv, vaultFilePath } from './platform'
import type { Platform } from './platform'

const accounts = atom({ plugin: 'sc-accounts', key: 'accounts' } as const, [])
const usage = atom({ plugin: 'sc-accounts', key: 'usage' } as const, {})
const live = atom({ plugin: 'sc-accounts', key: 'live' } as const, null)
const dialog = atom({ plugin: 'sc-accounts', key: 'dialog' } as const, null)
const focused = atom({ plugin: 'sc-accounts', key: 'focused' } as const, null)
const isRefreshing = atom({ plugin: 'sc-accounts', key: 'isRefreshing' } as const, false)
const isGuideOpen = atom({ plugin: 'sc-accounts', key: 'isGuideOpen' } as const, false)
const statusInfo = atom({ plugin: 'sc-accounts', key: 'status' } as const, null)
const tick = atom({ plugin: 'sc-accounts', key: 'tick' } as const, 0)
const webhookDraft = atom({ plugin: 'sc-accounts', key: 'webhookDraft' } as const, null)
const webhookLast = atom({ plugin: 'sc-accounts', key: 'webhookLast' } as const, null)
const paneOpen = atom({ plugin: 'sc-accounts', key: 'paneOpen' } as const, false)
const tab = atom({ plugin: 'sc-accounts', key: 'tab' } as const, 'accounts')
const usagePeriod = atom({ plugin: 'sc-accounts', key: 'usagePeriod' } as const, 30)
const usageSummary = atom({ plugin: 'sc-accounts', key: 'usageSummary' } as const, null)
const usageScan = atom({ plugin: 'sc-accounts', key: 'usageScan' } as const, null)
const usageError = atom({ plugin: 'sc-accounts', key: 'usageError' } as const, null)
const storage = atom({ plugin: 'sc-accounts', key: 'storage' } as const, null)
const cleanupDays = atom({ plugin: 'sc-accounts', key: 'cleanupDays' } as const, 30)
/** The idle ages a cleanup offers, in days. */
const CLEANUP_DAYS = [7, 14, 30, 90]
/** Claude Code's own default for `cleanupPeriodDays`. */
const AUTO_CLEANUP_DEFAULT_DAYS = 30
/** How deep the Storage tab walks the projects folder: tool output sits in `<project>/<session>/tool-results/`. */
const STORAGE_DEPTH = 6
/** Project folders the Storage tab names: as many as it lists. */
const STORAGE_PROJECTS_NAMED = 8
/** Other folders the Storage tab lists, the largest first, and the smallest it lists. */
const STORAGE_FOLDERS_SHOWN = 8
const STORAGE_FOLDER_MIN_BYTES = 1024 * 1024
/** Paths one deletion command takes at a time. */
const DELETE_BATCH = 40
/** The periods the Usage tab offers, in days; 0 is everything counted. */
const USAGE_PERIODS = [7, 30, 0]
/** Bytes of transcripts one count reads before it lets the pane draw and goes on. */
const USAGE_SCAN_BYTES = 256 * 1024 * 1024
/** Rows the Accounts tab takes besides its cards: the header, the tab bar and its rule, the margins and the footer. */
const ACCOUNTS_CHROME_ROWS = 9
/** Rows the pane takes on its Usage tab. */
const USAGE_ROWS = 44
/** Whether the workspace's pane is open, as that plugin publishes it: with both open, the engine draws tabs. */
/** The toolbox's counts for its band cell; all zero when the toolbox is not installed. */
const toolboxSummary = atom({ plugin: 'sc-toolbox', key: 'summary' } as const, { running: 0, waiting: 0, failed: 0 })

const PANE = 'account-switch'
/** The workspace's command, which the band's lines changed toggle when no workspace hook takes the press. */
const WORKSPACE_COMMAND = 'sc:workspace'
/** The toolbox's command: the band's toolbox cell opens its quick tiles through it when its own hook did not take the press. */
const TOOLBOX_COMMAND = 'sc:toolbox'
/** The plugin's name, as `ui.press` names the plugin that drew a pressed Button. */
const PLUGIN = 'sc-accounts'

/** The band cell that toggles the accounts pane, the live account's name: `band-account`, then one Button per further coloured run. */
const BAND_ACCOUNT = 'band-account'

function isAccountCell(element: string): boolean {
  return element === BAND_ACCOUNT || element.startsWith(`${BAND_ACCOUNT}-`)
}
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
/** How often the session's status is read: the model, effort, branch, task and the rest the band shows. */
const STATUS_POLL_MS = 2000
/** The rows the webhook dialog takes whole: its fields, the variables and a preview of fourteen lines. */
const WEBHOOK_DIALOG_ROWS = 56
/** The `$.store` key of the webhook feed's settings, shared by every session on the machine. */
const WEBHOOK_KEY = 'webhook'
/** The `$.store` key of each session's lines added and removed, by session id. */
const LINES_KEY = 'lines'
/** How long after a /clear ends the old session the new one is taken up, once the engine has switched ids. */
const CLEAR_SETTLE_MS = 300
/** Lines counts kept this long after their session last changed them. */
const LINES_KEPT_MS = 7 * 24 * 60 * 60 * 1000
/** The largest file whose edit is counted; `$.fs.read` refuses bigger ones. */
const MAX_COUNTED_FILE = 4 * 1024 * 1024
/** How often the open pane redraws, so each account's "updated N min ago" is at most this late. */
const PANE_TICK_MS = 10 * 1000
let m: Messages = messagesFor(locale)
/** Whether this session has been told, once, that clicks need fullscreen mode. */
let isClickHintShown = false

/** Marks the click hint as shown when `text` carries it. */
function opened(text: string): string {
  if (text.includes(m.clickHint)) isClickHintShown = true

  return text
}

/** What the session's status is read from, set at session start. */
let collector: StatusCollector | null = null
let sessionId = ''
let sessionRoot = ''
let homePath = ''
/** Claude Code's config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`): its todos and transcripts. */
let configPath = ''
let hostname: string | null = null
let engineVersion: string | null = null
/** The effort and model the latest main-loop request named; null before the first. */
let requestEffort: string | null = null
/** The effort the settings named at the last status read: a change there (`/effort`) outranks the last request's. */
let lastSettledEffort: string | null | undefined
/** This session's lines added and removed by file-changing tool calls. */
let lines = { added: 0, removed: 0 }
/** The webhook feed's settings, as stored. */
let webhook: WebhookConfig = parseConfig(undefined)
/** What the feed last sent and when, so an unchanged status is not sent again until the heartbeat. */
let lastFeed = { key: '', at: 0 }
/** Whether a send is still waiting for its answer: a receiver that does not answer holds one send, never a queue. */
let isFeedSending = false
/** When Claude Code's config was last seen changed: a switch in any session rewrites it. */
let configSeenAt = 0

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

/** Where the webhook's bearer token is kept: its own keychain service, or an owner-only file. */
const WEBHOOK_SERVICE = 'sc-webhook'
const WEBHOOK_TOKEN_ACCOUNT = 'token'

async function webhookTokenPath($: EngineInterface): Promise<string> {
  return `${await claudeDirectory($)}/sc-accounts/webhook-token`
}

/** The webhook's bearer token, or null when none is kept. */
async function readWebhookToken($: EngineInterface): Promise<string | null> {
  const token =
    (await platformOf($)).backend === 'keychain'
      ? await findSecret($, WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT)
      : await readFileIfPresent($, await webhookTokenPath($))

  return token === null || token.trim() === '' ? null : token.trim()
}

/** Keeps the webhook's bearer token, through stdin as every secret here; never in a command line. */
async function writeWebhookToken($: EngineInterface, token: string): Promise<void> {
  if ((await platformOf($)).backend === 'keychain') await storeSecret($, WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT, token)
  else await writePrivateFile($, await webhookTokenPath($), token)
}

async function deleteWebhookToken($: EngineInterface): Promise<void> {
  const platform = await platformOf($)
  if (platform.backend === 'file') {
    const path = await webhookTokenPath($)
    if (!(await $.fs.exists(path))) return
    const { exitCode, stderr } = await $.process.run(deleteFileArgv(path, platform.isWindows), { timeoutMs: 5000 })
    if (exitCode !== 0) throw new Error(`cannot delete ${path}: ${stderr.trim()}`)

    return
  }
  const { exitCode, stderr } = await $.process.run(deleteArgv(WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT), { timeoutMs: 5000 })
  if (exitCode !== 0 && exitCode !== ITEM_NOT_FOUND) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
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
/** The read of the live login in progress, which every caller meanwhile shares: two at once would file one token twice. */
let syncing: Promise<string | null> | null = null

async function syncLive($: EngineInterface): Promise<string | null> {
  syncing ??= syncLiveOnce($).finally(() => {
    syncing = null
  })

  return syncing
}

async function syncLiveOnce($: EngineInterface): Promise<string | null> {
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
  const previous = await read($, live)
  if (previous !== account.accountUuid) {
    liveChangedAt = await $.clock.now()
    if (previous !== null) await noteChange($, previous, account)
  }
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

/** A file's text, or null when it is missing or too big to read. */
async function readSmallFile($: EngineInterface, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  const { size } = await $.fs.stat(path)

  return size > MAX_COUNTED_FILE ? null : $.fs.read(path)
}

/** The template file of the webhook feed, under Claude Code's config directory. */
async function templatePath($: EngineInterface): Promise<string> {
  return `${await claudeDirectory($)}/sc-accounts/webhook.json`
}

/** The template's text, written from the default first when the file is missing. */
async function readTemplate($: EngineInterface): Promise<string> {
  const path = await templatePath($)
  if (!(await $.fs.exists(path))) await $.fs.write(path, DEFAULT_TEMPLATE_TEXT)

  return $.fs.read(path)
}

/**
 * Follows a switch made in another session within one status read: when
 * Claude Code's config changed and names another login than this session's,
 * the live account is read again and the figures the switching session
 * stored are shown at once, rather than at the next minute's tick.
 */
async function followLogin($: EngineInterface): Promise<void> {
  const path = await globalConfigPath($)
  if (!(await $.fs.exists(path))) return
  const { mtimeMs } = await $.fs.stat(path)
  if (mtimeMs === configSeenAt) return
  configSeenAt = mtimeMs
  const configured = await liveOauthAccount($)
  if (configured === null || configured.accountUuid === (await read($, live))) return
  await syncLive($)
  await adoptSharedUsage($)
}

/** How long Claude Code keeps a keychain login cached when no credentials file tells it of a change. */
const KEYCHAIN_CACHE_MS = 35 * 1000

/**
 * From when a response's figures are the live account's: the moment it last
 * changed, and on macOS without a credentials file, the keychain cache after
 * it, during which a running session may still ask with the previous login.
 */
async function figuresTrustedFrom($: EngineInterface): Promise<number> {
  const cached = (await platformOf($)).backend === 'keychain' && !(await $.fs.exists(await liveCredentialPath($)))

  return liveChangedAt + (cached ? KEYCHAIN_CACHE_MS : 0)
}

/**
 * Keeps the live account's five-hour and weekly figures equal to the ones
 * this session's latest response reported, which need no lookup and no rate
 * limit. Only once a turn has begun since the live account last changed:
 * before that, the session's figures may be the previous login's. Written
 * when they differ from what is shown, or when the shown reading is a minute
 * old, so a figure filed wrongly is put right by the next response.
 */
async function adoptSessionFigures($: EngineInterface): Promise<void> {
  const liveUuid = await read($, live)
  if (liveUuid === null || turnStartedAt === 0 || turnStartedAt <= (await figuresTrustedFrom($))) return
  const windows = (await $.session.usage()).rateLimits.filter(window => window.kind === 'five_hour' || window.kind === 'seven_day')
  if (windows.length === 0) return
  const now = await $.clock.now()
  const current = (await read($, usage))[liveUuid]
  const next = withMeasured(current, windows, now)
  const shown = (reading: UsageView | undefined) =>
    JSON.stringify((reading?.limits ?? []).filter(limit => limit.label === '5h' || limit.label === 'wk'))
  if (shown(current) === shown(next) && current?.isStale !== true && now - (current?.fetchedAt ?? 0) < 60_000) return
  await update($, usage, map => ({ ...map, [liveUuid]: next }))
  await $.store.set(USAGE_KEY, { ...lookedUpOnly(await $.store.get(USAGE_KEY)), [liveUuid]: next })
}

/** Whether a status read is under way: a slow one (gh, a long transcript) is never overlapped by the next. */
let isCollecting = false

/** Reads the session's status: what the band draws and the webhook is sent. */
async function collectStatus($: EngineInterface): Promise<StatusInfo | null> {
  if (!collector || isCollecting) return null
  isCollecting = true
  try {
    return await collectStatusOnce($)
  } finally {
    isCollecting = false
  }
}

async function collectStatusOnce($: EngineInterface): Promise<StatusInfo | null> {
  if (!collector) return null
  await followLogin($).catch((error: unknown) => debugLog($, error))
  await adoptSessionFigures($).catch((error: unknown) => debugLog($, error))
  const cwd = await $.session.cwd()
  const modelId = await $.session.model()
  const settings = (await $.settings.read()) as { effortLevel?: unknown; modelSettings?: unknown; fastMode?: unknown }
  const settled = settledEffort(settings, modelId)
  if (lastSettledEffort !== undefined && settled !== lastSettledEffort) requestEffort = null
  lastSettledEffort = settled
  const branch = await collector.branch(cwd)
  const now = await $.clock.now()
  const [pr, task, ultracode] = await Promise.all([
    collector.pullRequest(cwd, branch, now),
    collector.task(configPath, sessionId),
    collector.transcript(configPath, sessionRoot, sessionId, now).then(path => collector?.ultracode(path) ?? false),
  ])
  const usageNow = await $.session.usage()
  const next: StatusInfo = {
    updatedAt: now,
    model: displayModel(modelId),
    effort: requestEffort ?? settled,
    ultracode,
    fast: settings.fastMode === true,
    contextUsed: usageNow.context.percent ?? null,
    task,
    dir: cwd.split('/').filter(Boolean).pop() ?? cwd,
    branch,
    pr,
    linesAdded: lines.added,
    linesRemoved: lines.removed,
  }
  const current = await read($, statusInfo)
  const { updatedAt: _was, ...currentRest } = current ?? { updatedAt: 0 }
  const { updatedAt: _now, ...nextRest } = next
  if (JSON.stringify(currentRest) !== JSON.stringify(nextRest)) await update($, statusInfo, () => next)
  await feedWebhook($, next, modelId, cwd, usageNow.cost?.usd ?? null).catch((error: unknown) => debugLog($, error))

  return next
}

/** The template filled with the session's status now, or why it cannot be. */
async function webhookBody($: EngineInterface, status: StatusInfo, modelId: string, cwd: string, cost: number | null) {
  const liveUuid = await read($, live)
  const account = (await read($, accounts)).find(one => one.uuid === liveUuid)
  const values = webhookValues({
    session: sessionId,
    now: await $.clock.now(),
    hostname,
    version: engineVersion,
    cwd,
    modelId,
    status,
    cost,
    account: account?.email ?? null,
    limits: liveUuid ? ((await read($, usage))[liveUuid]?.limits ?? []) : [],
  })

  return { values, rendered: renderTemplate(await readTemplate($), values) }
}

/** Sends the filled template by the config's method, with the token kept, and keeps how it went for the dialog. */
async function postWebhook($: EngineInterface, config: WebhookConfig, rendered: { body: string; value: unknown }): Promise<void> {
  const at = await $.clock.now()
  try {
    const { url, init } = webhookRequest(config, rendered, await readWebhookToken($))
    const response = await $.http.fetch(url, init)
    await update($, webhookLast, () => ({ at, status: response.status, error: null }))
  } catch (error) {
    await update($, webhookLast, () => ({ at, status: null, error: message(error) }))
  }
}

/** Sends the status when the feed is on and something changed, or the heartbeat is due; never twice in two seconds. */
async function feedWebhook($: EngineInterface, status: StatusInfo, modelId: string, cwd: string, cost: number | null): Promise<void> {
  // Read each time, so a save in any session applies to every session.
  webhook = parseConfig(await $.store.get(WEBHOOK_KEY))
  if (!webhook.enabled || urlProblem(webhook.url) !== null) return
  const now = await $.clock.now()
  if (now - lastFeed.at < WEBHOOK_MIN_GAP_MS) return
  const { values, rendered } = await webhookBody($, status, modelId, cwd, cost)
  if (!('body' in rendered)) return
  const key = changeKey(values)
  if (key === lastFeed.key && now - lastFeed.at < WEBHOOK_HEARTBEAT_MS) return
  if (isFeedSending) return
  lastFeed = { key, at: now }
  // Not awaited: the status reading never waits on the receiver.
  isFeedSending = true
  void postWebhook($, webhook, rendered).finally(() => {
    isFeedSending = false
  })
}

/** Adds an edit's lines to this session's count, kept in the store so a reload keeps it. */
async function countLines($: EngineInterface, change: { added: number; removed: number }): Promise<void> {
  if (change.added === 0 && change.removed === 0) return
  lines = { added: lines.added + change.added, removed: lines.removed + change.removed }
  const now = await $.clock.now()
  const kept = Object.entries(((await $.store.get(LINES_KEY)) ?? {}) as Record<string, { added: number; removed: number; at: number }>).filter(
    ([, entry]) => now - entry.at < LINES_KEPT_MS,
  )
  await $.store.set(LINES_KEY, { ...Object.fromEntries(kept), [sessionId]: { ...lines, at: now } })
}

function debugLog($: EngineInterface, error: unknown): void {
  $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' })
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

/**
 * A switch and each account's token work run one at a time in this session:
 * a lookup refreshing an account's token while a switch makes it the live
 * login would refresh it twice with one refresh token, and the rotation
 * would leave Claude Code holding a token already replaced.
 */
const exclusive = serialQueue()

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

/** The file that records every change of the live login, this mod's switches and the ones from outside it. */
async function changesPath($: EngineInterface): Promise<string> {
  return `${await claudeDirectory($)}/sc-accounts/login-changes.jsonl`
}

async function readChanges($: EngineInterface): Promise<string> {
  const path = await changesPath($)

  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

/** Adds a change to the record; a record that cannot be written never stops a switch. */
async function recordChange($: EngineInterface, change: Omit<LoginChange, 'at' | 'session' | 'cwd' | 'version'>): Promise<void> {
  try {
    const full: LoginChange = { at: await $.clock.now(), session: sessionId, cwd: await $.session.cwd(), version: release.version ?? '', ...change }
    await $.fs.write(await changesPath($), withChange(await readChanges($), full))
  } catch (error) {
    debugLog($, error)
  }
}

/** The changes of the live login this session has already said came from outside, so it says each once. */
const toldOutside = new Set<string>()

/**
 * A change of the live login this session found: recorded and said aloud when
 * no switch of this mod's, in any session, made it just before.
 */
async function noteChange($: EngineInterface, previousUuid: string, account: OauthAccount): Promise<void> {
  const now = await $.clock.now()
  if (isOwnSwitch(parseChanges(await readChanges($)), account.emailAddress, now)) return
  const from = (await read($, accounts)).find(one => one.uuid === previousUuid)?.email ?? null
  const key = `${from}>${account.emailAddress}@${Math.floor(now / OUTSIDE_SAY_MS)}`
  if (toldOutside.has(key)) return
  toldOutside.add(key)
  await recordChange($, { kind: 'outside', from, to: account.emailAddress })
  $.ui.toast(m.loginChangedOutside(from ?? '?', account.emailAddress))
}

/** How long one change from outside is said once, however many reads find it. */
const OUTSIDE_SAY_MS = 10 * 60 * 1000

/** Makes a saved account the one Claude Code logs in with. */
async function switchTo($: EngineInterface, uuid: string, via: 'dialog' | 'command'): Promise<string> {
  const target = (await read($, accounts)).find(one => one.uuid === uuid)
  if (!target) throw new Error('no saved account with that id')
  const fromUuid = await read($, live)
  // Recorded first, so every session that finds the login changed knows this switch made it.
  await recordChange($, { kind: 'switch', via, from: (await read($, accounts)).find(one => one.uuid === fromUuid)?.email ?? null, to: target.email })
  await exclusive(() => installLogin($, uuid, target.email))
  await refreshLive($)

  return m.switched(target.email)
}

/** Files the outgoing login and writes the saved one in its place: a switch's part that no lookup may overlap. */
async function installLogin($: EngineInterface, uuid: string, email: string): Promise<void> {
  // File the outgoing login first: Claude Code may have rotated its tokens.
  await syncLive($)
  const credential = await readVault($, uuid)
  const account = (await $.store.get(oauthAccountKey(uuid))) as OauthAccount | undefined
  if (credential === null || !account) throw new Error(`${email}: ${m.noStoredLogin}`)

  const fresh = await ensureFresh($, uuid, credential)
  await writeLiveCredential($, fresh)
  await writeLiveOauthAccount($, account)
  // Last, so a session that notices the change finds everything already in place.
  await writeLiveCredentialFile($, fresh)
  liveChangedAt = await $.clock.now()
  await update($, live, () => uuid)
}

async function remove($: EngineInterface, uuid: string): Promise<string> {
  const target = (await read($, accounts)).find(one => one.uuid === uuid)
  // The login Claude Code uses now, as well as this session's: another session may have just switched to it.
  if ((await read($, live)) === uuid || (await liveOauthAccount($))?.accountUuid === uuid) throw new Error(m.cannotRemoveLive)
  await deleteVault($, uuid)
  await $.store.delete(oauthAccountKey(uuid))
  await changeIndex($, list => list.filter(one => one.uuid !== uuid))
  const drop = (map: Record<string, UsageView>) => {
    const { [uuid]: _dropped, ...rest } = map

    return rest
  }
  await update($, usage, drop)
  // And from the readings every session shares, or another session would show it again.
  await $.store.set(USAGE_KEY, drop(lookedUpOnly(await $.store.get(USAGE_KEY))))

  return m.removed(target?.email ?? uuid)
}

// ── usage ─────────────────────────────────────────────────────────────────

/** The login changed between reading whose it is and looking it up: the answer would be another account's. */
class LoginChangedError extends Error {}

async function readingFor($: EngineInterface, uuid: string, liveUuid: string | null): Promise<UsageView> {
  let init
  if (uuid === liveUuid) {
    // The live login is Claude Code's to refresh, never this mod's: a refresh
    // rotates the token under Claude Code. Its token says whose usage comes back,
    // so it must still be the one filed under this account a moment ago.
    const credential = await readLiveCredential($)
    if (credential === null) throw new Error(m.noStoredLogin)
    const filed = await readVault($, uuid)
    if (filed?.claudeAiOauth.accessToken !== credential.claudeAiOauth.accessToken) throw new LoginChangedError(uuid)
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

  const body: unknown = JSON.parse(response.text)
  const spend = parseSpend(body)

  return { limits: parseUsage(body), fetchedAt: await $.clock.now(), source: 'lookup', ...(spend ? { spend } : {}) }
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
    if (error instanceof LoginChangedError) return
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
        const reading = await exclusive(async () => {
          // Whose login Claude Code uses now, read again for each account: a switch here or in another
          // session may have made this one live since the lookup began, and the live login is never refreshed here.
          const liveNow = (await liveOauthAccount($))?.accountUuid ?? liveUuid

          return readingFor($, account.uuid, liveNow)
        })
        await update($, usage, map => ({ ...map, [account.uuid]: reading }))
      } catch (error) {
        // Another session switched meanwhile: nothing is filed, and the next lookup reads the new login.
        if (error instanceof LoginChangedError) continue
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
  // Asked for, the band's model and effort are read again too.
  if (isAsked) void collectStatus($).catch((error: unknown) => debugLog($, error))
  try {
    await refreshAll($, isAsked)
  } catch (error) {
    $.ui.toast(message(error))
  }
}

// ── usage ──────────────────────────────────────────────────────────────────

/** The count of this machine's transcripts so far, read from its file once and kept. */
let usageIndex: UsageIndex | null = null
/** Every message id counted, as a set, read from the count's file once. */
let usageSeen: Set<string> | null = null
/** Whether a count is running: a second one asked meanwhile is dropped. */
let isCounting = false

async function usageIndexPath($: EngineInterface): Promise<string> {
  return `${await claudeDirectory($)}/sc-accounts/usage-index.json`
}

/** The file holding the `n`th part of the counted message ids. */
async function usageIdsPath($: EngineInterface, n: number): Promise<string> {
  return `${await claudeDirectory($)}/sc-accounts/usage-ids-${n}.json`
}

/** Writes the count: its ids in files of their own, then the index naming how many. */
async function saveUsageIndex($: EngineInterface, index: UsageIndex, ids: Iterable<string>): Promise<void> {
  const stored = indexToStore(index, [...ids])
  for (const [n, part] of stored.idFiles.entries()) await $.fs.write(await usageIdsPath($, n), JSON.stringify(part))
  await $.fs.write(await usageIndexPath($), JSON.stringify(stored.index))
}

async function loadUsageIndex($: EngineInterface): Promise<UsageIndex> {
  if (usageIndex) return usageIndex
  const path = await usageIndexPath($)
  try {
    if (!(await $.fs.exists(path))) usageIndex = emptyIndex()
    else {
      const raw = JSON.parse(await $.fs.read(path)) as { idFiles?: unknown }
      const index = asIndex(raw)
      // The ids live in files of their own; an index written before that holds them itself.
      const ids = [...index.ids]
      const parts = typeof raw.idFiles === 'number' ? raw.idFiles : 0
      for (let n = 0; n < parts; n += 1) ids.push(...(JSON.parse(await $.fs.read(await usageIdsPath($, n))) as string[]))
      usageIndex = { ...index, ids }
    }
  } catch (error) {
    // A file that does not parse is counted again from the start.
    debugLog($, error)
    usageIndex = emptyIndex()
  }

  return usageIndex
}

/** How deep transcripts sit under the projects folder: `<project>/<session>/subagents/<agent>.jsonl`. */
const TRANSCRIPT_DEPTH = 4

/**
 * Every transcript under the config directory with its size: each session's,
 * and each subagent's, which counts toward the session that started it.
 */
async function transcriptFiles($: EngineInterface): Promise<{ path: string; session: string; size: number }[]> {
  const root = `${await claudeDirectory($)}/projects`
  if (!(await $.fs.exists(root))) return []
  const files: { path: string; session: string; size: number }[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    for (const entry of await $.fs.list(`${root}/${relative}`)) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.kind === 'dir' && depth < TRANSCRIPT_DEPTH) await walk(child, depth + 1)
      else if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && depth >= 2) {
        files.push({ path: `${root}/${child}`, session: sessionOf(child), size: entry.size })
      }
    }
  }
  await walk('', 1)

  return files
}

/** The Usage tab's figures for its period, from the count so far. */
async function refreshUsageSummary($: EngineInterface): Promise<void> {
  const index = await loadUsageIndex($)
  const period = await read($, usagePeriod)
  const today = localDay(new Date(await $.clock.now()).toISOString())
  await update($, usageSummary, () => summarize(index, period === 0 ? null : period, today))
}

/**
 * Counts what the transcripts gained since the last count, up to
 * `USAGE_SCAN_BYTES` at a time, saying how far it has got; while the Usage tab
 * is on screen it goes on until every transcript is counted. With
 * `isToTheEnd` it counts everything in this call (before a cleanup deletes
 * transcripts, so their tokens are counted first).
 */
async function countUsage($: EngineInterface, isToTheEnd = false): Promise<string[]> {
  if (isCounting && !isToTheEnd) return []
  // A count to the end waits for one already running, then reads what it left.
  while (isCounting) await new Promise<void>(resolve => $.clock.after(200, resolve))
  isCounting = true
  try {
    await update($, usageError, () => null)
    let index = await loadUsageIndex($)
    const seen = usageSeen ?? new Set(index.ids)
    usageSeen = seen
    const all = await transcriptFiles($)
    const pending = all.filter(file => (index.files[file.path]?.offset ?? 0) < file.size)
    if (pending.length === 0) {
      await update($, usageScan, () => null)
      await refreshUsageSummary($)

      return []
    }
    // The progress is of every transcript: those counted before, in an earlier session too, are done.
    const total = all.length
    await update($, usageScan, () => ({ done: total - pending.length, total }))
    let budget = isToTheEnd ? Number.POSITIVE_INFINITY : USAGE_SCAN_BYTES
    let done = 0
    let hasMoved = false
    const failed: string[] = []
    for (const file of pending) {
      if (budget <= 0) break
      // A transcript is read a chunk at a time, so one of gigabytes never meets the time limit whole.
      let offset = index.files[file.path]?.offset ?? 0
      let isFailed = false
      while (offset < file.size && budget > 0) {
        const to = Math.min(file.size, offset + USAGE_SCAN_BYTES, offset + budget)
        const { exitCode, stdout, stderr } = await $.process.run(['sh', '-c', SCAN_SCRIPT, 'sh', file.path, String(to), String(offset + 1), String(to - offset)], {
          timeoutMs: 120_000,
        })
        if (exitCode === -1 && /failed to start|ENOENT/.test(stderr)) {
          await update($, usageError, () => m.usageNeedsShell)

          return [file.path]
        }
        if (exitCode !== 0) {
          debugLog($, new Error(`usage count of ${file.path} exited ${exitCode}: ${stderr.trim()}`))
          isFailed = true
          break
        }
        const next = offset + scannedBytes(stdout)
        index = addRecords(index, seen, file.path, file.session, parseScan(stdout), next)
        budget -= to - offset
        // Only a line still being written is left: the file is done for this pass.
        if (next === offset) break
        hasMoved = true
        offset = next
      }
      if (isFailed) failed.push(file.path)
      // A failed file counts as done for this pass, so the count never retries it without end.
      if (isFailed || budget > 0 || offset >= file.size) done += 1
    }
    usageIndex = index
    await saveUsageIndex($, index, seen)
    await refreshUsageSummary($)
    const left = pending.length - done
    const isShown = (await isPaneShown($)) && (await read($, tab)) === 'usage'
    if (left > 0 && hasMoved && isShown) {
      await update($, usageScan, () => ({ done: total - left, total }))
      $.clock.after(100, () => void countUsage($).catch((error: unknown) => debugLog($, error)))
    } else {
      await update($, usageScan, () => null)
    }

    return failed
  } finally {
    isCounting = false
  }
}

// ── storage ────────────────────────────────────────────────────────────────

/** The files under the projects folder as last measured, for the cleanup to choose from. */
let storageFiles: StorageFile[] = []

/** Every file under the projects folder, with its size and when it last changed. */
async function projectFiles($: EngineInterface, root: string): Promise<StorageFile[]> {
  if (!(await $.fs.exists(root))) return []
  const files: StorageFile[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    for (const entry of await $.fs.list(relative === '' ? root : `${root}/${relative}`)) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.kind === 'dir' && !entry.isLink && depth < STORAGE_DEPTH) await walk(child, depth + 1)
      else if (entry.kind === 'file') files.push({ relative: child, size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }
  await walk('', 1)

  return files
}

/** The sizes of the config directory's other folders, by `du`; none where there is no POSIX shell. */
async function otherFolders($: EngineInterface, directory: string): Promise<{ name: string; bytes: number }[]> {
  const names = (await $.fs.list(directory)).filter(entry => entry.kind === 'dir' && entry.name !== 'projects').map(entry => entry.name)
  if (names.length === 0) return []
  const { exitCode, stdout } = await $.process.run(['du', '-sk', '--', ...names.map(name => `${directory}/${name}`)], { timeoutMs: 60_000 })
  if (exitCode !== 0 && stdout.trim() === '') return []

  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 2 && /^\d+$/.test(parts[0] ?? ''))
    .map(([kb = '0', path = '']) => ({ name: path.slice(directory.length + 1), bytes: Number(kb) * 1024 }))
    .filter(folder => folder.bytes >= STORAGE_FOLDER_MIN_BYTES)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, STORAGE_FOLDERS_SHOWN)
}

/** The project a folder's newest session transcript worked in, read from its first `cwd`; undefined when none is found. */
async function recordedProject($: EngineInterface, root: string, folder: string, files: StorageFile[]): Promise<string | undefined> {
  const newest = files
    // A session's own transcript: a subagent's may have worked in a worktree of its own.
    .filter(file => file.relative.startsWith(`${folder}/`) && file.relative.endsWith('.jsonl') && file.relative.split('/').length === 2)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!newest) return undefined
  const { exitCode, stdout } = await $.process.run(['sh', '-c', 'head -c 262144 "$1" | grep -a -o -m 1 \'"cwd":"[^"]*"\'', 'sh', `${root}/${newest.relative}`], {
    timeoutMs: 10_000,
  })
  const cwd = exitCode === 0 ? /"cwd":"([^"]*)"/.exec(stdout)?.[1] : undefined

  return cwd ? projectOf(cwd.replace(/\\\\/g, '\\')) : undefined
}

/** Measures what the config directory holds, for the Storage tab. */
async function measureStorage($: EngineInterface): Promise<void> {
  const directory = await claudeDirectory($)
  const files = await projectFiles($, `${directory}/projects`)
  storageFiles = files
  const summary = summarizeStorage(files)
  // A folder is named after the project its sessions worked in, as the usage count recorded it.
  const index = await loadUsageIndex($)
  const votes = new Map<string, Map<string, number>>()
  for (const session of sessionsOf(files)) {
    const project = index.sessions[session.session]?.projects[0]
    if (!project) continue
    const tally = votes.get(session.folder) ?? new Map<string, number>()
    tally.set(project, (tally.get(project) ?? 0) + 1)
    votes.set(session.folder, tally)
  }
  const voted = (folder: string) => [...(votes.get(folder)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0]
  // A folder the count knows nothing of is named from the directory its newest transcript records.
  const names = new Map<string, string>()
  for (const project of summary.projects.slice(0, STORAGE_PROJECTS_NAMED)) {
    const name = voted(project.folder) ?? (await recordedProject($, `${directory}/projects`, project.folder, files))
    if (name) names.set(project.folder, name)
  }
  const nameOf = (folder: string) => names.get(folder) ?? folder
  const settings = (await $.settings.read()) as { cleanupPeriodDays?: unknown }
  const configured = typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : undefined
  let folders: { name: string; bytes: number }[] = []
  try {
    folders = await otherFolders($, directory)
  } catch (error) {
    debugLog($, error)
  }
  await update($, storage, () => ({
    ...summary,
    projects: summary.projects.map(project => ({ ...project, name: nameOf(project.folder) })),
    folders,
    autoDays: configured ?? AUTO_CLEANUP_DEFAULT_DAYS,
    isAutoDefault: configured === undefined,
    root: directory.replace(homePath, '~'),
  }))
}

/** The sessions a cleanup at the chosen age would delete, never this one. */
async function plannedCleanup($: EngineInterface) {
  return cleanupPlan(sessionsOf(storageFiles), await read($, cleanupDays), await $.clock.now(), [await $.session.id()])
}

/**
 * Deletes the sessions the cleanup chose: each transcript and the session's
 * folder. Every path is checked to lie under the projects folder first; one
 * that does not stops the whole cleanup before anything is deleted. The usage
 * figures already counted stay.
 */
async function cleanUp($: EngineInterface): Promise<string> {
  // Measured again now: a session resumed since the tab was drawn is no longer idle.
  await measureStorage($)
  const plan = await plannedCleanup($)
  if (plan.sessions.length === 0) return m.cleanupNothing(await read($, cleanupDays))
  // Every transcript is counted before any is deleted, so the usage figures keep their tokens;
  // one that could not be counted stops the cleanup.
  const uncounted = await countUsage($, true)
  if ((await read($, usageError)) !== null) throw new Error(m.usageNeedsShell)
  if (uncounted.length > 0) throw new Error(m.cleanupUncounted(uncounted.length))
  const root = `${await claudeDirectory($)}/projects`
  const paths = cleanupTargets(root, plan.sessions.flatMap(session => session.paths))
  const { isWindows } = await platformOf($)
  for (let start = 0; start < paths.length; start += DELETE_BATCH) {
    const { exitCode, stderr } = await $.process.run(removeTreeArgv(paths.slice(start, start + DELETE_BATCH), isWindows), { timeoutMs: 120_000 })
    if (exitCode !== 0) throw new Error(`deleting sessions exited ${exitCode}: ${stderr.trim()}`)
  }
  // The count forgets the deleted transcripts' offsets; their tokens stay counted.
  const index = await loadUsageIndex($)
  const gone = (file: string) => paths.some(path => file === path || file.startsWith(`${path}/`))
  usageIndex = { ...index, files: Object.fromEntries(Object.entries(index.files).filter(([file]) => !gone(file))) }
  await saveUsageIndex($, usageIndex, usageSeen ?? new Set(usageIndex.ids))
  await measureStorage($)

  return m.cleanedUp(plan.sessions.length, byteSize(plan.bytes))
}

/** Whether the pane is among the engine's panes. */
async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

/** Shows a tab of the pane, sized to it; the Usage tab counts what the transcripts gained. */
async function showTab($: EngineInterface, next: AccountsTabKey): Promise<void> {
  await update($, tab, () => next)
  await openPane($)
  if (next === 'usage') {
    await refreshUsageSummary($)
    await countUsage($)
  }
  if (next === 'storage') await measureStorage($)
}

/**
 * Opens the accounts pane, sized to its cards: the release line, five rows per
 * account, then the footer below a blank line; or to `rows`, for a dialog
 * taller than that. With `focus` it takes the keys, and Esc asks it to close.
 */
// The pane is opened only by what the person did (a command, a button, the band), so it takes the keyboard:
// with no mouse, as off fullscreen mode, nothing else hands it the keys.
async function openPane($: EngineInterface, focus = true, rows?: number): Promise<void> {
  // Five rows a card, and around the cards the header, the tab bar, its rule, the margins and the
  // footer; the Usage and Storage tabs take their figures and charts.
  const wanted = rows ?? ((await read($, tab)) !== 'accounts' ? USAGE_ROWS : Math.max(1, (await read($, accounts)).length) * 5 + ACCOUNTS_CHROME_ROWS)
  await $.ui.open({ id: PANE, title: TAB_LABEL, rows: wanted, ...(focus ? { focus: true, closeOnEscape: true } : {}) })
  if (!(await read($, paneOpen))) await update($, paneOpen, () => true)
}

/** The mod's name in the pane's title; a name, so it is never translated. */
const MOD_NAME = 'Accounts'

/** Closes the pane and says so at once: the engine raises no ui.close to the plugin that asked. */
async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  if (await read($, paneOpen)) await update($, paneOpen, () => false)
}

/** Brings `paneOpen` in line with the panes the engine holds, however the pane was closed. */
async function syncPaneOpen($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if ((await read($, paneOpen)) !== isOpen) await update($, paneOpen, () => isOpen)

  return isOpen
}

/** The pane's label on the engine's tab row, shown while another pane is open beside it. */
const TAB_LABEL = 'Accounts'

/**
 * What a band cell toggles: the accounts pane (the account's name), or the
 * workspace on its Diff tab (the place and the lines changed), through the
 * workspace's own command since another plugin's panes are not this one's.
 */
async function toggle($: EngineInterface, target: BandTarget): Promise<void> {
  if (target === 'workspace') {
    // Queued until the session is idle; not awaited, so the press returns at once.
    void $.command.run({ command: WORKSPACE_COMMAND, args: 'toggle diff' }).catch((error: unknown) => $.ui.toast(message(error)))

    return
  }
  if (target === 'toolbox') {
    void $.command.run({ command: TOOLBOX_COMMAND, args: 'quick' }).catch((error: unknown) => $.ui.toast(message(error)))

    return
  }
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  // Only a pane in view closes. One behind another pane's tab, or waiting undrawn
  // from an open nobody asked for, is opened afresh: in front, and placed.
  if (pane?.isShown && pane.isPlaced) {
    // A dialog left asking would greet the next open.
    if ((await read($, dialog)) !== null) await update($, dialog, () => null)
    await closePane($)

    return
  }
  if (pane) await $.ui.close({ id: PANE })
  await openPane($, true)
}

/** Opens the webhook dialog in the accounts pane, the settings as stored in its draft; the template file is written first when missing. */
async function openWebhookDialog($: EngineInterface): Promise<void> {
  const config = parseConfig(await $.store.get(WEBHOOK_KEY))
  const hasToken = (await readWebhookToken($)) !== null
  await readTemplate($)
  await update($, webhookDraft, () => ({ ...config, token: '', hasToken, clearToken: false }))
  await update($, dialog, () => ({ kind: 'webhook' }) as const)
  await openPane($, true, WEBHOOK_DIALOG_ROWS)
}

/** The draft as a config, its URL trimmed. */
function draftConfig(draft: WebhookDraft): WebhookConfig {
  return { enabled: draft.enabled, url: draft.url.trim(), method: draft.method }
}

/** The status to fill the template with: the latest read, or one read now. */
async function currentStatus($: EngineInterface): Promise<StatusInfo | null> {
  return (await read($, statusInfo)) ?? (await collectStatus($))
}

/** What the dialog previews: the request the draft would make now, or why it makes none. */
async function webhookPreview($: EngineInterface, draft: WebhookDraft): Promise<{ body: string } | { problem: string }> {
  const status = await currentStatus($)
  if (!status) return { problem: m.webhookTemplateMissing }
  const { rendered } = await webhookBody($, status, await $.session.model(), await $.session.cwd(), (await $.session.usage()).cost?.usd ?? null)
  if ('invalid' in rendered) return { problem: m.webhookTemplateInvalid(rendered.invalid) }
  if ('unknown' in rendered) return { problem: m.webhookTemplateUnknown(rendered.unknown.join(', ')) }
  const config = draftConfig(draft)
  if (config.method === 'GET' && urlProblem(config.url) === null) return { body: `GET ${webhookRequest(config, rendered, null).url}` }

  return { body: JSON.stringify(rendered.value, null, 2) }
}

/** Saves the draft: the settings to the store, the token to its secret store; refused with a reason when the URL cannot be sent to. */
async function saveWebhook($: EngineInterface, draft: WebhookDraft): Promise<string> {
  const config = draftConfig(draft)
  if (config.enabled && urlProblem(config.url) !== null) throw new Error(urlMessage(urlProblem(config.url)) ?? '')
  if (draft.clearToken) await deleteWebhookToken($)
  if (draft.token.trim() !== '') await writeWebhookToken($, draft.token.trim())
  await $.store.set(WEBHOOK_KEY, config)
  webhook = config
  lastFeed = { key: '', at: 0 }

  return config.enabled ? m.webhookOn : m.webhookOff
}

/** Sends the draft once, the token typed or kept, and keeps how it went. */
async function testWebhook($: EngineInterface, draft: WebhookDraft): Promise<void> {
  const config = draftConfig(draft)
  const problem = urlProblem(config.url)
  if (problem !== null) throw new Error(urlMessage(problem) ?? '')
  const status = await currentStatus($)
  if (!status) throw new Error(m.webhookTemplateMissing)
  const { rendered } = await webhookBody($, status, await $.session.model(), await $.session.cwd(), (await $.session.usage()).cost?.usd ?? null)
  if (!('body' in rendered)) throw new Error('invalid' in rendered ? m.webhookTemplateInvalid(rendered.invalid) : m.webhookTemplateUnknown(rendered.unknown.join(', ')))
  const typed = draft.token.trim()
  const token = draft.clearToken ? null : typed !== '' ? typed : await readWebhookToken($)
  const at = await $.clock.now()
  try {
    const { url, init } = webhookRequest(config, rendered, token)
    const response = await $.http.fetch(url, init)
    await update($, webhookLast, () => ({ at, status: response.status, error: null }))
  } catch (error) {
    await update($, webhookLast, () => ({ at, status: null, error: message(error) }))
  }
}

function urlMessage(problem: ReturnType<typeof urlProblem>): string | null {
  if (problem === 'empty') return m.webhookUrlEmpty
  if (problem === 'scheme') return m.webhookUrlScheme
  if (problem === 'invalid') return m.webhookUrlInvalid

  return null
}

/**
 * Fills the state a session draws from: the accounts, the live one and its
 * usage, this session's lines changed, and whether the pane is open. Run at
 * session start, and again after a /clear, whose new session starts with none.
 */
async function adoptSession($: EngineInterface): Promise<void> {
  sessionId = await $.session.id()
  const savedLines = (((await $.store.get(LINES_KEY)) ?? {}) as Record<string, { added: number; removed: number }>)[sessionId]
  lines = { added: savedLines?.added ?? 0, removed: savedLines?.removed ?? 0 }
  requestEffort = null
  lastSettledEffort = undefined
  lastFeed = { key: '', at: 0 }
  await loadIndex($)
  // The machine's shared readings, under what this session already holds.
  const shared = lookedUpOnly(await $.store.get(USAGE_KEY))
  await update($, usage, map => lookedUpOnly({ ...shared, ...map }))
  await syncPaneOpen($)
  // A fresh shared lookup is reused rather than one of the session's own.
  void syncLive($)
    .then(() => refresh($, false))
    .catch((error: unknown) => debugLog($, error))
  void collectStatus($).catch((error: unknown) => debugLog($, error))
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
    // Readings no lookup produced (a figure copied from another login, a message an older build kept) go.
    await $.store.set(USAGE_KEY, lookedUpOnly(await $.store.get(USAGE_KEY)))
    // The session's status: read every two seconds from the engine, git, gh and the transcript.
    sessionRoot = await $.session.root()
    homePath = await homeDirectory($)
    configPath = await claudeDirectory($)
    engineVersion = (await $.session.version()).version
    const host = await $.process.run(['hostname'], { timeoutMs: 2000 })
    hostname = host.exitCode === 0 ? host.stdout.trim() : null
    webhook = parseConfig(await $.store.get(WEBHOOK_KEY))
    await adoptSession($)
    collector = new StatusCollector({
      run: (argv, init) => $.process.run(argv, init),
      read: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : null),
      list: async path => ((await $.fs.exists(path)) ? $.fs.list(path) : []),
      size: async path => ((await $.fs.exists(path)) ? (await $.fs.stat(path)).size : null),
    })
    $.clock.every(STATUS_POLL_MS, () => {
      void collectStatus($).catch((error: unknown) => debugLog($, error))
    })
    $.clock.every(PANE_TICK_MS, () => {
      void (async () => {
        if (!(await syncPaneOpen($))) return
        const now = await $.clock.now()
        await update($, tick, () => now)
      })().catch((error: unknown) => $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }))
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

  // A /clear goes on in this process under a new session id, and no session.start fires for
  // it: the new session's state is filled here, once the old one has ended.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_SETTLE_MS, () => {
        void adoptSession($).catch((error: unknown) => debugLog($, error))
      })
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()

    return next(e)
  })

  // The effort each main-loop request asks for, as the engine settled it (a subagent's are its own).
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) requestEffort = e.effort === undefined ? null : String(e.effort)

    return yield* next(e)
  })

  // Lines a file-changing tool call adds and removes: the file before and after, compared.
  on('tool.call', async ($, e, next) => {
    const path = editedPath(String(e.tool), e)
    if (path === null) return next(e)
    const before = await readSmallFile($, path).catch(() => undefined)
    const result = await next(e)
    if (before !== undefined && !('deny' in result) && !(result as { isError?: boolean }).isError) {
      const after = await readSmallFile($, path).catch(() => undefined)
      if (after !== undefined) await countLines($, lineChanges(before, after)).catch((error: unknown) => debugLog($, error))
    }

    return result
  })

  // Claude Code's own response reported its windows. They are the live account's
  // only when this turn began after the live account last changed, and when the
  // login Claude Code is configured with is still the one this session knows: a
  // switch made in another session reaches every session's requests at once but
  // this session's `live` only at its next tick, and the new login's figures must
  // never be filed under the account it replaced. Otherwise the account is read
  // again and looked up instead.
  on('session.measure', async ($, e, next) => {
    const liveUuid = await read($, live)
    if (liveUuid !== null && e.rateLimits.length > 0) {
      const configured = await liveOauthAccount($).catch((error: unknown) => {
        // An unreadable config names no account: the figures are not filed.
        debugLog($, error)

        return null
      })
      if (configured?.accountUuid !== liveUuid) {
        void syncLive($)
          .then(() => refreshLive($))
          .catch((error: unknown) => $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' }))
      } else if (turnStartedAt > (await figuresTrustedFrom($))) {
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
    // Off fullscreen no click reaches a pane: the first pane a command opens says how to press without one.
    const hint = e.presentation?.isFullscreen === false && !isClickHintShown ? ` ${m.clickHint}` : ''
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const query = rest.join(' ')
    try {
      if (verb === '' || verb === 'accounts') {
        // The command opens the accounts themselves, on their own tab: a dialog left open is closed first.
        if ((await read($, dialog)) !== null) {
          await update($, dialog, () => null)
          await update($, webhookDraft, () => null)
        }
        await showTab($, 'accounts')

        return { text: opened(m.paneOpened + hint) }
      }
      if (verb === 'usage' || verb === 'storage') {
        await showTab($, verb)

        return { text: opened(m.paneOpened + hint) }
      }
      if (verb === 'list') return { text: await listText($) }
      if (verb === 'refresh') {
        await refresh($, true)

        return { text: await listText($) }
      }
      if (verb === 'add') return { text: m.addGuide }
      if (verb === 'webhook') {
        await openWebhookDialog($)

        return { text: opened(m.paneOpened + hint) }
      }
      if (verb === 'band') {
        if (query !== 'on' && query !== 'off') return { text: m.bandUsage }
        const { deny } = await $.config.set({ key: BAND_SETTING, value: query === 'on' })

        return { text: deny ?? (query === 'on' ? m.bandShown : m.bandHidden) }
      }
      if (verb === 'use' || verb === 'remove') {
        const target = pick(await read($, accounts), query)
        if (!target) return { text: `${m.noMatch(query)}\n${await listText($)}` }

        return { text: verb === 'use' ? await switchTo($, target.uuid, 'command') : await remove($, target.uuid) }
      }

      return { text: m.unknownVerb(verb) }
    } catch (error) {
      return { text: `account-switch: ${message(error)}` }
    }
  })

  // The status on the band above the prompt, left-aligned under a dim rule: the
  // model, effort, fast mode and task, the live account, the context and usage
  // gauges, the place and PR, and the lines changed. Cells move to a new row
  // when the band is too narrow.
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
      toolbox: toolboxCell(await read($, toolboxSummary)),
      // The ui.press hook below takes the account, and the workspace's the place and the lines;
      // this runs for a press neither took (the workspace without its hook).
      onPress: target => {
        void toggle($, target).catch((error: unknown) => $.ui.toast(message(error)))
      },
    })
  })

  // A band press is taken here, inside the person's press, and toggled before the chain
  // settles: a pane opened there counts as asked for and is placed at any width.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== PLUGIN || e.component !== 'AbovePrompt' || !isAccountCell(e.element)) return next(e)
    await toggle($, 'accounts')

    return { element: e.element }
  })

  // Where the keyboard is in the pane, so the dialog's outlined tiles can show it.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE) await update($, focused, () => e.element ?? null)

    return result
  })

  // Esc (or the close mark) while the dialog asks cancels the dialog and keeps the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, dialog)) !== null) {
      const wasWebhook = (await read($, dialog))?.kind === 'webhook'
      await update($, dialog, () => null)
      await update($, focused, () => null)
      if (wasWebhook) await openPane($, true)

      return { value: undefined }
    }
    const result = await next(e)
    if (e.id === PANE && (await read($, paneOpen))) await update($, paneOpen, () => false)

    return result
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
    // With another mod's pane open beside it, the engine draws a tab row above the header.
    const isUnderTabs = isBesideOtherPanes('sc-accounts', {
      'sc-accounts': (await $.state.get({ plugin: 'sc-accounts', key: 'paneOpen' })).value === true,
      'sc-workspace': (await $.state.get({ plugin: 'sc-workspace', key: 'paneOpen' })).value === true,
      'sc-toolbox': (await $.state.get({ plugin: 'sc-toolbox', key: 'paneOpen' })).value === true,
    })
    const header = {
      brand: paneTitle(MOD_NAME),
      release: release.version ? m.release(release.version, release.date) : undefined,
      isUnderTabs,
      columns: bodyColumns,
      exit: { label: `✕ ${m.closeButton}`, onPress: () => void closePane($).catch((error: unknown) => $.ui.toast(message(error))) },
      backLabel: m.backButton,
    }
    // A dialog takes the whole pane: the header, then the dialog.
    const asked = await read($, dialog)
    const dismiss = async () => {
      await update($, dialog, () => null)
      await update($, focused, () => null)
    }
    const draft = await read($, webhookDraft)
    if (asked?.kind === 'webhook' && draft) {
      const edit = (change: (current: WebhookDraft) => WebhookDraft) =>
        act(async () => {
          await update($, webhookDraft, current => (current ? change(current) : current))
        })
      const last = await read($, webhookLast)
      const now = await $.clock.now()
      const clock = (at: number) => resetClock(new Date(at).toISOString(), now, locale)
      const config = draftConfig(draft)
      const problem = config.enabled || config.url !== '' ? urlMessage(urlProblem(config.url)) : null

      return WebhookDialog(
        ui,
        {
          draft,
          templatePath: (await templatePath($)).replace(homePath, '~'),
          preview: await webhookPreview($, draft),
          urlProblem: problem,
          lastSend: last
            ? last.error === null && last.status !== null
              ? { text: m.webhookSent(clock(last.at), last.status), ok: last.status >= 200 && last.status < 300 }
              : { text: m.webhookFailed(clock(last.at), last.error ?? `HTTP ${last.status}`), ok: false }
            : null,
          hasField: e.surface !== 'mobile',
          m,
          bodyColumns,
          header,
          focused: await read($, focused),
        },
        {
          toggle: edit(current => ({ ...current, enabled: !current.enabled })),
          toggleMethod: edit(current => ({ ...current, method: current.method === 'POST' ? 'GET' : 'POST' })),
          setUrl: url => edit(current => ({ ...current, url }))(),
          setToken: token => edit(current => ({ ...current, token, clearToken: false }))(),
          clearToken: edit(current => ({ ...current, token: '', clearToken: true })),
          test: act(() => testWebhook($, draft)),
          // Back on the cards, the pane takes their height again.
          save: act(async () => {
            const text = await saveWebhook($, draft)
            await update($, webhookDraft, () => null)
            await dismiss()
            await openPane($, true)

            return text
          }),
          cancel: act(async () => {
            await update($, webhookDraft, () => null)
            await dismiss()
            await openPane($, true)
          }),
        },
      )
    }
    if (asked?.kind === 'period') {
      const current = await read($, usagePeriod)

      return ChoiceDialog(
        ui,
        bodyColumns,
        header,
        m.usagePeriodTitle,
        USAGE_PERIODS.map(days => ({
          key: `period-${days}`,
          label: m.usagePeriod(days),
          isCurrent: days === current,
          onPress: act(async () => {
            await dismiss()
            await update($, usagePeriod, () => days)
            await refreshUsageSummary($)
            await openPane($)
          }),
        })),
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
      )
    }
    if (asked?.kind === 'cleanupDays') {
      const current = await read($, cleanupDays)

      return ChoiceDialog(
        ui,
        bodyColumns,
        header,
        m.cleanupDaysTitle,
        CLEANUP_DAYS.map(days => ({
          key: `cleanup-days-${days}`,
          label: m.cleanupDays(days),
          isCurrent: days === current,
          onPress: act(async () => {
            await dismiss()
            await update($, cleanupDays, () => days)
            await openPane($)
          }),
        })),
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
      )
    }
    if (asked?.kind === 'cleanup') {
      const days = await read($, cleanupDays)
      const plan = await plannedCleanup($)

      // Deleting sessions cannot be undone, so the word has to be typed, not a button pressed.
      return InputDialog(
        ui,
        bodyColumns,
        header,
        m.cleanupTitle(plan.sessions.length, byteSize(plan.bytes)),
        [
          { text: m.cleanupWhat(days) },
          { text: m.cleanupKeeps, tone: 'muted' },
          { text: m.cleanupNoResume, tone: 'danger' },
          { text: m.cleanupTypeHint(m.cleanupWord) },
        ],
        {
          key: 'cleanup-word',
          placeholder: m.cleanupPlaceholder(m.cleanupWord),
          submitLabel: m.cleanupConfirm,
          hasField: e.surface !== 'mobile',
          noInput: m.cleanupNoField,
          onSubmit: value => {
            // A word typed wrong deletes nothing and leaves the dialog asking.
            if (value.trim() !== m.cleanupWord) {
              $.ui.toast(m.cleanupMismatch(m.cleanupWord))

              return
            }
            act(async () => {
              await dismiss()
              await openPane($)

              return cleanUp($)
            })()
          },
        },
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
      )
    }
    // A removal in question.
    const switching = asked?.kind === 'switch' ? (await read($, accounts)).find(one => one.uuid === asked.uuid) : undefined
    if (switching) {
      // Cancel holds the keyboard first: an Enter meant for the prompt never switches every session's login.
      return Dialog(
        ui,
        bodyColumns,
        header,
        m.switchTitle(switching.email),
        [{ text: m.switchHint, tone: 'muted' }],
        {
          label: m.switchButton,
          onPress: act(async () => {
            await dismiss()

            return switchTo($, switching.uuid, 'dialog')
          }),
        },
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
        'cancel',
      )
    }
    const target = asked?.kind === 'remove' ? (await read($, accounts)).find(one => one.uuid === asked.uuid) : undefined
    if (asked && target) {

      return Dialog(
        ui,
        bodyColumns,
        header,
        m.removeTitle(target.email),
        [{ text: m.removeHint, tone: 'muted' }],
        {
          label: m.removeConfirm,
          onPress: act(async () => {
            await dismiss()

            return remove($, target.uuid)
          }),
        },
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
        'cancel',
      )
    }

    const active = await read($, tab)
    const accountRows = await read($, accounts)
    const tabs = [
      { key: 'accounts', label: m.tabAccounts, hotkey: '1', badge: accountRows.length > 0 ? `${accountRows.length}` : undefined },
      { key: 'usage', label: m.tabUsage, hotkey: '2' },
      { key: 'storage', label: m.tabStorage, hotkey: '3' },
    ]
    const select = (key: string) => act(() => showTab($, key as AccountsTabKey))()
    if (active === 'storage') {
      return (
        <Box flexDirection="column">
          {Header(ui, header)}
          {TabBar(ui, tabs, active, select)}
            <Box key="body-storage" flexDirection="column" marginTop={1}>
            {StorageTab(
              ui,
              { storage: await read($, storage), cleanupDays: await read($, cleanupDays), now: await $.clock.now(), locale, m, bodyColumns },
              {
                chooseDays: act(async () => {
                  await update($, dialog, () => ({ kind: 'cleanupDays' }) as const)
                  await openPane($, true)
                }),
                cleanUp: act(async () => {
                  // The dialog names what a cleanup would delete as measured now.
                  await measureStorage($)
                  const plan = await plannedCleanup($)
                  // Nothing to delete asks nothing.
                  if (plan.sessions.length === 0) return m.cleanupNothing(await read($, cleanupDays))
                  await update($, dialog, () => ({ kind: 'cleanup' }) as const)
                  await openPane($, true)
                }),
              },
            )}
          </Box>
          {Tiles(ui, bodyColumns, [{ key: 'refresh', label: m.refreshButton, isMain: true, onPress: act(() => measureStorage($)) }])}
        </Box>
      )
    }
    if (active === 'usage') {
      return (
        <Box flexDirection="column">
          {Header(ui, header)}
          {TabBar(ui, tabs, active, select)}
            <Box key="body-usage" flexDirection="column" marginTop={1}>
            {UsageTab(
              ui,
              {
                summary: await read($, usageSummary),
                scan: await read($, usageScan),
                error: await read($, usageError),
                period: await read($, usagePeriod),
                m,
                bodyColumns,
              },
              {
                choosePeriod: act(async () => {
                  await update($, dialog, () => ({ kind: 'period' }) as const)
                  await openPane($, true)
                }),
              },
            )}
          </Box>
          {Tiles(ui, bodyColumns, [
            { key: 'refresh', label: (await read($, usageScan)) ? m.refreshingButton : m.refreshButton, isMain: true, onPress: act(() => countUsage($).then(() => undefined)) }
          ])}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {Header(ui, header)}
        {TabBar(ui, tabs, active, select)}
        {AccountsTab(
          ui,
          {
            list: await read($, accounts),
            liveUuid: await read($, live),
            readings: await read($, usage),
            isGuideShown: await read($, isGuideOpen),
            // Reading the tick subscribes the pane to it, so the ages move on while it is open.
            now: Math.max(await $.clock.now(), await read($, tick)),
            locale,
            m,
            bodyColumns,
          },
          {
            // Switching changes every session's login, so it asks first, Cancel holding the keyboard.
            switchTo: uuid =>
              act(async () => {
                await update($, dialog, () => ({ kind: 'switch', uuid }) as const)
                await openPane($, true)
              })(),
            remove: uuid =>
              act(async () => {
                await update($, dialog, () => ({ kind: 'remove', uuid }) as const)
                // The pane takes the keys so Enter answers; Esc asks it to close, which the
                // ui.close hook turns into Cancel.
                await openPane($, true)
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
          { key: 'webhook', label: m.webhookButton, onPress: act(() => openWebhookDialog($)) },
          ])}
      </Box>
    )
  })
}
