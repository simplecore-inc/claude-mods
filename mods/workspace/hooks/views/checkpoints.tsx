import type { ElementTable } from 'claude-code'

import type { CheckpointRow } from '../../types'
import { displayWidth, padCells, printable, truncate } from '../shared/layout'
import { promptLabel } from '../git'
import { resetClock } from '../shared/time'
import type { Locale, Messages } from '../i18n'
import { Card, CARD_CHROME, ChangeCounts, Empty, IconButton, Section, theme, Toned } from '../shared/kit'

export type CheckpointsModel = {
  checkpoints: CheckpointRow[]
  repoError: string | null
  now: number
  locale: Locale
  m: Messages
  bodyColumns: number
  /** Rows shown before the rest are summed up in one line. */
  limit: number
  /** Whether one is taken before every prompt (the `checkpointEveryPrompt` setting), or only when asked. */
  isEveryPrompt: boolean
}

export type CheckpointsActions = {
  restore: (row: CheckpointRow) => void
  compare: (row: CheckpointRow) => void
  /** Opens the Diff tab on what one turn changed: from this checkpoint to the next one taken. */
  compareTurn: (row: CheckpointRow, next: CheckpointRow) => void
  /** Asks for a name, which pins the checkpoint too. */
  name: (row: CheckpointRow) => void
  togglePin: (row: CheckpointRow) => void
}

const KIND_MARK: Record<CheckpointRow['kind'], string> = { turn: '›', session: '◆', manual: '✚', restore: '↺' }
/** Cells between the counts and each button on a row's right side. */
const RIGHT_GAP = 2
/** Cells kept for a button a row may lack (the turn's changes, restore), so rows line up. */
const RESTORE_SLOT = 1
/** The buttons on a row's right side: compare, the turn's changes, name, pin, restore. */
const BUTTONS = 5

/** A checkpoint's time: `14:03` today, otherwise with its date. */
export function clockOf(at: number, now: number, locale: Locale): string {
  return resetClock(new Date(at).toISOString(), now, locale)
}

/**
 * A checkpoint's name: the one the person gave it, else what they wrote in
 * its prompt, else its kind when nothing readable is left.
 */
export function checkpointLabel(row: Pick<CheckpointRow, 'label' | 'kind' | 'name'>, m: Messages): string {
  return printable(row.name ?? '').trim() || promptLabel(row.label) || m.checkpointKind[row.kind]
}

/** What changed since a checkpoint, as its row shows it; `…` while it is being counted. */
export function sinceText(since: CheckpointRow['since'], m: Messages): string {
  return since === undefined ? '…' : since.files === 0 ? m.noChangesSince : `${m.filesCount(since.files)} +${since.added} −${since.removed}`
}

export function CheckpointsTab(ui: ElementTable, model: CheckpointsModel, actions: CheckpointsActions) {
  const { Box, Text } = ui
  const { m } = model
  if (model.repoError) return Empty(ui, 'checkpoints-error', [model.repoError, m.checkpointsNeedGit])
  const shown = model.checkpoints.slice(0, model.limit)
  const hidden = model.checkpoints.length - shown.length
  const clocks = shown.map(row => clockOf(row.at, model.now, model.locale))
  const counts = shown.map(row => sinceText(row.since, m))
  // Every row shares one time width and one counts width, so the columns line up;
  // the label takes what is left and is cut to it, never wrapped.
  const clockWidth = Math.max(0, ...clocks.map(displayWidth))
  const countsWidth = Math.max(0, ...counts.map(displayWidth))
  const rightWidth = countsWidth + (RIGHT_GAP + RESTORE_SLOT) * BUTTONS
  const labelRoom = Math.max(6, model.bodyColumns - CARD_CHROME - 2 - clockWidth - 1 - rightWidth - 1)

  return (
    <Box key="checkpoints" flexDirection="column">
      {Section(ui, 'checkpoints-title', m.checkpointsTitle, m.checkpointsDetail(model.checkpoints.length, model.isEveryPrompt))}
      {model.checkpoints.length === 0 && Empty(ui, 'checkpoints-empty', [m.checkpointsEmpty, m.checkpointsEmptyHint(model.isEveryPrompt)])}
      {shown.length > 0 &&
        Card(
          ui,
          'checkpoints-card',
          false,
          <Box flexDirection="column">
            {shown.map((row, index) => {
              const label = truncate(checkpointLabel(row, m), labelRoom)
              const since = row.since

              return (
                <Box key={`checkpoint-${row.ref}`} justifyContent="space-between">
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      {Toned(ui, `checkpoint-mark-${row.ref}`, `${KIND_MARK[row.kind]} `, index === 0 ? 'accent' : undefined, { isDim: index !== 0 })}
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
                        {ChangeCounts(ui, `checkpoint-counts-${row.ref}`, since.added, since.removed)}
                      </Text>
                    )}
                    {IconButton(ui, `compare-${row.ref}`, 'Δ', theme.accent, () => actions.compare(row))}
                    <Box width={RESTORE_SLOT}>
                      {/* The newest checkpoint's turn is still going: Δ shows it. */}
                      {index > 0 && shown[index - 1] ? (
                        IconButton(ui, `turn-${row.ref}`, '±', theme.accent, () => actions.compareTurn(row, shown[index - 1] as CheckpointRow))
                      ) : (
                        <Text> </Text>
                      )}
                    </Box>
                    {IconButton(ui, `name-${row.ref}`, '✎', theme.accent, () => actions.name(row))}
                    {/* A pinned checkpoint's star sits on yellow; an unpinned one on the neutral fill. */}
                    {IconButton(ui, `pin-${row.ref}`, row.isPinned ? '★' : '☆', theme.warn, () => actions.togglePin(row), row.isPinned !== true)}
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
