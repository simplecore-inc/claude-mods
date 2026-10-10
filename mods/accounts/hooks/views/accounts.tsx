import type { ElementTable } from 'claude-code'

import type { AccountView, CodexAccountView, LimitView, UsageView } from '../../types'
import { moneyText } from '../anthropic'
import { bar, displayWidth, formatDuration, groupDecimal, isSameReset, packRows, resetCountdown, resetText } from '../format'
import type { Locale, Messages } from '../i18n'
import { Badge, Card, CARD_CHROME, CELL_GAP, countdownTone, Empty, Gauge, GAUGE_WIDTH, IconButton, theme, TileButton, Toned } from '../shared/kit'

export const STALE_MARK = '◷'
/** The product the Codex card is for, as its name is written. */
const CODEX_NAME = 'Codex'

export type AccountsModel = {
  list: AccountView[]
  liveUuid: string | null
  readings: Record<string, UsageView>
  /** The Codex account this session's Codex uses; null where the Codex CLI does not run, and no card is drawn. */
  codex: CodexAccountView | null
  isGuideShown: boolean
  now: number
  locale: Locale
  m: Messages
  bodyColumns: number
}

export type AccountsActions = {
  switchTo: (uuid: string) => void
  remove: (uuid: string) => void
}

/**
 * How long ago an account's figures were looked up, to the minute, in
 * parentheses: `(updated 12m ago)`. Empty under a minute, and with no figures
 * to date.
 */
export function updatedText(reading: UsageView | undefined, now: number, m: Messages): string {
  if (!reading || reading.limits.length === 0) return ''
  const age = now - reading.fetchedAt

  return age < 60_000 ? '' : `(${m.updatedAgo(formatDuration(age))})`
}

/** Windows that reset together share one cell: their gauges side by side, one reset line. */
function limitCells(reading: UsageView | undefined, now: number, locale: Locale, m: Messages) {
  const groups: LimitView[][] = []
  for (const limit of reading?.limits ?? []) {
    const together = groups.find(
      group => group[0] && group[0].label !== '5h' && limit.label !== '5h' && isSameReset(group[0].resetsAt, limit.resetsAt),
    )
    if (together) together.push(limit)
    else groups.push([limit])
  }

  return groups.map(group => {
    const reset = resetText(group[0]?.resetsAt, now, locale, m.now)
    // A weekly window's last three days colour its labels and its reset; the five-hour window never counts down.
    const near = group[0]?.label === '5h' ? undefined : countdownTone(resetCountdown(group[0]?.resetsAt, now))

    return { group, foot: reset ? `↻ ${reset}` : '', near }
  })
}

/**
 * The cells every gauge of every card takes, so the gauges stand in the same
 * columns on every card whatever a window shows: the widest gauge, its figure
 * counted as `100%`, and wide enough that a group's reset line fits under the
 * gauges it spans.
 */
export function gaugeSlot(cells: { group: LimitView[]; foot: string }[]): number {
  let slot = 0
  for (const { group, foot } of cells) {
    for (const limit of group) slot = Math.max(slot, displayWidth(`${limit.label} ${bar(100, GAUGE_WIDTH)} 100%`))
    slot = Math.max(slot, Math.ceil((displayWidth(foot) - CELL_GAP * (group.length - 1)) / Math.max(1, group.length)))
  }

  return slot
}

type LimitCell = ReturnType<typeof limitCells>[number]

/**
 * A card's gauges, packed into rows of the room there is: each cell one
 * gauge, or the gauges of windows that reset together, over its reset line.
 * Every card passes the same `slot`, so the gauges line up across them.
 */
function LimitRows(ui: ElementTable, id: string, cells: LimitCell[], slot: number, room: number) {
  const { Box } = ui
  const spanOf = (count: number) => count * slot + CELL_GAP * (count - 1)

  return packRows(
    cells.map(cell => ({ ...cell, width: spanOf(cell.group.length) })),
    room,
    CELL_GAP,
  ).map((row, rowIndex) => (
    <Box key={`${id}-limits-${rowIndex}`} gap={CELL_GAP}>
      {row.map(({ group, foot, near, width }) => (
        <Box key={`${id}-${group[0]?.label}`} flexDirection="column" width={width}>
          <Box gap={CELL_GAP}>
            {/* A lone gauge fills its slot; gauges that reset together stand side by side
                as one block, which takes the slots they span. */}
            {group.length === 1
              ? group.map(limit => (
                  <Box key={`${id}-${limit.label}-slot`} width={slot} flexShrink={0}>
                    {Gauge(ui, `${id}-${limit.label}`, limit.label, limit.percent, undefined, near)}
                  </Box>
                ))
              : group.map(limit => Gauge(ui, `${id}-${limit.label}`, limit.label, limit.percent, undefined, near))}
          </Box>
          {foot !== '' && Toned(ui, `${id}-${group[0]?.label}-reset`, foot, near, near ? { isBold: true } : { isDim: true })}
        </Box>
      ))}
    </Box>
  ))
}

/** The Codex login's words on its card: the email and plan, the API key, or that no one is logged in. */
function codexWho(codex: CodexAccountView, m: Messages): { name: string; plan: string } {
  const login = codex.login
  if (login?.kind === 'chatgpt') {
    const plan = login.plan ? `${login.plan.charAt(0).toUpperCase()}${login.plan.slice(1)}` : ''

    return { name: login.email ?? '', plan }
  }

  return { name: login?.kind === 'apiKey' ? m.codexApiKey : '', plan: '' }
}

/** The Codex card: the login this session's Codex uses, its windows on the Claude cards' gauges, and its credits. */
function CodexCard(ui: ElementTable, codex: CodexAccountView, cells: LimitCell[], slot: number, room: number, now: number, m: Messages) {
  const { Box, Text } = ui
  const reading = codex.reading
  const who = codexWho(codex, m)
  const updated = updatedText(reading, now, m)
  const credits = codex.credits
  const creditsLine = !credits ? '' : credits.isUnlimited ? m.codexCreditsUnlimited : credits.balance === null ? '' : m.codexCredits(groupDecimal(credits.balance))

  return Card(
    ui,
    'codex-card',
    false,
    <Box flexDirection="column">
      <Text>
        {Toned(ui, 'codex-name', CODEX_NAME, undefined, { isBold: true })}
        {who.name !== '' && Toned(ui, 'codex-email', `  ${who.name}`)}
        {who.plan !== '' && Toned(ui, 'codex-plan', `  ${who.plan}`, undefined, { isDim: true })}
        {updated !== '' && <Text dimColor>{`  ${updated}`}</Text>}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {LimitRows(ui, 'codex', cells, slot, room)}
        {!reading && <Text dimColor>{m.loading}</Text>}
        {codex.login?.kind === 'none' && Toned(ui, 'codex-signed-out', m.codexSignedOut, 'warn')}
        {reading?.error && Toned(ui, 'codex-error', reading.error, 'danger')}
        {creditsLine !== '' && Toned(ui, 'codex-credits', creditsLine, undefined, { isDim: true })}
      </Box>
    </Box>,
  )
}

export function AccountsTab(ui: ElementTable, model: AccountsModel, actions: AccountsActions) {
  const { Box, Text } = ui
  const { list, liveUuid, readings, now, locale, m } = model
  // The card's border and padding take CARD_CHROME cells, the limits' indent two more.
  const room = Math.max(20, model.bodyColumns - CARD_CHROME - 2)
  // One gauge width for every card, so the columns line up across them.
  const cellsOf = new Map(list.map(one => [one.uuid, limitCells(readings[one.uuid], now, locale, m)]))
  const codexCells = model.codex ? limitCells(model.codex.reading, now, locale, m) : []
  const slot = gaugeSlot([...[...cellsOf.values()].flat(), ...codexCells])

  return (
    <Box key="accounts" flexDirection="column">
      {list.length === 0 && Empty(ui, 'accounts-empty', [m.noAccountsYet])}
      {list.map(one => {
        const reading = readings[one.uuid]
        const isLive = one.uuid === liveUuid
        const updated = updatedText(reading, now, m)

        return Card(
          ui,
          `row-${one.uuid}`,
          isLive,
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text>
                {Toned(ui, `live-${one.uuid}`, isLive ? '● ' : '○ ', isLive ? 'accent' : undefined, { isDim: !isLive })}
                {/* The account in use reads in the colour of its Active badge. */}
                {Toned(ui, `email-${one.uuid}`, one.email, isLive ? 'accent' : undefined, { isBold: isLive })}
                {isLive && <Text> </Text>}
                {isLive && Badge(ui, `active-${one.uuid}`, m.active)}
                {reading?.isStale && Toned(ui, `stale-${one.uuid}`, ` ${STALE_MARK}`, 'stale', { isDim: true })}
                {updated !== '' && <Text dimColor>{`  ${updated}`}</Text>}
              </Text>
              {!isLive && (
                <Box gap={2} alignItems="center">
                  {TileButton(ui, `use-${one.uuid}`, m.switchButton, () => actions.switchTo(one.uuid))}
                  {/* Removing asks in a dialog first. */}
                  {IconButton(ui, `remove-${one.uuid}`, '✕', theme.danger, () => actions.remove(one.uuid))}
                </Box>
              )}
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {LimitRows(ui, one.uuid, cellsOf.get(one.uuid) ?? [], slot, room)}
              {!reading && <Text dimColor>{m.loading}</Text>}
              {reading?.error && Toned(ui, `error-${one.uuid}`, reading.error, 'danger')}
              {/* Orca keeps this login and its token is not refreshed here: the figures age until the account is in use. */}
              {reading?.isHeld && Toned(ui, `held-${one.uuid}`, m.heldByOrca, undefined, { isDim: true })}
              {/* Only what the usage endpoint reported for this account, as it reported it. */}
              {reading?.spend &&
                Toned(
                  ui,
                  `spend-${one.uuid}`,
                  m.spendLine(moneyText(reading.spend.used), reading.spend.limit ? moneyText(reading.spend.limit) : undefined),
                  undefined,
                  { isDim: true },
                )}
            </Box>
          </Box>,
        )
      })}
      {model.codex && CodexCard(ui, model.codex, codexCells, slot, room, now, m)}
      {model.isGuideShown && (
        <Box key="guide" flexDirection="column" marginTop={1} paddingLeft={2}>
          {m.addGuide.split('\n').map((line, index) => (
            <Text key={`guide-${index}`} dimColor={index > 0}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
