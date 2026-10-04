import type { ElementTable } from 'claude-code'

import type { CheckpointRow } from '../../types'
import { displayWidth, padCells, truncate } from '../shared/layout'
import { resetClock } from '../shared/time'
import type { Locale, Messages } from '../i18n'
import { Card, CARD_CHROME, Empty, IconButton, Section, theme } from '../shared/kit'

export type CheckpointsModel = {
  checkpoints: CheckpointRow[]
  repoError: string | null
  now: number
  locale: Locale
  m: Messages
  bodyColumns: number
  /** Rows shown before the rest are summed up in one line. */
  limit: number
}

export type CheckpointsActions = {
  restore: (row: CheckpointRow) => void
  compare: (row: CheckpointRow) => void
}

const KIND_MARK: Record<CheckpointRow['kind'], string> = { turn: '›', session: '◆', manual: '✚', restore: '↺' }
/** Cells between the counts and each button on a row's right side. */
const RIGHT_GAP = 2
/** Cells kept for the restore button, so rows without one line up. */
const RESTORE_SLOT = 1

/** A checkpoint's time: `14:03` today, otherwise with its date. */
export function clockOf(at: number, now: number, locale: Locale): string {
  return resetClock(new Date(at).toISOString(), now, locale)
}

export function CheckpointsTab(ui: ElementTable, model: CheckpointsModel, actions: CheckpointsActions) {
  const { Box, Text } = ui
  const { m } = model
  if (model.repoError) return Empty(ui, 'checkpoints-error', [model.repoError, m.checkpointsNeedGit])
  const shown = model.checkpoints.slice(0, model.limit)
  const hidden = model.checkpoints.length - shown.length
  const clocks = shown.map(row => clockOf(row.at, model.now, model.locale))
  const counts = shown.map(row =>
    row.since === undefined ? '…' : row.since.files === 0 ? m.noChangesSince : `${m.filesCount(row.since.files)} +${row.since.added} −${row.since.removed}`,
  )
  // Every row shares one time width and one counts width, so the columns line up;
  // the label takes what is left and is cut to it, never wrapped.
  const clockWidth = Math.max(0, ...clocks.map(displayWidth))
  const countsWidth = Math.max(0, ...counts.map(displayWidth))
  const rightWidth = countsWidth + RIGHT_GAP + 1 + RIGHT_GAP + RESTORE_SLOT
  const labelRoom = Math.max(6, model.bodyColumns - CARD_CHROME - 2 - clockWidth - 1 - rightWidth - 1)

  return (
    <Box key="checkpoints" flexDirection="column">
      {Section(ui, 'checkpoints-title', m.checkpointsTitle, m.checkpointsDetail(model.checkpoints.length))}
      {model.checkpoints.length === 0 && Empty(ui, 'checkpoints-empty', [m.checkpointsEmpty, m.checkpointsEmptyHint])}
      {shown.length > 0 &&
        Card(
          ui,
          'checkpoints-card',
          false,
          <Box flexDirection="column">
            {shown.map((row, index) => {
              const label = truncate(row.label || m.checkpointKind[row.kind], labelRoom)
              const since = row.since

              return (
                <Box key={`checkpoint-${row.ref}`} justifyContent="space-between">
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text color={index === 0 ? theme.accent : undefined} dimColor={index !== 0}>{`${KIND_MARK[row.kind]} `}</Text>
                      <Text dimColor>{`${padCells(clocks[index] ?? '', clockWidth)} `}</Text>
                      <Text>{label}</Text>
                    </Text>
                  </Box>
                  <Box key={`checkpoint-right-${row.ref}`} gap={RIGHT_GAP} flexShrink={0} marginLeft={1}>
                    {since === undefined || since.files === 0 ? (
                      <Text dimColor>{padCells(counts[index] ?? '', countsWidth, 'start')}</Text>
                    ) : (
                      <Text>
                        <Text dimColor>{padCells(`${m.filesCount(since.files)} `, countsWidth - displayWidth(`+${since.added} −${since.removed}`), 'start')}</Text>
                        <Text color={theme.ok}>{`+${since.added}`}</Text>
                        <Text> </Text>
                        <Text color={theme.danger}>{`−${since.removed}`}</Text>
                      </Text>
                    )}
                    {IconButton(ui, `compare-${row.ref}`, 'Δ', theme.accent, () => actions.compare(row))}
                    <Box width={RESTORE_SLOT}>
                      {since?.files === 0 ? (
                        <Text> </Text>
                      ) : (
                        // Restoring rewrites the working tree, so it asks in a dialog, not by a second press.
                        IconButton(ui, `restore-${row.ref}`, '↺', theme.warn, () => actions.restore(row))
                      )}
                    </Box>
                  </Box>
                </Box>
              )
            })}
            {hidden > 0 && <Text dimColor>{m.olderCheckpoints(hidden)}</Text>}
          </Box>,
        )}
    </Box>
  )
}
