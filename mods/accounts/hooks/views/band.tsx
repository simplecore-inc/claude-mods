import type { ElementTable } from 'claude-code'

import type { AccountView, LimitView, StatusInfo, UsageView } from '../../types'
import { bar, barParts, displayWidth, packRows, resetClock, severityColor } from '../format'
import type { Locale } from '../i18n'
import { ansiHex, contextLabelColor, contextScaled, modelPill, pillWidth, placePill, reviewMark } from '../statusline'
import type { PillSegment } from '../statusline'
import { STALE_MARK } from './accounts'
import { GAUGE_WIDTH as BAR_WIDTH } from '../shared/kit'

/** The xterm-256 ground behind the context gauge. */
const CONTEXT_GROUND = 236
/** Cells between two cells of the band's status line. */
const STATUS_GAP = 1

export type BandModel = {
  status: StatusInfo | null
  account: AccountView | undefined
  reading: UsageView | undefined
  windows: LimitView[]
  contextUsed: number | null
  now: number
  locale: Locale
  /** Cells the band may fill across. */
  room: number
}

/**
 * The status on the band above the prompt, on one line that wraps only where
 * the band runs out of room: model and effort, the task, the live account,
 * the context gauge, the usage windows, the place and the lines changed.
 */
export function StatusBand(ui: ElementTable, model: BandModel) {
  const { Box, Text } = ui
  const { status, account, reading, windows, contextUsed, now, locale, room } = model

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
}
