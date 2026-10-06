import type { ElementTable } from 'claude-code'

import type { AccountView, LimitView, UsageView } from '../../types'
import { moneyText } from '../anthropic'
import { bar, displayWidth, formatDuration, isSameReset, packRows, resetCountdown, resetText } from '../format'
import type { Locale, Messages } from '../i18n'
import { Badge, Card, CARD_CHROME, CELL_GAP, countdownTone, Empty, Gauge, GAUGE_WIDTH, IconButton, theme, TileButton, Toned } from '../shared/kit'

export const STALE_MARK = '◷'

export type AccountsModel = {
  list: AccountView[]
  liveUuid: string | null
  readings: Record<string, UsageView>
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

export function AccountsTab(ui: ElementTable, model: AccountsModel, actions: AccountsActions) {
  const { Box, Text } = ui
  const { list, liveUuid, readings, now, locale, m } = model
  // The card's border and padding take CARD_CHROME cells, the limits' indent two more.
  const room = Math.max(20, model.bodyColumns - CARD_CHROME - 2)
  // One gauge width for every card, so the columns line up across them.
  const cellsOf = new Map(list.map(one => [one.uuid, limitCells(readings[one.uuid], now, locale, m)]))
  const slot = gaugeSlot([...cellsOf.values()].flat())
  const spanOf = (count: number) => count * slot + CELL_GAP * (count - 1)

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
              {packRows(
                (cellsOf.get(one.uuid) ?? []).map(cell => ({ ...cell, width: spanOf(cell.group.length) })),
                room,
                CELL_GAP,
              ).map((row, rowIndex) => (
                <Box key={`${one.uuid}-limits-${rowIndex}`} gap={CELL_GAP}>
                  {row.map(({ group, foot, near, width }) => (
                    <Box key={`${one.uuid}-${group[0]?.label}`} flexDirection="column" width={width}>
                      <Box gap={CELL_GAP}>
                        {/* A lone gauge fills its slot; gauges that reset together stand side by side
                            as one block, which takes the slots they span. */}
                        {group.length === 1
                          ? group.map(limit => (
                              <Box key={`${one.uuid}-${limit.label}-slot`} width={slot} flexShrink={0}>
                                {Gauge(ui, `${one.uuid}-${limit.label}`, limit.label, limit.percent, undefined, near)}
                              </Box>
                            ))
                          : group.map(limit => Gauge(ui, `${one.uuid}-${limit.label}`, limit.label, limit.percent, undefined, near))}
                      </Box>
                      {foot !== '' && Toned(ui, `${one.uuid}-${group[0]?.label}-reset`, foot, near, near ? { isBold: true } : { isDim: true })}
                    </Box>
                  ))}
                </Box>
              ))}
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
