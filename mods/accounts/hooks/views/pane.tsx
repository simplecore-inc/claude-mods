import type { ElementTable } from 'claude-code'

import type { AccountView, AccountsTabKey, CodexAccountView, StorageView, UsageSummary, UsageView } from '../../types'
import type { Locale, Messages } from '../i18n'
import { ChoiceDialog, Dialog, Header, InputDialog, TabBar, Tiles } from '../shared/kit'
import type { DialogLine, HeaderInfo } from '../shared/kit'
import { byteSize } from '../storage'
import { AccountsTab } from './accounts'
import { StorageTab } from './storage'
import { UsageTab } from './usage'
import { WebhookDialog } from './webhook'
import type { WebhookModel } from './webhook'

/**
 * The accounts pane: a dialog in place of the tabs while one asks, else the
 * header, the tab bar and the tab on screen. Pure: the hooks module reads the
 * state into the model and builds the actions over `$`.
 */

/** The idle ages a cleanup offers, in days. */
export const CLEANUP_DAYS = [7, 14, 30, 90]
/** The periods the Usage tab offers, in days; 0 is everything counted. */
export const USAGE_PERIODS = [7, 30, 0]

export type PaneDialog =
  | { kind: 'remove'; uuid: string }
  | { kind: 'switch'; uuid: string }
  | { kind: 'webhook' }
  | { kind: 'period' }
  | { kind: 'cleanupDays' }
  | { kind: 'cleanup' }
  | null

export type PaneModel = {
  m: Messages
  locale: Locale
  bodyColumns: number
  /** Whether the surface has a text field (every one but mobile). */
  hasField: boolean
  header: HeaderInfo
  dialog: PaneDialog
  focused: string | null
  tab: AccountsTabKey
  accounts: AccountView[]
  liveUuid: string | null
  readings: Record<string, UsageView>
  /** The Codex account this session's Codex uses; null where the Codex CLI does not run. */
  codex: CodexAccountView | null
  isGuideShown: boolean
  isRefreshing: boolean
  now: number
  /** Whether Orca writes the Claude login here, so a switch selects the account there too. */
  isOrcaSelecting: boolean
  webhook: Pick<WebhookModel, 'draft' | 'templatePath' | 'preview' | 'urlProblem' | 'lastSend'> | null
  usage: { summary: UsageSummary | null; scan: { done: number; total: number } | null; error: string | null; period: number }
  storage: { view: StorageView | null; cleanupDays: number; asked: { count: number; bytes: number } }
}

/** Each action is already wrapped by the hooks module: it runs, and what it returns or throws becomes a toast. */
export type PaneActions = {
  dismiss: () => void
  selectTab: (key: AccountsTabKey) => void
  askSwitch: (uuid: string) => void
  askRemove: (uuid: string) => void
  switchTo: (uuid: string) => void
  remove: (uuid: string) => void
  refresh: () => void
  toggleGuide: () => void
  openWebhook: () => void
  webhook: {
    toggle: () => void
    toggleMethod: () => void
    setUrl: (url: string) => void
    setToken: (token: string) => void
    clearToken: () => void
    test: () => void
    save: () => void
    cancel: () => void
  }
  choosePeriod: () => void
  setPeriod: (days: number) => void
  countUsage: () => void
  chooseCleanupDays: () => void
  setCleanupDays: (days: number) => void
  askCleanup: () => void
  /** Called with the word typed into the cleanup dialog. */
  cleanUp: (word: string) => void
  measureStorage: () => void
}

export function AccountsPane(ui: ElementTable, model: PaneModel, actions: PaneActions) {
  const { Box } = ui
  const { m, bodyColumns, header, dialog, focused } = model
  const cancel = { label: m.cancel, onPress: actions.dismiss }
  if (dialog?.kind === 'webhook' && model.webhook) {
    const { draft, templatePath, preview, urlProblem, lastSend } = model.webhook

    return WebhookDialog(ui, { draft, templatePath, preview, urlProblem, lastSend, now: model.now, hasField: model.hasField, m, bodyColumns, header, focused }, actions.webhook)
  }
  if (dialog?.kind === 'period') {
    return ChoiceDialog(
      ui,
      bodyColumns,
      header,
      m.usagePeriodTitle,
      USAGE_PERIODS.map(days => ({ key: `period-${days}`, label: m.usagePeriod(days), isCurrent: days === model.usage.period, onPress: () => actions.setPeriod(days) })),
      cancel,
      focused,
    )
  }
  if (dialog?.kind === 'cleanupDays') {
    return ChoiceDialog(
      ui,
      bodyColumns,
      header,
      m.cleanupDaysTitle,
      CLEANUP_DAYS.map(days => ({ key: `cleanup-days-${days}`, label: m.cleanupDays(days), isCurrent: days === model.storage.cleanupDays, onPress: () => actions.setCleanupDays(days) })),
      cancel,
      focused,
    )
  }
  if (dialog?.kind === 'cleanup') {
    const { asked, cleanupDays } = model.storage

    // Deleting sessions cannot be undone, so the word has to be typed, not a button pressed.
    return InputDialog(
      ui,
      bodyColumns,
      header,
      m.cleanupTitle(asked.count, byteSize(asked.bytes)),
      [{ text: m.cleanupWhat(cleanupDays) }, { text: m.cleanupKeeps, tone: 'muted' }, { text: m.cleanupNoResume, tone: 'danger' }, { text: m.cleanupTypeHint(m.cleanupWord) }],
      {
        key: 'cleanup-word',
        placeholder: m.cleanupPlaceholder(m.cleanupWord),
        submitLabel: m.cleanupConfirm,
        hasField: model.hasField,
        noInput: m.cleanupNoField,
        onSubmit: actions.cleanUp,
      },
      cancel,
      focused,
    )
  }
  const switching = dialog?.kind === 'switch' ? model.accounts.find(one => one.uuid === dialog.uuid) : undefined
  if (switching) {
    // With Orca writing the Claude login here, the switch selects the account in Orca too.
    const lines: DialogLine[] = [{ text: m.switchHint, tone: 'muted' }, ...(model.isOrcaSelecting ? [{ text: m.switchOrcaHint, tone: 'muted' } as const] : [])]

    // Cancel holds the keyboard first: an Enter meant for the prompt never switches every session's login.
    return Dialog(ui, bodyColumns, header, m.switchTitle(switching.email), lines, { label: m.switchButton, onPress: () => actions.switchTo(switching.uuid) }, cancel, focused, 'cancel')
  }
  const removing = dialog?.kind === 'remove' ? model.accounts.find(one => one.uuid === dialog.uuid) : undefined
  if (removing) {
    return Dialog(
      ui,
      bodyColumns,
      header,
      m.removeTitle(removing.email),
      [{ text: m.removeHint, tone: 'muted' }],
      { label: m.removeConfirm, onPress: () => actions.remove(removing.uuid) },
      cancel,
      focused,
      'cancel',
    )
  }

  const tabs = [
    { key: 'accounts', label: m.tabAccounts, hotkey: '1', badge: model.accounts.length > 0 ? `${model.accounts.length}` : undefined },
    { key: 'usage', label: m.tabUsage, hotkey: '2' },
    { key: 'storage', label: m.tabStorage, hotkey: '3' },
  ]
  const select = (key: string) => actions.selectTab(key as AccountsTabKey)
  if (model.tab === 'storage') {
    return (
      <Box flexDirection="column">
        {Header(ui, header)}
        {TabBar(ui, tabs, model.tab, select)}
        <Box key="body-storage" flexDirection="column" marginTop={1}>
          {StorageTab(
            ui,
            { storage: model.storage.view, cleanupDays: model.storage.cleanupDays, now: model.now, locale: model.locale, m, bodyColumns },
            { chooseDays: actions.chooseCleanupDays, cleanUp: actions.askCleanup },
          )}
        </Box>
        {Tiles(ui, bodyColumns, [{ key: 'refresh', label: m.refreshButton, isMain: true, onPress: actions.measureStorage }])}
      </Box>
    )
  }
  if (model.tab === 'usage') {
    return (
      <Box flexDirection="column">
        {Header(ui, header)}
        {TabBar(ui, tabs, model.tab, select)}
        <Box key="body-usage" flexDirection="column" marginTop={1}>
          {UsageTab(ui, { ...model.usage, m, bodyColumns }, { choosePeriod: actions.choosePeriod })}
        </Box>
        {Tiles(ui, bodyColumns, [{ key: 'refresh', label: model.usage.scan ? m.refreshingButton : m.refreshButton, isMain: true, onPress: actions.countUsage }])}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {Header(ui, header)}
      {TabBar(ui, tabs, model.tab, select)}
      {AccountsTab(
        ui,
        {
          list: model.accounts,
          liveUuid: model.liveUuid,
          readings: model.readings,
          codex: model.codex,
          isGuideShown: model.isGuideShown,
          now: model.now,
          locale: model.locale,
          m,
          bodyColumns,
        },
        // Switching changes every session's login, so it asks first, Cancel holding the keyboard.
        { switchTo: actions.askSwitch, remove: actions.askRemove },
      )}
      {Tiles(ui, bodyColumns, [
        { key: 'refresh', label: model.isRefreshing ? m.refreshingButton : m.refreshButton, isMain: true, onPress: actions.refresh },
        { key: 'add', label: m.addButton, onPress: actions.toggleGuide },
        { key: 'webhook', label: m.webhookButton, onPress: actions.openWebhook },
      ])}
    </Box>
  )
}
