import type { ElementTable } from 'claude-code'

import type { CheckpointRow, DiffFile, DiffView } from '../../types'
import type { Locale, Messages } from '../i18n'
import { clockOf, sinceText } from './checkpoints'
import { Card, Empty, IconButton, Section, theme } from '../shared/kit'
import { displayWidth, padCells, truncate } from '../shared/layout'

export type DiffModel = {
  diff: DiffView | null
  repoError: string | null
  now: number
  locale: Locale
  m: Messages
  bodyColumns: number
}

export type DiffActions = {
  select: (path: string) => void
  closeFile: () => void
  /** Opens the dialog that picks the checkpoint the changes are compared with. */
  chooseBase: () => void
}

const STATUS_MARK: Record<DiffFile['status'], { letter: string; color: string }> = {
  added: { letter: 'A', color: theme.ok },
  modified: { letter: 'M', color: theme.warn },
  deleted: { letter: 'D', color: theme.danger },
  renamed: { letter: 'R', color: theme.accent },
}

/**
 * A file's name cut to `nameWidth`, and its folder joined by ` › ` and cut to
 * what is left of `room` after the name's column: the shape a terminal does
 * not mistake for a path.
 */
export function splitPath(path: string, nameWidth: number, room: number): { name: string; folder: string } {
  const parts = path.split('/')
  const name = truncate(parts.pop() ?? path, nameWidth)
  const folder = parts.join(' › ')
  // The glyph, its space and the gap before the folder.
  const left = room - nameWidth - 3

  return { name, folder: folder === '' || left < 4 ? '' : truncate(folder, left) }
}

/** The widest a file name's column grows; longer names are cut. */
const NAME_WIDTH = 28

/** A base as the header and the base dialog name it: `time  label`. */
export function baseLabel(base: Pick<DiffView['base'], 'at' | 'label'>, now: number, locale: Locale): string {
  return `${clockOf(base.at, now, locale)}  ${truncate(base.label, 40)}`
}

/** A checkpoint offered as a base, with what changed since it when that has been counted. */
export type BaseCandidate = DiffView['base'] & { since?: CheckpointRow['since'] }

/**
 * The base dialog's choices: each checkpoint as `time  label` with what changed
 * since it beside, so two session starts tell apart; the base in use is marked
 * and comes first when it is not among them.
 */
export function baseChoices(candidates: BaseCandidate[], current: DiffView['base'] | undefined, now: number, locale: Locale, m: Messages) {
  const list: (BaseCandidate & { isCounted?: false })[] =
    !current || candidates.some(one => one.commit === current.commit) ? candidates : [{ ...current, isCounted: false }, ...candidates]

  return list.map(base => ({
    key: `base-${base.commit}`,
    label: baseLabel(base, now, locale),
    detail: base.isCounted === false ? undefined : sinceText(base.since, m),
    isCurrent: base.commit === current?.commit,
    base: { commit: base.commit, label: base.label, at: base.at, isSessionStart: base.isSessionStart },
  }))
}

/** Cells of the per-file change bar. */
const CHANGE_BAR = 10

/** The change bar's added and removed cells, in proportion to the largest file's changes. */
export function changeCells(file: DiffFile, largest: number): { added: number; removed: number } {
  if (file.added === null || file.removed === null || largest === 0) return { added: 0, removed: 0 }
  const total = file.added + file.removed
  const cells = Math.max(1, Math.round((total / largest) * CHANGE_BAR))
  const added = Math.round((file.added / Math.max(1, total)) * cells)

  return { added, removed: cells - added }
}

export function DiffTab(ui: ElementTable, model: DiffModel, actions: DiffActions) {
  const { Box, Text, Button } = ui
  const { m, diff } = model
  if (model.repoError) return Empty(ui, 'diff-error', [model.repoError, m.checkpointsNeedGit])
  if (!diff) return Empty(ui, 'diff-loading', [m.loading])
  const largest = Math.max(0, ...diff.files.map(file => (file.added ?? 0) + (file.removed ?? 0)))
  const added = diff.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = diff.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  // The counts take one width for every file, so every bar starts in the same column.
  const addedWidth = Math.max(...diff.files.map(file => `+${file.added ?? 0}`.length))
  const removedWidth = Math.max(...diff.files.map(file => `−${file.removed ?? 0}`.length))
  const countsWidth = 2 + addedWidth + 1 + removedWidth
  const pathRoom = Math.max(16, model.bodyColumns - 4 - 4 - CHANGE_BAR - countsWidth)
  // One column for every name, so the folders start together.
  const nameWidth = Math.min(NAME_WIDTH, Math.max(...diff.files.map(file => displayWidth(file.path.split('/').pop() ?? file.path))))

  return (
    <Box key="diff" flexDirection="column">
      {/* What is compared stays in view; pressing it opens the dialog that picks another checkpoint. */}
      <Box key="diff-head" gap={1}>
        {Section(ui, 'diff-title', m.diffTitle)}
        <Text dimColor>{m.diffBaseLabel}</Text>
        <Button
          key="diff-base"
          label={`${baseLabel(diff.base, model.now, model.locale)} ▾`}
          plain
          hover={{ color: theme.accent, bold: true }}
          onPress={actions.chooseBase}
        />
      </Box>
      {diff.files.length === 0 && Empty(ui, 'diff-empty', [m.diffEmpty])}
      {diff.files.length > 0 && (
        <Text key="diff-totals">
          <Text dimColor>{`${m.filesCount(diff.files.length)}  `}</Text>
          <Text color={theme.ok}>{`+${added}`}</Text>
          <Text> </Text>
          <Text color={theme.danger}>{`−${removed}`}</Text>
        </Text>
      )}
      {diff.files.length > 0 &&
        Card(
          ui,
          'diff-files',
          false,
          <Box flexDirection="column">
            {diff.files.map(file => {
              const mark = STATUS_MARK[file.status]
              const cells = changeCells(file, largest)
              const isSelected = diff.selected?.path === file.path
              const { name, folder } = splitPath(file.path, nameWidth, pathRoom)

              return (
                <Box key={`file-${file.path}`} justifyContent="space-between">
                  <Box gap={1} flexShrink={1}>
                    <Text color={mark.color} bold>
                      {mark.letter}
                    </Text>
                    {/* The file's name is the button. Its folder is drawn with `›`, not `/`:
                        a terminal turns a path into a link of its own and takes the click. */}
                    {/* The name at full strength, the folder dim: the two never read as one. */}
                    <Button
                      key={`file-open-${file.path}`}
                      label={`${isSelected ? '▾' : '▸'} ${padCells(name, nameWidth)}`}
                      plain
                      hover={{ color: theme.accent, bold: true }}
                      onPress={() => actions.select(file.path)}
                    />
                    {folder !== '' && (
                      <Text dimColor wrap="truncate-end">
                        {folder}
                      </Text>
                    )}
                  </Box>
                  <Text>
                    <Text color={theme.ok}>{'■'.repeat(cells.added)}</Text>
                    <Text color={theme.danger}>{'■'.repeat(cells.removed)}</Text>
                    <Text dimColor>{'·'.repeat(Math.max(0, CHANGE_BAR - cells.added - cells.removed))}</Text>
                    {file.added === null ? (
                      <Text dimColor>{`  ${m.binary}`.padEnd(countsWidth)}</Text>
                    ) : (
                      <Text>
                        <Text color={theme.ok}>{`  ${`+${file.added}`.padStart(addedWidth)}`}</Text>
                        <Text color={theme.danger}>{` ${`−${file.removed}`.padStart(removedWidth)}`}</Text>
                      </Text>
                    )}
                  </Text>
                </Box>
              )
            })}
          </Box>,
        )}
      {diff.selected &&
        Card(
          ui,
          'diff-file',
          true,
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold>{diff.selected.path}</Text>
              {IconButton(ui, 'diff-file-close', '✕', theme.accent, actions.closeFile)}
            </Box>
            {diff.selected.text.trim() === '' ? (
              <Text dimColor>{m.binary}</Text>
            ) : (
              <ui.Code source={diff.selected.text} format="diff" path={diff.selected.path} />
            )}
            {diff.selected.omitted > 0 && <Text dimColor>{m.linesOmitted(diff.selected.omitted)}</Text>}
          </Box>,
        )}
    </Box>
  )
}
