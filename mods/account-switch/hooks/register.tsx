import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountView, LimitView, UsageView } from '../types'
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
import { bar, barParts, describeLimits, releaseDateOf, displayWidth, isSameReset, packRows, pick, resetText, resetClock, severityColor } from './format'
import { messagesFor, resolveLocale } from './i18n'
import { ansiHex, contextLabelColor, contextScaled, modelPill, parseStatusInfo, pillWidth, placePill, reviewMark } from './statusline'
import type { PillSegment } from './statusline'
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

const accounts = atom({ plugin: 'sc', key: 'accounts' } as const, [])
const usage = atom({ plugin: 'sc', key: 'usage' } as const, {})
const live = atom({ plugin: 'sc', key: 'live' } as const, null)
const pendingRemove = atom({ plugin: 'sc', key: 'pendingRemove' } as const, null)
const isRefreshing = atom({ plugin: 'sc', key: 'isRefreshing' } as const, false)
const isGuideOpen = atom({ plugin: 'sc', key: 'isGuideOpen' } as const, false)
const statusInfo = atom({ plugin: 'sc', key: 'status' } as const, null)

const PANE = 'account-switch'
/** The product name heading the pane; a name, so it is not translated. */
const BRAND = 'SimpleCORE Mods'
/** The `/config` row of the plugin's `showStatusBand` setting. */
const BAND_SETTING = 'sc.showStatusBand'
/** Cells between two limit columns in the pane. */
const CELL_GAP = 3
/** The xterm-256 ground behind the context gauge. */
const CONTEXT_GROUND = 236
/** Cells between two cells of the band's status line. */
const STATUS_GAP = 1
/** Cells a usage bar spans. */
const BAR_WIDTH = 8
/** Cells a card's border and horizontal padding take across. */
const CARD_CHROME = 4
/** The footer tiles' fill, and its fill under the pointer. */
const TILE_BACKGROUND = '#262b33'
/** Cells between two footer tiles. */
const TILE_GAP = 1
const TILE_HOVER_BACKGROUND = '#323946'
/** Beside an account whose last lookup was rate limited, so its figures are the previous reading's. */
const STALE_MARK = '◷'
/** `commands/accounts.md` declares it; the plugin's name makes it `/sc:accounts`, and this hook answers it. */
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

// ── keychain ──────────────────────────────────────────────────────────────

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

async function readCredential($: EngineInterface, service: string, account?: string): Promise<Credential | null> {
  const text = await findSecret($, service, account)

  return text === null ? null : parseCredential(text)
}

async function writeLiveCredential($: EngineInterface, credential: Credential): Promise<void> {
  const attributes = await $.process.run(attributesArgv(LIVE_SERVICE), { timeoutMs: 5000 })
  const account = parseAccountName(attributes.stdout) ?? (await $.env.get('USER'))
  if (!account) throw new KeychainError('cannot tell which keychain account Claude Code uses')
  await storeSecret($, LIVE_SERVICE, account, JSON.stringify(credential))
}

/**
 * Mirrors the credential into Claude Code's plaintext fallback file when that
 * file exists. Claude Code compares the file's mtime before each token check,
 * so the write is what makes a running session drop its cached login at once.
 */
async function writeLiveCredentialFile($: EngineInterface, credential: Credential): Promise<void> {
  const path = `${await claudeDirectory($)}/.credentials.json`
  if (!(await $.fs.exists(path))) return
  // umask keeps the file owner-only; the secret travels on stdin.
  const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', 'umask 077 && cat > "$0"', path], {
    stdin: JSON.stringify(credential),
    timeoutMs: 5000,
  })
  if (exitCode !== 0) throw new Error(`cannot write ${path}: ${stderr.trim()}`)
}

async function deleteVault($: EngineInterface, uuid: string): Promise<void> {
  const { exitCode, stderr } = await $.process.run(deleteArgv(VAULT_SERVICE, uuid), { timeoutMs: 5000 })
  if (exitCode !== 0 && exitCode !== ITEM_NOT_FOUND) {
    throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
  }
}

// ── Claude Code's global config ───────────────────────────────────────────

async function homeDirectory($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')

  return home
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

async function saveIndex($: EngineInterface, list: AccountView[]): Promise<void> {
  await $.store.set(INDEX_KEY, list)
  await update($, accounts, () => list)
}

async function loadIndex($: EngineInterface): Promise<void> {
  const stored = await $.store.get(INDEX_KEY)
  await update($, accounts, () => (Array.isArray(stored) ? (stored as AccountView[]) : []))
}

/**
 * Reads the login Claude Code uses now and files it in the vault: a new
 * account is added, a known one gets the credential Claude Code last refreshed.
 *
 * @returns the live account's uuid, or null with no Claude login
 */
async function syncLive($: EngineInterface): Promise<string | null> {
  const [configured, credential] = await Promise.all([liveOauthAccount($), readCredential($, LIVE_SERVICE)])
  if (configured === null || credential === null) {
    await update($, live, () => null)

    return null
  }

  let account = configured
  const stored = await readCredential($, VAULT_SERVICE, configured.accountUuid)
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
    await storeSecret($, VAULT_SERVICE, account.accountUuid, JSON.stringify(credential))
  }
  if ((await read($, live)) !== account.accountUuid) liveChangedAt = await $.clock.now()
  await update($, live, () => account.accountUuid)
  await $.store.set(oauthAccountKey(account.accountUuid), account)

  const list = await read($, accounts)
  const view: AccountView = {
    uuid: account.accountUuid,
    email: account.emailAddress,
    organizationName: account.organizationName,
    subscriptionType: credential.claudeAiOauth.subscriptionType,
    savedAt: list.find(one => one.uuid === account.accountUuid)?.savedAt ?? (await $.clock.now()),
  }
  const isKnown = list.some(one => one.uuid === view.uuid)
  if (!isKnown) $.ui.toast(`account-switch: ${m.saved(view.email)}`)
  await saveIndex($, isKnown ? list.map(one => (one.uuid === view.uuid ? view : one)) : [...list, view])

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
  await storeSecret($, VAULT_SERVICE, uuid, JSON.stringify(fresh))

  return fresh
}

/** Makes a saved account the one Claude Code logs in with. */
async function switchTo($: EngineInterface, uuid: string): Promise<string> {
  const target = (await read($, accounts)).find(one => one.uuid === uuid)
  if (!target) throw new Error('no saved account with that id')

  // File the outgoing login first: Claude Code may have rotated its tokens.
  await syncLive($)
  const credential = await readCredential($, VAULT_SERVICE, uuid)
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
  await saveIndex($, (await read($, accounts)).filter(one => one.uuid !== uuid))
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
    const credential = await readCredential($, LIVE_SERVICE)
    if (credential === null) throw new Error(m.noStoredLogin)
    init = usageInit({ token: credential.claudeAiOauth.accessToken })
  } else {
    const credential = await readCredential($, VAULT_SERVICE, uuid)
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
    $.ui.toast(`account-switch: ${message(error)}`)
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
        // The release line, a five-line card per account, then the footer's three-line tiles below a blank line.
        const rows = Math.max(1, (await read($, accounts)).length) * 5 + 5
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
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const room = Math.max(20, e.props.bodyColumns)

    const drawPill = (key: string, segments: PillSegment[]) => (
      <Text key={key}>
        <Text color={ansiHex(segments[0]?.bg ?? 0)}>▐</Text>
        {segments.map((segment, index) => {
          const after = segments[index + 1]

          return (
            <Text key={`${key}-${index}`}>
              <Text backgroundColor={ansiHex(segment.bg)} color={ansiHex(segment.fg)} bold={segment.bold === true}>
                {segment.letters
                  ? segment.letters.map((letter, at) => (
                      <Text key={`${key}-${index}-${at}`} color={ansiHex(letter.fg)}>
                        {letter.char}
                      </Text>
                    ))
                  : segment.text}
              </Text>
              {after ? (
                <Text color={ansiHex(segment.bg)} backgroundColor={ansiHex(after.bg)}>
                  ▌
                </Text>
              ) : (
                <Text color={ansiHex(segment.bg)}>▌</Text>
              )}
            </Text>
          )
        })}
      </Text>
    )

    type Cell = { key: string; width: number; draw: () => ReturnType<typeof drawPill> }
    const first: Cell[] = []
    // The session's own context reading comes first; the status line's forward when it has none yet.
    if (contextUsed !== null) {
      // The usage bars' gauge, coloured by the context thresholds, on a ground of its own.
      const scaled = contextScaled(contextUsed)
      const { filled, rest } = barParts(scaled, BAR_WIDTH)
      const label = scaled >= 95 ? `✖ ${scaled}%` : `${scaled}%`
      const ground = ansiHex(CONTEXT_GROUND)
      const ink = ansiHex(contextLabelColor(scaled))
      first.push({
        key: 'context',
        width: displayWidth(`ctx ${bar(scaled, BAR_WIDTH)} ${label}`) + 2,
        draw: () => (
          <Text key="context">
            <Text color={ground}>▐</Text>
            <Text backgroundColor={ground} color={ansiHex(250)}>
              ctx{' '}
            </Text>
            <Text backgroundColor={ground} color={ink}>
              {filled}
            </Text>
            <Text backgroundColor={ground} color={ansiHex(240)}>
              {rest}
            </Text>
            <Text backgroundColor={ground} color={ink} bold>
              {` ${label}`}
            </Text>
            <Text color={ground}>▌</Text>
          </Text>
        ),
      })
    }
    if (status) {
      const model = modelPill(status)
      first.push({ key: 'model', width: pillWidth(model, displayWidth), draw: () => drawPill('model', model) })
      if (status.task) {
        const task = `‣ ${status.task}`
        first.push({
          key: 'task',
          width: displayWidth(task),
          draw: () => (
            <Text key="task" color={ansiHex(229)} bold>
              {task}
            </Text>
          ),
        })
      }
    }

    const second: Cell[] = []
    if (account) {
      const name = `${account.email}${reading?.isStale ? ` ${STALE_MARK}` : ''}`
      second.push({
        key: 'account',
        width: displayWidth(name),
        draw: () => (
          <Text key="account">
            <Text color={ansiHex(110)}>{account.email}</Text>
            {reading?.isStale && <Text color="yellow" dimColor>{` ${STALE_MARK}`}</Text>}
          </Text>
        ),
      })
    }
    for (const limit of windows) {
      const reset = resetClock(limit.resetsAt, now, locale)
      const text = `${limit.label} ${bar(limit.percent, BAR_WIDTH)} ${Math.round(limit.percent)}%${reset ? ` ↻ ${reset}` : ''}`
      const { filled, rest } = barParts(limit.percent, BAR_WIDTH)
      second.push({
        key: limit.label,
        width: displayWidth(text),
        draw: () => (
          <Text key={`usage-${limit.label}`}>
            <Text dimColor>{limit.label} </Text>
            <Text color={severityColor(limit.percent)}>{filled}</Text>
            <Text color="gray" dimColor>
              {rest}
            </Text>
            <Text> {Math.round(limit.percent)}%</Text>
            {reset && <Text dimColor> ↻ {reset}</Text>}
          </Text>
        ),
      })
    }
    // The place comes last, right before the lines changed.
    if (status) {
      const place = placePill(status)
      const pr = status.pr
      const mark = pr ? reviewMark(pr.reviewState) : undefined
      const prText = pr ? ` #${pr.number}${mark ? mark.text : ''}` : ''
      second.push({
        key: 'place',
        width: pillWidth(place, displayWidth) + displayWidth(prText),
        draw: () => (
          <Text key="place">
            {drawPill('place-pill', place)}
            {pr && (
              <Text color={ansiHex(75)} bold>
                {` #${pr.number}`}
              </Text>
            )}
            {mark && <Text color={ansiHex(mark.fg)}>{mark.text}</Text>}
          </Text>
        ),
      })
    }
    if (status && (status.linesAdded > 0 || status.linesRemoved > 0)) {
      const added = `+${status.linesAdded}`
      const removed = `-${status.linesRemoved}`
      second.push({
        key: 'lines',
        width: displayWidth(`${added} ${removed}`),
        draw: () => (
          <Text key="lines">
            <Text color={ansiHex(42)} bold>
              {added}
            </Text>
            <Text> </Text>
            <Text color={ansiHex(203)} bold>
              {removed}
            </Text>
          </Text>
        ),
      })
    }

    // One line while it fits; a new row only where the band runs out of room.
    // The context sits right before the five-hour window, beside the other gauges.
    const context = first.filter(cell => cell.key === 'context')
    const firstUsage = second.findIndex(cell => cell.key === '5h' || cell.key === 'wk')
    const cells = [
      ...first.filter(cell => cell.key !== 'context'),
      ...(firstUsage < 0 ? [...second, ...context] : [...second.slice(0, firstUsage), ...context, ...second.slice(firstUsage)]),
    ]
    const rows = packRows(cells, room, STATUS_GAP).map((row, index) => (
      <Box key={`status-row-${index}`} gap={STATUS_GAP}>
        {row.map(cell => cell.draw())}
      </Box>
    ))
    // One row is returned bare: a column around it can leave a blank row below on the terminal.
    const [only] = rows

    return rows.length === 1 && only ? only : <Box flexDirection="column">{rows}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, accounts)
    const liveUuid = await read($, live)
    const readings = await read($, usage)
    const removing = await read($, pendingRemove)
    const isBusy = await read($, isRefreshing)
    const isGuideShown = await read($, isGuideOpen)
    // Three equal tiles across the pane, the gaps between them taken out first.
    const tileWidth = Math.max(10, Math.floor(((e.props.bodyColumns ?? 60) - TILE_GAP * 2) / 3))
    const now = await $.clock.now()
    const act = (work: () => Promise<string | void>) => () => {
      void work()
        .then(text => text && $.ui.toast(text))
        .catch((error: unknown) => $.ui.toast(`account-switch: ${message(error)}`))
    }

    return (
      <Box flexDirection="column">
        <Box key="header" justifyContent="space-between">
          <Text bold>{BRAND}</Text>
          {release.version && <Text dimColor>{m.release(release.version, release.date)}</Text>}
        </Box>
        {list.length === 0 && <Text dimColor>{m.noAccountsYet}</Text>}
        {list.map(one => {
          const reading = readings[one.uuid]
          const isLive = one.uuid === liveUuid

          return (
            <Box
              key={`row-${one.uuid}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={isLive ? 'cyan' : undefined}
              borderDimColor={!isLive}
              paddingX={1}
            >
              <Box justifyContent="space-between">
                <Text>
                  <Text color={isLive ? 'cyan' : undefined} dimColor={!isLive}>
                    {isLive ? '● ' : '○ '}
                  </Text>
                  <Text bold={isLive}>{one.email}</Text>
                  {isLive && <Text> </Text>}
                  {isLive && <Text color="black" backgroundColor="cyan"> {m.active} </Text>}
                  {reading?.isStale && <Text color="yellow" dimColor> {STALE_MARK}</Text>}
                </Text>
                {!isLive && (
                  <Box gap={2}>
                    <Button
                      key={`use-${one.uuid}`}
                      label="⇄"
                      plain
                      dimColor
                      hover={{ color: 'cyan', bold: true }}
                      onPress={act(() => switchTo($, one.uuid))}
                    />
                    {removing === one.uuid ? (
                      <Button
                        key={`confirm-${one.uuid}`}
                        label="✕?"
                        plain
                        hover={{ color: 'red', bold: true }}
                        onPress={act(async () => {
                          await update($, pendingRemove, () => null)

                          return remove($, one.uuid)
                        })}
                      />
                    ) : (
                      <Button
                        key={`remove-${one.uuid}`}
                        label="✕"
                        plain
                        dimColor
                        hover={{ color: 'red' }}
                        onPress={act(async () => {
                          await update($, pendingRemove, () => one.uuid)
                        })}
                      />
                    )}
                  </Box>
                )}
              </Box>
              {(() => {
                // Windows that reset together share one cell: their bars side by side, one reset line.
                const groups: LimitView[][] = []
                for (const limit of reading?.limits ?? []) {
                  const together = groups.find(group => group[0] && group[0].label !== '5h' && limit.label !== '5h' && isSameReset(group[0].resetsAt, limit.resetsAt))
                  if (together) together.push(limit)
                  else groups.push([limit])
                }
                const cells = groups.map(group => {
                  const heads = group.map(limit => `${limit.label} ${bar(limit.percent, BAR_WIDTH)} ${Math.round(limit.percent)}%`)
                  const reset = resetText(group[0]?.resetsAt, now, locale, m.now)
                  const foot = reset ? `↻ ${reset}` : ''
                  const headWidth = heads.reduce((sum, head) => sum + displayWidth(head), 0) + CELL_GAP * (heads.length - 1)

                  return { group, foot, width: Math.max(headWidth, displayWidth(foot)) }
                })
                // Rows are laid out here: the terminal's own wrap leaves blank lines between rows.
                // The card's border and padding take CARD_CHROME cells, the limits' indent two more.
                const room = Math.max(20, (e.props.bodyColumns ?? 60) - CARD_CHROME - 2)

                return (
                  <Box flexDirection="column" paddingLeft={2}>
                    {packRows(cells, room, CELL_GAP).map((row, rowIndex) => (
                      <Box key={`${one.uuid}-limits-${rowIndex}`} gap={CELL_GAP}>
                        {row.map(({ group, foot, width }) => (
                          <Box key={`${one.uuid}-${group[0]?.label}`} flexDirection="column" width={width}>
                            <Box gap={CELL_GAP}>
                              {group.map(limit => (
                                <Text key={`${one.uuid}-${limit.label}`}>
                                  <Text dimColor>{limit.label} </Text>
                                  <Text color={severityColor(limit.percent)}>{barParts(limit.percent, BAR_WIDTH).filled}</Text>
                                  <Text color="gray" dimColor>{barParts(limit.percent, BAR_WIDTH).rest}</Text>
                                  <Text> {Math.round(limit.percent)}%</Text>
                                </Text>
                              ))}
                            </Box>
                            {foot !== '' && <Text dimColor>{foot}</Text>}
                          </Box>
                        ))}
                      </Box>
                    ))}
                    {!reading && <Text dimColor>{m.loading}</Text>}
                    {reading?.error && <Text color="red">{reading.error}</Text>}
                  </Box>
                )
              })()}
            </Box>
          )
        })}
        {isGuideShown && (
          <Box key="guide" flexDirection="column" marginTop={1} paddingLeft={2}>
            {m.addGuide.split('\n').map((line, index) => (
              <Text key={`guide-${index}`} dimColor={index > 0}>
                {line}
              </Text>
            ))}
          </Box>
        )}
        <Box key="footer" gap={TILE_GAP} marginTop={1}>
          {[
            {
              key: 'refresh',
              label: isBusy ? m.refreshingButton : m.refreshButton,
              isMain: true,
              onPress: act(() => refresh($, true)),
            },
            {
              key: 'add',
              label: m.addButton,
              isMain: false,
              onPress: act(async () => {
                await update($, isGuideOpen, shown => !shown)
              }),
            },
            { key: 'close', label: m.closeButton, isMain: false, onPress: act(() => $.ui.close({ id: PANE })) },
          ].map(action => (
            // One third of the row each: a bordered, filled tile around a plain button.
            <Box
              key={`tile-${action.key}`}
              width={tileWidth}
              justifyContent="center"
              borderStyle="round"
              borderColor={action.isMain ? 'cyan' : 'gray'}
              backgroundColor={TILE_BACKGROUND}
              hover={{ backgroundColor: TILE_HOVER_BACKGROUND, borderColor: 'cyan' }}
            >
              <Button
                key={action.key}
                label={action.label}
                plain
                {...(action.key === 'close' ? { role: 'dismiss' as const } : {})}
                onPress={action.onPress}
              />
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
