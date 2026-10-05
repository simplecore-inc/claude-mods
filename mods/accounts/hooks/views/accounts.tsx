import type { ElementTable } from 'claude-code'

import type { AccountView, LimitView, UsageView } from '../../types'
import { moneyText } from '../anthropic'
import { bar, displayWidth, formatDuration, isSameReset, packRows, resetText } from '../format'
import type { Locale, Messages } from '../i18n'
import { Badge, Card, CARD_CHROME, CELL_GAP, Empty, Gauge, GAUGE_WIDTH, IconButton, theme, TileButton, Toned } from '../shared/kit'

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
    const heads = group.map(limit => `${limit.label} ${bar(limit.percent, GAUGE_WIDTH)} ${Math.round(limit.percent)}%`)
    const reset = resetText(group[0]?.resetsAt, now, locale, m.now)
    const foot = reset ? `↻ ${reset}` : ''
    const headWidth = heads.reduce((sum, head) => sum + displayWidth(head), 0) + CELL_GAP * (heads.length - 1)

    return { group, foot, width: Math.max(headWidth, displayWidth(foot)) }
  })
}

export function AccountsTab(ui: ElementTable, model: AccountsModel, actions: AccountsActions) {
  const { Box, Text } = ui
  const { list, liveUuid, readings, now, locale, m } = model
  // The card's border and padding take CARD_CHROME cells, the limits' indent two more.
  const room = Math.max(20, model.bodyColumns - CARD_CHROME - 2)

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
                <Text bold={isLive}>{one.email}</Text>
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
              {packRows(limitCells(reading, now, locale, m), room, CELL_GAP).map((row, rowIndex) => (
                <Box key={`${one.uuid}-limits-${rowIndex}`} gap={CELL_GAP}>
                  {row.map(({ group, foot, width }) => (
                    <Box key={`${one.uuid}-${group[0]?.label}`} flexDirection="column" width={width}>
                      <Box gap={CELL_GAP}>
                        {group.map(limit => Gauge(ui, `${one.uuid}-${limit.label}`, limit.label, limit.percent))}
                      </Box>
                      {foot !== '' && <Text dimColor>{foot}</Text>}
                    </Box>
                  ))}
                </Box>
              ))}
              {!reading && <Text dimColor>{m.loading}</Text>}
              {reading?.error && Toned(ui, `error-${one.uuid}`, reading.error, 'danger')}
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
