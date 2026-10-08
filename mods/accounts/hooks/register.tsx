import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { USAGE_KEY, syncLive, tickOrca } from './accounts'
import type { AccountsContext } from './accounts'
import { lookedUpOnly } from './anthropic'
import type { CleanupContext } from './cleanup'
import type { CountContext } from './count'
import { claudeDirectory, homeDirectory } from './credentials'
import type { FeedContext } from './feed'
import { releaseDateOf } from './format'
import { messagesFor, resolveLocale } from './i18n'
import type { Locale, Messages } from './i18n'
import type { Cell, EnvName, Io } from './io'
import { message } from './io'
import { adoptMeasured, pollLive } from './lookups'
import { keepOrcaCopiesFresh } from './orcaCopies'
import { adoptSession, answerCommand, openPane, paneActions, paneModel, refresh, syncPaneOpen, toggle } from './paneControl'
import type { PaneContext } from './paneControl'
import { collectStatus, countLines, noteEffortCommand, noteRequestEffort, startStatus } from './sessionStatus'
import type { StatusContext } from './sessionStatus'
import { LATEST_RELEASE_KEY, RELEASE_CHECK_MS, latestReleaseUrl, latestVersion } from './shared/release'
import type { RunningRelease } from './shared/release'
import { isBesideOtherPanes } from './shared/panes'
import { editedPath, lineChanges } from './status'
import type { EffortSettings } from './status'
import { StatusBand, toolboxCell } from './views/band'
import { AccountsPane } from './views/pane'

const accounts = atom({ plugin: 'sc-accounts', key: 'accounts' } as const, [])
const usage = atom({ plugin: 'sc-accounts', key: 'usage' } as const, {})
const live = atom({ plugin: 'sc-accounts', key: 'live' } as const, null)
const dialog = atom({ plugin: 'sc-accounts', key: 'dialog' } as const, null)
const focused = atom({ plugin: 'sc-accounts', key: 'focused' } as const, null)
const isRefreshing = atom({ plugin: 'sc-accounts', key: 'isRefreshing' } as const, false)
const isGuideOpen = atom({ plugin: 'sc-accounts', key: 'isGuideOpen' } as const, false)
const statusInfo = atom({ plugin: 'sc-accounts', key: 'status' } as const, null)
const sessionEffort = atom({ plugin: 'sc-accounts', key: 'sessionEffort' } as const, null)
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
/** The toolbox's counts for its band cell; all zero when the toolbox is not installed. */
const toolboxSummary = atom({ plugin: 'sc-toolbox', key: 'summary' } as const, { running: 0, waiting: 0, failed: 0 })

const PANE = 'account-switch'
/** The pane's label on the engine's tab row, shown while another pane is open beside it. */
const TAB_LABEL = 'Accounts'
/** The plugin's name, as `ui.press` names the plugin that drew a pressed Button. */
const PLUGIN = 'sc-accounts'
/** The plugin `sc` declares /sc:accounts in `commands/accounts.md`; this hook answers it. */
const COMMAND = 'sc:accounts'
/** The band cell that toggles the accounts pane, the live account's name: `band-account`, then one Button per further coloured run. */
const BAND_ACCOUNT = 'band-account'
/** The `/config` row of the plugin's `showStatusBand` setting. */
const BAND_SETTING = 'sc-accounts.showStatusBand'
/** Every session wakes this often: to adopt a new login, and to share or take the automatic lookup. */
const TICK_MS = 60 * 1000
/** How often the session's status is read: the model, effort, branch, task and the rest the band shows. */
const STATUS_POLL_MS = 2000
/** How often the open pane redraws, so each account's "updated N min ago" is at most this late. */
const PANE_TICK_MS = 10 * 1000
/** How long after a /clear ends the old session the new one is taken up, once the engine has switched ids. */
const CLEAR_SETTLE_MS = 300
/** The largest file whose edit is counted; `$.fs.read` refuses bigger ones. */
const MAX_COUNTED_FILE = 4 * 1024 * 1024

/** The display language, settled at every session start (a reload starts one). */
let locale: Locale = 'en'
let m: Messages = messagesFor(locale)
/** This build's version and release date, read from the plugin's own files at session start. */
let release: RunningRelease = {}
/** When this session's current model turn began; 0 before the first. */
let turnStartedAt = 0
let sessionId = ''
let homePath = ''
let hostname: string | null = null
let engineVersion: string | null = null

function isAccountCell(element: string): boolean {
  return element === BAND_ACCOUNT || element.startsWith(`${BAND_ACCOUNT}-`)
}

function debugLog($: EngineInterface, error: unknown): void {
  $.ui.log(`account-switch: ${message(error)}`, { to: 'debug' })
}

// ── what the modules reach the machine and the session through ─────────────

/** One environment variable the modules read, each by its literal name, as the engine lists them. */
function variable($: EngineInterface, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case 'OS':
      return $.env.get('OS')
    case 'HOME':
      return $.env.get('HOME')
    case 'USERPROFILE':
      return $.env.get('USERPROFILE')
    case 'USER':
      return $.env.get('USER')
    case 'CLAUDE_CONFIG_DIR':
      return $.env.get('CLAUDE_CONFIG_DIR')
    case 'CLAUDE_SECURESTORAGE_CONFIG_DIR':
      return $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')
    case 'ORCA_USER_DATA_PATH':
      return $.env.get('ORCA_USER_DATA_PATH')
    case 'XDG_CONFIG_HOME':
      return $.env.get('XDG_CONFIG_HOME')
    case 'APPDATA':
      return $.env.get('APPDATA')
  }
}

function machine($: EngineInterface): Io {
  return {
    run: (argv, init) => $.process.run(argv, init),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path),
    list: path => $.fs.list(path),
    env: name => variable($, name),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    after: (ms, fn) => {
      const timer = $.clock.after(ms, fn)

      return () => timer.cancel()
    },
    fetch: (url, init) => $.http.fetch(url, init),
    store: {
      get: key => $.store.get(key),
      set: async (key, value) => {
        await $.store.set(key, value)
      },
      delete: async key => {
        await $.store.delete(key)
      },
      keys: () => $.store.keys(),
    },
    log: text => $.ui.log(`account-switch: ${text}`, { to: 'debug' }),
  }
}

function accountsContext($: EngineInterface): AccountsContext {
  return {
    io: machine($),
    accounts: { get: () => read($, accounts), set: async list => void (await update($, accounts, () => list)) },
    live: { get: () => read($, live), set: async uuid => void (await update($, live, () => uuid)) },
    usage: { get: () => read($, usage), update: async change => void (await update($, usage, change)) },
    isRefreshing: { get: () => read($, isRefreshing), set: async value => void (await update($, isRefreshing, () => value)) },
    toast: text => $.ui.toast(text),
    messages: () => m,
    session: { id: () => sessionId, cwd: () => $.session.cwd(), version: () => release.version ?? '' },
  }
}

function countContext($: EngineInterface): CountContext {
  return {
    io: machine($),
    messages: () => m,
    usagePeriod: () => read($, usagePeriod),
    usageSummary: async summary => void (await update($, usageSummary, () => summary)),
    usageScan: async scan => void (await update($, usageScan, () => scan)),
    usageError: { get: () => read($, usageError), set: async error => void (await update($, usageError, () => error)) },
    isUsageShown: async () => (await $.ui.panes()).some(pane => pane.id === PANE) && (await read($, tab)) === 'usage',
  }
}

function cleanupContext($: EngineInterface): CleanupContext {
  return {
    io: machine($),
    count: countContext($),
    storage: async view => void (await update($, storage, () => view)),
    cleanupDays: () => read($, cleanupDays),
    sessionId: () => $.session.id(),
    autoCleanupDays: async () => {
      const { cleanupPeriodDays } = (await $.settings.read()) as { cleanupPeriodDays?: unknown }

      return typeof cleanupPeriodDays === 'number' ? cleanupPeriodDays : undefined
    },
    homePath: () => homePath,
  }
}

function feedContext($: EngineInterface): FeedContext {
  return {
    io: machine($),
    messages: () => m,
    webhookLast: async last => void (await update($, webhookLast, () => last)),
    liveFigures: async () => {
      const liveUuid = await read($, live)

      return {
        email: (await read($, accounts)).find(one => one.uuid === liveUuid)?.email ?? null,
        limits: liveUuid ? ((await read($, usage))[liveUuid]?.limits ?? []) : [],
      }
    },
    session: { id: () => sessionId, hostname: () => hostname, version: () => engineVersion },
  }
}

function statusContext($: EngineInterface): StatusContext {
  return {
    accounts: accountsContext($),
    feed: feedContext($),
    cwd: () => $.session.cwd(),
    model: () => $.session.model(),
    usage: () => $.session.usage(),
    settings: async () => (await $.settings.read()) as { fastMode?: unknown },
    settingsOf: async source => (await $.settings.read({ source })) as EffortSettings,
    status: { get: () => read($, statusInfo), set: async next => void (await update($, statusInfo, () => next)) },
    sessionEffort: { get: () => read($, sessionEffort), set: async next => void (await update($, sessionEffort, () => next)) },
    turnStartedAt: () => turnStartedAt,
  }
}

function paneContext($: EngineInterface): PaneContext {
  const cell = <T,>(get: () => Promise<T>, set: (value: T) => Promise<unknown>): Cell<T> => ({ get, set: async value => void (await set(value)) })

  return {
    accounts: accountsContext($),
    count: countContext($),
    cleanup: cleanupContext($),
    feed: feedContext($),
    status: statusContext($),
    cells: {
      dialog: cell(() => read($, dialog), value => update($, dialog, () => value)),
      focused: cell(() => read($, focused), value => update($, focused, () => value)),
      tab: cell(() => read($, tab), value => update($, tab, () => value)),
      paneOpen: cell(() => read($, paneOpen), value => update($, paneOpen, () => value)),
      isGuideOpen: cell(() => read($, isGuideOpen), value => update($, isGuideOpen, () => value)),
      webhookDraft: cell(() => read($, webhookDraft), value => update($, webhookDraft, () => value)),
      webhookLast: cell(() => read($, webhookLast), value => update($, webhookLast, () => value)),
      usagePeriod: cell(() => read($, usagePeriod), value => update($, usagePeriod, () => value)),
      usageSummary: cell(() => read($, usageSummary), value => update($, usageSummary, () => value)),
      usageScan: cell(() => read($, usageScan), value => update($, usageScan, () => value)),
      usageError: cell(() => read($, usageError), value => update($, usageError, () => value)),
      storage: cell(() => read($, storage), value => update($, storage, () => value)),
      cleanupDays: cell(() => read($, cleanupDays), value => update($, cleanupDays, () => value)),
      tick: cell(() => read($, tick), value => update($, tick, () => value)),
      statusInfo: cell(() => read($, statusInfo), value => update($, statusInfo, () => value)),
    },
    ui: {
      open: async (rows, focus) => {
        await $.ui.open({ id: PANE, title: TAB_LABEL, rows, ...(focus ? { focus: true, closeOnEscape: true } : {}) })
      },
      close: async () => {
        await $.ui.close({ id: PANE })
      },
      pane: async () => (await $.ui.panes()).find(pane => pane.id === PANE),
      toast: text => $.ui.toast(text),
      runCommand: (command, args) => $.command.run({ command, args }),
      isUnderTabs: async () =>
        isBesideOtherPanes('sc-accounts', {
          'sc-accounts': (await $.state.get({ plugin: 'sc-accounts', key: 'paneOpen' })).value === true,
          'sc-workspace': (await $.state.get({ plugin: 'sc-workspace', key: 'paneOpen' })).value === true,
          'sc-toolbox': (await $.state.get({ plugin: 'sc-toolbox', key: 'paneOpen' })).value === true,
        }),
    },
    session: { model: () => $.session.model(), cwd: () => $.session.cwd(), cost: async () => (await $.session.usage()).cost?.usd ?? null },
    view: { locale: () => locale, messages: () => m, release: () => release, homePath: () => homePath },
  }
}

// ── the session ────────────────────────────────────────────────────────────

/** The version `plugin.json` states and the date `CHANGELOG.md` gives that version. */
async function readRelease($: EngineInterface): Promise<RunningRelease> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string; repository?: string }
    if (typeof manifest.version !== 'string') return {}
    const changelogPath = `${$.plugin.root}/CHANGELOG.md`
    const changelog = (await $.fs.exists(changelogPath)) ? await $.fs.read(changelogPath) : ''

    return { version: manifest.version, date: releaseDateOf(changelog, manifest.version), repository: manifest.repository }
  } catch (error) {
    $.ui.log(`account-switch: cannot read the release: ${message(error)}`, { to: 'debug' })

    return {}
  }
}

/** Hears of the latest published release, so the pane header says when an update is due. */
async function followLatestRelease($: EngineInterface): Promise<void> {
  const url = latestReleaseUrl(release.repository)
  if (url === null) return
  const latest = await latestVersion(
    {
      now: () => $.clock.now(),
      get: () => $.store.get(LATEST_RELEASE_KEY),
      set: value => $.store.set(LATEST_RELEASE_KEY, value),
      fetch: (target, init) => $.http.fetch(target, init),
    },
    url,
  )
  release = { ...release, latest }
}

/** A file's text, or null when it is missing or too big to read. */
async function readSmallFile($: EngineInterface, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  const { size } = await $.fs.stat(path)

  return size > MAX_COUNTED_FILE ? null : $.fs.read(path)
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
    // A later published release turns the header's date into Update Required: asked now and every few hours.
    void followLatestRelease($).catch((error: unknown) => debugLog($, error))
    $.clock.every(RELEASE_CHECK_MS, () => {
      void followLatestRelease($).catch((error: unknown) => debugLog($, error))
    })
    $.ui.status(undefined)
    // Readings no lookup produced (a figure copied from another login, a message an older build kept) go.
    await $.store.set(USAGE_KEY, lookedUpOnly(await $.store.get(USAGE_KEY)))
    const io = machine($)
    homePath = await homeDirectory(io)
    engineVersion = (await $.session.version()).version
    const host = await $.process.run(['hostname'], { timeoutMs: 2000 })
    hostname = host.exitCode === 0 ? host.stdout.trim() : null
    // The session's status: read every two seconds from the engine, git, gh and the transcript.
    startStatus(
      {
        run: (argv, init) => $.process.run(argv, init),
        read: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : null),
        list: async path => ((await $.fs.exists(path)) ? $.fs.list(path) : []),
        size: async path => ((await $.fs.exists(path)) ? (await $.fs.stat(path)).size : null),
      },
      { configPath: await claudeDirectory(io), sessionRoot: await $.session.root() },
    )
    sessionId = await $.session.id()
    await adoptSession(paneContext($), sessionId, false)
    $.clock.every(STATUS_POLL_MS, () => {
      void collectStatus(statusContext($)).catch((error: unknown) => debugLog($, error))
    })
    $.clock.every(PANE_TICK_MS, () => {
      void (async () => {
        if (!(await syncPaneOpen(paneContext($)))) return
        const now = await $.clock.now()
        await update($, tick, () => now)
      })().catch((error: unknown) => debugLog($, error))
    })
    $.clock.every(TICK_MS, () => {
      const pane = paneContext($)
      const ctx = pane.accounts
      void syncLive(ctx)
        .catch((error: unknown) => debugLog($, error))
        .then(() => tickOrca(ctx))
        // Orca writes a copy as it is while a Claude terminal runs in it: each is kept from expiring.
        .then(claude => (claude ? keepOrcaCopiesFresh(ctx, claude) : undefined))
        .catch((error: unknown) => debugLog($, error))
        .then(() => refresh(pane, false))
        // The live account is kept current between Claude Code's own readings too.
        .then(() => pollLive(ctx))
        .catch((error: unknown) => debugLog($, error))
    })

    return next(e)
  })

  // A /clear goes on in this process under a new session id, and no session.start fires for
  // it: the new session's state is filled here, once the old one has ended.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_SETTLE_MS, () => {
        void (async () => {
          sessionId = await $.session.id()
          await adoptSession(paneContext($), sessionId, true)
        })().catch((error: unknown) => debugLog($, error))
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
    if (!e.agentId) await noteRequestEffort(statusContext($), e.effort).catch((error: unknown) => debugLog($, error))

    return yield* next(e)
  })

  // This session's `/effort`: the level it names shows at once, a default picked from its list once saved.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const userBefore = (await $.settings.read({ source: 'user' })) as EffortSettings
    const result = await next(e)
    await noteEffortCommand(statusContext($), e.args, userBefore).catch((error: unknown) => debugLog($, error))

    return result
  })

  // Lines a file-changing tool call adds and removes: the file before and after, compared.
  // A failure here never stands in the tool call's way: the call goes on, run once.
  on('tool.call', async ($, e, next) => {
    const path = editedPath(String(e.tool), e)
    if (path === null) return next(e)
    const before = await readSmallFile($, path).catch(() => undefined)
    const result = await next(e)
    if (before !== undefined && !('deny' in result) && !(result as { isError?: boolean }).isError) {
      const after = await readSmallFile($, path).catch(() => undefined)
      if (after !== undefined) await countLines(statusContext($), lineChanges(before, after)).catch((error: unknown) => debugLog($, error))
    }

    return result
  }).catch(($, e, next) => next(e))

  // Claude Code's own response reported its windows: filed under the live account when they are its.
  on('session.measure', async ($, e, next) => {
    await adoptMeasured(accountsContext($), e.rateLimits, turnStartedAt).catch((error: unknown) => debugLog($, error))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({
    text: await answerCommand(paneContext($), e.args, {
      isFullscreen: e.presentation?.isFullscreen,
      setBand: async isShown => (await $.config.set({ key: BAND_SETTING, value: isShown })).deny,
    }),
  }))

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
        void toggle(paneContext($), target).catch((error: unknown) => $.ui.toast(message(error)))
      },
    })
  })

  // A band press is taken here, inside the person's press, and toggled before the chain
  // settles: a pane opened there counts as asked for and is placed at any width.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== PLUGIN || e.component !== 'AbovePrompt' || !isAccountCell(e.element)) return next(e)
    await toggle(paneContext($), 'accounts')

    return { element: e.element }
  })

  // Where the keyboard is in the pane, so the dialog's outlined tiles can show it.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE) await update($, focused, () => e.element ?? null)

    return result
  }).catch(($, e, next) => next(e))

  // Esc (or the close mark) while the dialog asks cancels the dialog and keeps the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, dialog)) !== null) {
      const wasWebhook = (await read($, dialog))?.kind === 'webhook'
      await update($, dialog, () => null)
      await update($, focused, () => null)
      if (wasWebhook) await openPane(paneContext($), true)

      return { value: undefined }
    }
    const result = await next(e)
    if (e.id === PANE && (await read($, paneOpen))) await update($, paneOpen, () => false)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const pane = paneContext($)

    return AccountsPane($.ui.resolve(e), await paneModel(pane, e.props.bodyColumns ?? 60, e.surface !== 'mobile'), paneActions(pane))
  })
}
