import type { AccountsTabKey, BandTarget, StatusInfo, StorageView, UsageSummary, WebhookSend } from '../types'
import { USAGE_KEY, loadIndex, syncLive, tickOrca } from './accounts'
import type { AccountsContext } from './accounts'
import { lookedUpOnly } from './anthropic'
import { askCleanup, askedCleanup, cleanUp, measureStorage } from './cleanup'
import type { CleanupContext } from './cleanup'
import { countUsage, refreshUsageSummary } from './count'
import type { CountContext } from './count'
import { draftConfig, openWebhook, resetFeed, saveWebhook, templatePath, testWebhook, upgradeTemplate, urlMessage, webhookPreview } from './feed'
import type { FeedContext } from './feed'
import { describeLimits, pick, pickExact } from './format'
import type { Locale, Messages } from './i18n'
import type { Cell } from './io'
import { message } from './io'
import { refreshAll, refreshLive } from './lookups'
import { rememberedOrca } from './orcaClient'
import { beginSession, collectStatus } from './sessionStatus'
import type { StatusContext } from './sessionStatus'
import { paneTitle } from './shared/kit'
import { resetClock } from './shared/time'
import { remove, switchTo } from './switching'
import { STALE_MARK } from './views/accounts'
import type { PaneActions, PaneDialog, PaneModel } from './views/pane'
import type { WebhookDraft } from './views/webhook'
import { urlProblem } from './webhook'

/**
 * The mod's control: taking up a session, answering `/sc:accounts`, opening
 * and closing the pane, its tabs, the band's toggle, and the model and actions
 * the pane view draws from. The hooks module hands it the session's state as
 * cells and the engine's pane calls.
 */

/** A pane the engine holds, as far as the toggle reads it. */
type HeldPane = { id: string; isShown?: boolean; isPlaced?: boolean }

/** What the pane's control reads and writes beyond the modules' own contexts. */
export type PaneContext = {
  accounts: AccountsContext
  count: CountContext
  cleanup: CleanupContext
  feed: FeedContext
  status: StatusContext
  cells: {
    dialog: Cell<PaneDialog>
    focused: Cell<string | null>
    tab: Cell<AccountsTabKey>
    paneOpen: Cell<boolean>
    isGuideOpen: Cell<boolean>
    webhookDraft: Cell<WebhookDraft | null>
    webhookLast: Cell<WebhookSend | null>
    usagePeriod: Cell<number>
    usageSummary: Cell<UsageSummary | null>
    usageScan: Cell<{ done: number; total: number } | null>
    usageError: Cell<string | null>
    storage: Cell<StorageView | null>
    cleanupDays: Cell<number>
    tick: Cell<number>
    statusInfo: Cell<StatusInfo | null>
  }
  ui: {
    /** Opens (or resizes) this mod's pane at `rows`; with `focus` it takes the keys, and Esc asks it to close. */
    open: (rows: number, focus: boolean) => Promise<void>
    close: () => Promise<void>
    /** This mod's pane among the engine's, or undefined. */
    pane: () => Promise<HeldPane | undefined>
    toast: (text: string) => void
    /** Runs another plugin's command: the band's place and lines toggle the workspace, its toolbox cell the toolbox. */
    runCommand: (command: string, args: string) => Promise<unknown>
    /** Whether another mod's pane is open beside this one, so the engine draws a tab row above the header. */
    isUnderTabs: () => Promise<boolean>
  }
  session: { model: () => Promise<string>; cwd: () => Promise<string>; cost: () => Promise<number | null> }
  view: { locale: () => Locale; messages: () => Messages; release: () => { version?: string; date?: string }; homePath: () => string }
}

/** The mod's name in the pane's title; a name, so it is never translated. */
const MOD_NAME = 'Accounts'
/** The workspace's command, which the band's lines changed toggle when no workspace hook takes the press. */
const WORKSPACE_COMMAND = 'sc:workspace'
/** The toolbox's command: the band's toolbox cell opens its quick tiles through it when its own hook did not take the press. */
const TOOLBOX_COMMAND = 'sc:toolbox'
/** Rows the Accounts tab takes besides its cards: the header, the tab bar and its rule, the margins and the footer. */
const ACCOUNTS_CHROME_ROWS = 9
/** Rows the pane takes on its Usage and Storage tabs. */
const USAGE_ROWS = 44
/** The rows the webhook dialog takes whole: its fields, the variables with the time formats, a preview of fourteen lines and the last send. */
const WEBHOOK_DIALOG_ROWS = 70

/** Whether the pane is among the engine's panes. */
export async function isPaneShown(ctx: PaneContext): Promise<boolean> {
  return (await ctx.ui.pane()) !== undefined
}

/**
 * Opens the accounts pane, sized to its cards: five rows per account and the
 * header, tabs and footer around them; or to `rows`, for a dialog taller than
 * that. The pane is opened only by what the person did (a command, a button,
 * the band), so it takes the keyboard: with no mouse, as off fullscreen mode,
 * nothing else hands it the keys.
 */
export async function openPane(ctx: PaneContext, focus = true, rows?: number): Promise<void> {
  const wanted = rows ?? ((await ctx.cells.tab.get()) !== 'accounts' ? USAGE_ROWS : Math.max(1, (await ctx.accounts.accounts.get()).length) * 5 + ACCOUNTS_CHROME_ROWS)
  await ctx.ui.open(wanted, focus)
  if (!(await ctx.cells.paneOpen.get())) await ctx.cells.paneOpen.set(true)
}

/** Closes the pane and says so at once: the engine raises no ui.close to the plugin that asked. */
export async function closePane(ctx: PaneContext): Promise<void> {
  await ctx.ui.close()
  if (await ctx.cells.paneOpen.get()) await ctx.cells.paneOpen.set(false)
}

/** Brings `paneOpen` in line with the panes the engine holds, however the pane was closed. */
export async function syncPaneOpen(ctx: PaneContext): Promise<boolean> {
  const isOpen = await isPaneShown(ctx)
  if ((await ctx.cells.paneOpen.get()) !== isOpen) await ctx.cells.paneOpen.set(isOpen)

  return isOpen
}

/** Shows a tab of the pane, sized to it; the Usage tab counts what the transcripts gained. */
export async function showTab(ctx: PaneContext, next: AccountsTabKey): Promise<void> {
  await ctx.cells.tab.set(next)
  await openPane(ctx)
  if (next === 'usage') {
    await refreshUsageSummary(ctx.count)
    await countUsage(ctx.count)
  }
  if (next === 'storage') await measureStorage(ctx.cleanup)
}

/**
 * What a band cell toggles: the accounts pane (the account's name), or the
 * workspace on its Diff tab (the place and the lines changed), through the
 * workspace's own command since another plugin's panes are not this one's.
 */
export async function toggle(ctx: PaneContext, target: BandTarget): Promise<void> {
  if (target === 'workspace' || target === 'toolbox') {
    // Queued until the session is idle; not awaited, so the press returns at once.
    const [command, args] = target === 'workspace' ? [WORKSPACE_COMMAND, 'toggle diff'] : [TOOLBOX_COMMAND, 'quick']
    void ctx.ui.runCommand(command, args).catch((error: unknown) => ctx.ui.toast(message(error)))

    return
  }
  const pane = await ctx.ui.pane()
  // Only a pane in view closes. One behind another pane's tab, or waiting undrawn
  // from an open nobody asked for, is opened afresh: in front, and placed.
  if (pane?.isShown && pane.isPlaced) {
    // A dialog left asking would greet the next open.
    if ((await ctx.cells.dialog.get()) !== null) await ctx.cells.dialog.set(null)
    await closePane(ctx)

    return
  }
  if (pane) await ctx.ui.close()
  await openPane(ctx, true)
}

/** Opens the webhook dialog in the accounts pane, the settings as stored in its draft; the template file is written first when missing. */
export async function openWebhookDialog(ctx: PaneContext): Promise<void> {
  const { config, hasToken } = await openWebhook(ctx.accounts.io)
  await ctx.cells.webhookDraft.set({ ...config, token: '', hasToken, clearToken: false })
  await ctx.cells.dialog.set({ kind: 'webhook' })
  await openPane(ctx, true, WEBHOOK_DIALOG_ROWS)
}

/** Looks every account up, the band's model and effort too when asked for; a failure is said in a toast. */
export async function refresh(ctx: PaneContext, isAsked: boolean): Promise<void> {
  if (isAsked) void collectStatus(ctx.status).catch((error: unknown) => ctx.accounts.io.log(message(error)))
  try {
    await refreshAll(ctx.accounts, isAsked)
  } catch (error) {
    ctx.ui.toast(message(error))
  }
}

/** The accounts and their limits as `/sc:accounts list` prints them. */
export async function listText(ctx: PaneContext): Promise<string> {
  const m = ctx.view.messages()
  const list = await ctx.accounts.accounts.get()
  const liveUuid = await ctx.accounts.live.get()
  const readings = await ctx.accounts.usage.get()
  const now = await ctx.accounts.io.now()
  if (list.length === 0) return m.noAccounts

  return list
    .map((one, index) => {
      const reading = readings[one.uuid]
      const detail = reading?.error ?? describeLimits(reading?.limits ?? [], now, m.now, ctx.view.locale())

      return `${index + 1}. ${one.email}${one.uuid === liveUuid ? m.activeTag : ''}${reading?.isStale ? ` ${STALE_MARK}` : ''}  ${detail}`
    })
    .join('\n')
}

/** The session's status, model, directory and cost: what the webhook's template is filled with. */
async function feedInput(ctx: PaneContext) {
  return {
    status: (await ctx.cells.statusInfo.get()) ?? (await collectStatus(ctx.status)),
    modelId: await ctx.session.model(),
    cwd: await ctx.session.cwd(),
    cost: await ctx.session.cost(),
  }
}

/** The pane's model: the state read once for this drawing. */
export async function paneModel(ctx: PaneContext, bodyColumns: number, hasField: boolean): Promise<PaneModel> {
  const { cells } = ctx
  const m = ctx.view.messages()
  const locale = ctx.view.locale()
  const release = ctx.view.release()
  const asked = await cells.dialog.get()
  const draft = await cells.webhookDraft.get()
  const now = await ctx.accounts.io.now()
  let webhook: PaneModel['webhook'] = null
  if (asked?.kind === 'webhook' && draft) {
    const input = await feedInput(ctx)
    const last = await cells.webhookLast.get()
    const clock = (at: number) => resetClock(new Date(at).toISOString(), now, locale)
    const config = draftConfig(draft)
    webhook = {
      draft,
      templatePath: (await templatePath(ctx.accounts.io)).replace(ctx.view.homePath(), '~'),
      preview: await webhookPreview(ctx.feed, draft, input.status, input.modelId, input.cwd, input.cost),
      urlProblem: config.enabled || config.url !== '' ? urlMessage(m, urlProblem(config.url)) : null,
      lastSend: last
        ? {
            ...(last.error === null && last.status !== null
              ? { text: m.webhookSent(clock(last.at), last.status), ok: last.status >= 200 && last.status < 300 }
              : { text: m.webhookFailed(clock(last.at), last.error ?? `HTTP ${last.status}`), ok: false }),
            // A send this session kept before a reload of the mod has no reply recorded.
            reply: last.reply ?? null,
          }
        : null,
    }
  }

  return {
    m,
    locale,
    bodyColumns,
    hasField,
    header: {
      brand: paneTitle(MOD_NAME),
      release: release.version ? m.release(release.version, release.date) : undefined,
      isUnderTabs: await ctx.ui.isUnderTabs(),
      columns: bodyColumns,
      exit: { label: `✕ ${m.closeButton}`, onPress: () => void closePane(ctx).catch((error: unknown) => ctx.ui.toast(message(error))) },
      backLabel: m.backButton,
    },
    dialog: asked,
    focused: await cells.focused.get(),
    tab: await cells.tab.get(),
    accounts: await ctx.accounts.accounts.get(),
    liveUuid: await ctx.accounts.live.get(),
    readings: await ctx.accounts.usage.get(),
    isGuideShown: await cells.isGuideOpen.get(),
    isRefreshing: await ctx.accounts.isRefreshing.get(),
    // Reading the tick subscribes the pane to it, so the ages move on while it is open.
    now: Math.max(now, await cells.tick.get()),
    isOrcaSelecting: asked?.kind === 'switch' && (await rememberedOrca(ctx.accounts.io))?.activeId != null,
    webhook,
    usage: { summary: await cells.usageSummary.get(), scan: await cells.usageScan.get(), error: await cells.usageError.get(), period: await cells.usagePeriod.get() },
    storage: { view: await cells.storage.get(), cleanupDays: await cells.cleanupDays.get(), asked: askedCleanup() },
  }
}

/** What the pane's buttons do; each runs its work, and what it returns or throws becomes a toast. */
export function paneActions(ctx: PaneContext): PaneActions {
  const { cells } = ctx
  const m = ctx.view.messages()
  const act =
    (work: () => Promise<string | void>) =>
    (): void => {
      void work()
        .then(text => text && ctx.ui.toast(text))
        .catch((error: unknown) => ctx.ui.toast(message(error)))
    }
  const dismiss = async () => {
    await cells.dialog.set(null)
    await cells.focused.set(null)
  }
  const ask = (next: NonNullable<PaneDialog>) =>
    act(async () => {
      await cells.dialog.set(next)
      // The pane takes the keys so Enter answers; Esc asks it to close, which the ui.close hook turns into Cancel.
      await openPane(ctx, true)
    })
  const edit = (change: (current: WebhookDraft) => WebhookDraft) =>
    act(async () => {
      const current = await cells.webhookDraft.get()
      if (current) await cells.webhookDraft.set(change(current))
    })
  // Back on the cards, the pane takes their height again.
  const leaveWebhook = async () => {
    await cells.webhookDraft.set(null)
    await dismiss()
    await openPane(ctx, true)
  }

  return {
    dismiss: act(dismiss),
    selectTab: key => act(() => showTab(ctx, key))(),
    askSwitch: uuid => ask({ kind: 'switch', uuid })(),
    askRemove: uuid => ask({ kind: 'remove', uuid })(),
    switchTo: uuid =>
      act(async () => {
        await dismiss()
        const text = await switchTo(ctx.accounts, uuid, 'dialog')
        await refreshLive(ctx.accounts)

        return text
      })(),
    remove: uuid =>
      act(async () => {
        await dismiss()

        return remove(ctx.accounts, uuid)
      })(),
    refresh: act(() => refresh(ctx, true)),
    toggleGuide: act(async () => {
      await cells.isGuideOpen.set(!(await cells.isGuideOpen.get()))
    }),
    openWebhook: act(() => openWebhookDialog(ctx)),
    webhook: {
      toggle: edit(current => ({ ...current, enabled: !current.enabled })),
      toggleMethod: edit(current => ({ ...current, method: current.method === 'POST' ? 'GET' : 'POST' })),
      setUrl: url => edit(current => ({ ...current, url }))(),
      setToken: token => edit(current => ({ ...current, token, clearToken: false }))(),
      clearToken: edit(current => ({ ...current, token: '', clearToken: true })),
      test: act(async () => {
        const draft = await cells.webhookDraft.get()
        if (!draft) return
        const input = await feedInput(ctx)
        await testWebhook(ctx.feed, draft, input.status, input.modelId, input.cwd, input.cost)
      }),
      save: act(async () => {
        const draft = await cells.webhookDraft.get()
        if (!draft) return
        const text = await saveWebhook(ctx.feed, draft)
        await leaveWebhook()

        return text
      }),
      cancel: act(leaveWebhook),
    },
    choosePeriod: ask({ kind: 'period' }),
    setPeriod: days =>
      act(async () => {
        await dismiss()
        await cells.usagePeriod.set(days)
        await refreshUsageSummary(ctx.count)
        await openPane(ctx)
      })(),
    countUsage: act(async () => {
      await countUsage(ctx.count)
    }),
    chooseCleanupDays: ask({ kind: 'cleanupDays' }),
    setCleanupDays: days =>
      act(async () => {
        await dismiss()
        await cells.cleanupDays.set(days)
        await openPane(ctx)
      })(),
    askCleanup: act(async () => {
      // The dialog names what a cleanup would delete as measured now; nothing to delete asks nothing.
      if ((await askCleanup(ctx.cleanup)).count === 0) return m.cleanupNothing(await cells.cleanupDays.get())
      await cells.dialog.set({ kind: 'cleanup' })
      await openPane(ctx, true)
    }),
    cleanUp: word => {
      // A word typed wrong deletes nothing and leaves the dialog asking.
      if (word.trim() !== m.cleanupWord) {
        ctx.ui.toast(m.cleanupMismatch(m.cleanupWord))

        return
      }
      act(async () => {
        await dismiss()
        await openPane(ctx)

        return cleanUp(ctx.cleanup, { nothing: m.cleanupNothing, uncounted: m.cleanupUncounted, needsShell: m.usageNeedsShell, done: m.cleanedUp })
      })()
    },
    measureStorage: act(() => measureStorage(ctx.cleanup)),
  }
}

/** Whether this session has been told, once, that clicks need fullscreen mode. */
let isClickHintShown = false

/**
 * Fills the state a session draws from: the accounts, the live one and its
 * usage, this session's lines changed, and whether the pane is open. Run at
 * session start, and again after a /clear, whose new session starts with none.
 */
export async function adoptSession(ctx: PaneContext, sessionId: string): Promise<void> {
  const { io } = ctx.accounts
  await beginSession(ctx.status, sessionId)
  resetFeed()
  // A template file still holding an earlier default sends what the default now sends.
  await upgradeTemplate(io).catch((error: unknown) => io.log(message(error)))
  await loadIndex(ctx.accounts)
  // The machine's shared readings, under what this session already holds.
  const shared = lookedUpOnly(await io.store.get(USAGE_KEY))
  await ctx.accounts.usage.update(map => lookedUpOnly({ ...shared, ...map }))
  await syncPaneOpen(ctx)
  // A fresh shared lookup is reused rather than one of the session's own. Orca is asked first,
  // so the first lookup already knows which logins Orca keeps and never refreshes them.
  void syncLive(ctx.accounts)
    .then(() => tickOrca(ctx.accounts).catch((error: unknown) => io.log(message(error))))
    .then(() => refresh(ctx, false))
    .catch((error: unknown) => io.log(message(error)))
  void collectStatus(ctx.status).catch((error: unknown) => io.log(message(error)))
}

/**
 * Answers `/sc:accounts <verb> <query>`. Off fullscreen no click reaches a
 * pane, so the first pane a command opens says how to press without one.
 */
export async function answerCommand(ctx: PaneContext, args: string, call: { isFullscreen: boolean | undefined; setBand: (isShown: boolean) => Promise<string | undefined> }): Promise<string> {
  const m = ctx.view.messages()
  const hint = call.isFullscreen === false && !isClickHintShown ? ` ${m.clickHint}` : ''
  const opened = () => {
    if (hint !== '') isClickHintShown = true

    return m.paneOpened + hint
  }
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const query = rest.join(' ')
  try {
    if (verb === '' || verb === 'accounts') {
      // The command opens the accounts themselves, on their own tab: a dialog left open is closed first.
      if ((await ctx.cells.dialog.get()) !== null) {
        await ctx.cells.dialog.set(null)
        await ctx.cells.webhookDraft.set(null)
      }
      await showTab(ctx, 'accounts')

      return opened()
    }
    if (verb === 'usage' || verb === 'storage') {
      await showTab(ctx, verb)

      return opened()
    }
    if (verb === 'list') return await listText(ctx)
    if (verb === 'refresh') {
      await refresh(ctx, true)

      return await listText(ctx)
    }
    if (verb === 'add') return m.addGuide
    if (verb === 'webhook') {
      await openWebhookDialog(ctx)

      return opened()
    }
    if (verb === 'band') {
      if (query !== 'on' && query !== 'off') return m.bandUsage

      return (await call.setBand(query === 'on')) ?? (query === 'on' ? m.bandShown : m.bandHidden)
    }
    if (verb === 'use') {
      const target = pick(await ctx.accounts.accounts.get(), query)
      if (!target) return `${m.noMatch(query)}\n${await listText(ctx)}`
      const text = await switchTo(ctx.accounts, target.uuid, 'command')
      await refreshLive(ctx.accounts)

      return text
    }
    if (verb === 'remove') {
      // Removing deletes the saved login, which only a new /login brings back: the account is named whole.
      const target = pickExact(await ctx.accounts.accounts.get(), query)
      if (!target) return `${m.removeNeedsEmail(query)}\n${await listText(ctx)}`

      return await remove(ctx.accounts, target.uuid)
    }

    return m.unknownVerb(verb)
  } catch (error) {
    return `account-switch: ${message(error)}`
  }
}
