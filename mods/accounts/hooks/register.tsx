import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountView, BandTarget, StatusInfo, UsageView } from '../types'
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
import { Dialog, Header, Tiles } from './shared/kit'
import { StatusCollector, transcriptPath } from './collector'
import { changeKey, webhookRequest, webhookValues, DEFAULT_TEMPLATE_TEXT, parseConfig, renderTemplate, urlProblem, WEBHOOK_HEARTBEAT_MS, WEBHOOK_MIN_GAP_MS } from './webhook'
import type { WebhookConfig } from './webhook'
import { displayModel, editedPath, lineChanges, settledEffort } from './status'
import { WebhookDialog } from './views/webhook'
import { resetClock } from './shared/time'
import type { WebhookDraft } from './views/webhook'
import { AccountsTab, STALE_MARK } from './views/accounts'
import { StatusBand } from './views/band'
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
const dialog = atom({ plugin: 'sc-accounts', key: 'dialog' } as const, null)
const focused = atom({ plugin: 'sc-accounts', key: 'focused' } as const, null)
const isRefreshing = atom({ plugin: 'sc-accounts', key: 'isRefreshing' } as const, false)
const isGuideOpen = atom({ plugin: 'sc-accounts', key: 'isGuideOpen' } as const, false)
const statusInfo = atom({ plugin: 'sc-accounts', key: 'status' } as const, null)
const tick = atom({ plugin: 'sc-accounts', key: 'tick' } as const, 0)
const webhookDraft = atom({ plugin: 'sc-accounts', key: 'webhookDraft' } as const, null)
const webhookLast = atom({ plugin: 'sc-accounts', key: 'webhookLast' } as const, null)
const paneOpen = atom({ plugin: 'sc-accounts', key: 'paneOpen' } as const, false)
/** Whether the workspace's pane is open, as that plugin publishes it: with both open, the engine draws tabs. */
const workspacePaneOpen = { plugin: 'sc-workspace', key: 'paneOpen' } as const

const PANE = 'account-switch'
/** The workspace's command, which the band's lines changed toggle when no workspace hook takes the press. */
const WORKSPACE_COMMAND = 'sc:workspace'
/** The plugin's name, as `ui.press` names the plugin that drew a pressed Button. */
const PLUGIN = 'sc-accounts'

/** The band cell that toggles the accounts pane, the live account's name: `band-account`, then one Button per further coloured run. */
const BAND_ACCOUNT = 'band-account'

function isAccountCell(element: string): boolean {
  return element === BAND_ACCOUNT || element.startsWith(`${BAND_ACCOUNT}-`)
}
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

/** What the session's status is read from, set at session start. */
let collector: StatusCollector | null = null
let sessionId = ''
let sessionRoot = ''
let homePath = ''
let hostname: string | null = null
let engineVersion: string | null = null
/** The effort and model the latest main-loop request named; null before the first. */
let requestEffort: string | null = null
/** This session's lines added and removed by file-changing tool calls. */
let lines = { added: 0, removed: 0 }
/** The webhook feed's settings, as stored. */
let webhook: WebhookConfig = parseConfig(undefined)
/** What the feed last sent and when, so an unchanged status is not sent again until the heartbeat. */
let lastFeed = { key: '', at: 0 }
/** Whether a send is still waiting for its answer: a receiver that does not answer holds one send, never a queue. */
let isFeedSending = false

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

/** Reads the session's status: what the band draws and the webhook is sent. */
async function collectStatus($: EngineInterface): Promise<StatusInfo | null> {
  if (!collector) return null
  const cwd = await $.session.cwd()
  const modelId = await $.session.model()
  const settings = (await $.settings.read()) as { effortLevel?: unknown; modelSettings?: unknown; fastMode?: unknown }
  const branch = await collector.branch(cwd)
  const now = await $.clock.now()
  const [pr, task, ultracode] = await Promise.all([
    collector.pullRequest(cwd, branch, now),
    collector.task(homePath, sessionId),
    collector.ultracode(transcriptPath(homePath, sessionRoot, sessionId)),
  ])
  const usageNow = await $.session.usage()
  const next: StatusInfo = {
    updatedAt: now,
    model: displayModel(modelId),
    effort: requestEffort ?? settledEffort(settings, modelId),
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

/**
 * Opens the accounts pane, sized to its cards: the release line, five rows per
 * account, then the footer below a blank line; or to `rows`, for a dialog
 * taller than that. With `focus` it takes the keys, and Esc asks it to close.
 */
async function openPane($: EngineInterface, focus = false, rows?: number): Promise<void> {
  const wanted = rows ?? Math.max(1, (await read($, accounts)).length) * 5 + 3
  await $.ui.open({ id: PANE, title: paneName(), rows: wanted, ...(focus ? { focus: true, closeOnEscape: true } : {}) })
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

/** The pane's name, the brand and the mod's: the engine's tab label, and the header's when no tabs show. */
function paneName(): string {
  return `${BRAND}: ${MOD_NAME}`
}

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
        // The command opens the accounts themselves: a dialog left open is closed first.
        if ((await read($, dialog)) !== null) {
          await update($, dialog, () => null)
          await update($, webhookDraft, () => null)
        }
        await openPane($)

        return { text: m.paneOpened }
      }
      if (verb === 'list') return { text: await listText($) }
      if (verb === 'refresh') {
        await refresh($, true)

        return { text: await listText($) }
      }
      if (verb === 'add') return { text: m.addGuide }
      if (verb === 'webhook') {
        await openWebhookDialog($)

        return { text: m.paneOpened }
      }
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
    // The pane's name once: on the engine's tab while the workspace's pane is open beside it, else here.
    const isTabbed = (await $.state.get(workspacePaneOpen)).value === true
    const header = { brand: isTabbed ? '' : paneName(), release: release.version ? m.release(release.version, release.date) : undefined }
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
    // A removal in question.
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
      )
    }

    return (
      <Box flexDirection="column">
        {Header(ui, header.brand, header.release)}
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
            switchTo: uuid => act(() => switchTo($, uuid))(),
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
          { key: 'close', label: m.closeButton, isDismiss: true, onPress: act(() => closePane($)) },
        ])}
      </Box>
    )
  })
}
