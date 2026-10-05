import type { ElementTable } from 'claude-code'

import type { UsageSummary } from '../../types'
import type { Messages } from '../i18n'
import { BarChart, Card, CARD_CHROME, Empty, RankList, Section, SelectField, StatRow } from '../shared/kit'
import { cacheReuse, compactCount, totalOf } from '../usage'

export type UsageModel = {
  summary: UsageSummary | null
  /** Files counted of all to count, while a count runs. */
  scan: { done: number; total: number } | null
  error: string | null
  /** The period in days; 0 for everything counted. */
  period: number
  m: Messages
  bodyColumns: number
}

export type UsageActions = {
  /** Opens the dialog that picks the period. */
  choosePeriod: () => void
}

/** Rows of the daily chart. */
const CHART_ROWS = 6

export function UsageTab(ui: ElementTable, model: UsageModel, actions: UsageActions) {
  const { Box, Text } = ui
  const { m, summary } = model
  if (model.error) return Empty(ui, 'usage-error', [model.error])
  const inner = Math.max(20, model.bodyColumns - CARD_CHROME)
  const reuse = summary ? cacheReuse(summary.totals) : null

  return (
    <Box key="usage" flexDirection="column" gap={1}>
      <Box key="usage-head" flexDirection="column">
        {Section(ui, 'usage-title', m.usageTitle, m.usageDetail)}
        <Box key="usage-period" gap={1} marginTop={1}>
          <Text dimColor>{m.usagePeriodLabel}</Text>
          {SelectField(ui, 'usage-period-field', m.usagePeriod(model.period), actions.choosePeriod)}
        </Box>
        {model.scan && <Text dimColor>{m.usageScanning(model.scan.done, model.scan.total)}</Text>}
      </Box>
      {!summary && !model.scan && Empty(ui, 'usage-loading', [m.loading])}
      {summary && summary.totals.responses === 0 && Empty(ui, 'usage-empty', [m.usageEmpty])}
      {summary && summary.totals.responses > 0 && (
        <Box key="usage-body" flexDirection="column" gap={1}>
          <Box key="usage-totals" flexDirection="column">
            {StatRow(ui, 'usage-stats', [
              { label: m.tokensInput, value: compactCount(summary.totals.input) },
              { label: m.tokensOutput, value: compactCount(summary.totals.output) },
              { label: m.tokensCacheRead, value: compactCount(summary.totals.cacheRead) },
              { label: m.tokensCacheWrite, value: compactCount(summary.totals.cacheWrite) },
              ...(reuse === null ? [] : [{ label: m.cacheReuse, value: `${Math.round(reuse * 100)}%` }]),
            ])}
            <Text dimColor>{m.sessionsResponses(summary.sessions, summary.totals.responses)}</Text>
          </Box>
          {Section(ui, 'usage-daily-title', m.dailyTitle)}
          {Card(
            ui,
            'usage-daily',
            false,
            BarChart(
              ui,
              'usage-chart',
              summary.daily.map(day => ({ label: day.day, value: totalOf(day.tokens) })),
              inner,
              CHART_ROWS,
              `▲ ${compactCount(Math.max(0, ...summary.daily.map(day => totalOf(day.tokens))))}`,
            ),
          )}
          {Section(ui, 'usage-models-title', m.byModel)}
          {Card(
            ui,
            'usage-models',
            false,
            RankList(
              ui,
              'usage-model-rows',
              summary.models.map(row => ({ name: row.name, detail: m.rankSessions(row.sessions), value: compactCount(totalOf(row.tokens)) })),
              inner,
            ),
          )}
          {Section(ui, 'usage-projects-title', m.byProject)}
          {Card(
            ui,
            'usage-projects',
            false,
            RankList(
              ui,
              'usage-project-rows',
              summary.projects.map(row => ({ name: row.name, detail: m.rankSessions(row.sessions), value: compactCount(totalOf(row.tokens)) })),
              inner,
            ),
          )}
          <Text dimColor wrap="wrap">
            {m.cacheReuseHint}
          </Text>
        </Box>
      )}
    </Box>
  )
}
