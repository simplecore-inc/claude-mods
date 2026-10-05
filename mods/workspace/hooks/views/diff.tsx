import type { ElementTable } from 'claude-code'

import type { CheckpointRow, DiffFile, DiffPoint, DiffView } from '../../types'
import type { Locale, Messages } from '../i18n'
import { clockOf, sinceText } from './checkpoints'
import type { Tone } from '../shared/kit'
import { Card, ChangeBar, ChangeCounts, Empty, IconButton, LinkButton, Section, SelectField, theme, Toned } from '../shared/kit'
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
  /** Opens a file's diff in its dialog. */
  select: (path: string) => void
  /** Opens the dialog that picks the checkpoint the changes are compared with. */
  chooseBase: () => void
  /** Opens the dialog that picks what the changes are compared up to: the working tree or a later checkpoint. */
  chooseTarget: () => void
  /** Leaves another worktree's changes for this one's. */
  closeWorktree: () => void
}

const STATUS_MARK: Record<DiffFile['status'], { letter: string; tone: Tone }> = {
  added: { letter: 'A', tone: 'ok' },
  modified: { letter: 'M', tone: 'warn' },
  deleted: { letter: 'D', tone: 'danger' },
  renamed: { letter: 'R', tone: 'accent' },
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

/** What the changes are compared up to, as the header and the target dialog name it. */
export function targetLabel(target: DiffPoint | undefined, now: number, locale: Locale, m: Messages): string {
  return target ? baseLabel(target, now, locale) : m.workingTree
}

/**
 * The target dialog's choices: the working tree first, then every checkpoint
 * taken after the base, newest first; the target in use is marked. `target`
 * is null for the working tree.
 */
export function targetChoices(candidates: DiffPoint[], diff: Pick<DiffView, 'base' | 'target'>, now: number, locale: Locale, m: Messages) {
  const later = candidates.filter(one => one.at > diff.base.at && one.commit !== diff.base.commit).sort((a, b) => b.at - a.at)

  return [
    { key: 'target-now', label: m.workingTree, isCurrent: diff.target === undefined, target: null },
    ...later.map(point => ({
      key: `target-${point.commit}`,
      label: baseLabel(point, now, locale),
      isCurrent: diff.target?.commit === point.commit,
      target: point,
    })),
  ]
}

/** The prompt that asks Claude for a commit message: the range compared and each file with its counts. */
export function commitPrompt(diff: DiffView, now: number, locale: Locale, m: Messages): string {
  const range = diff.worktree
    ? m.draftCommitRange(diff.base.label, `${diff.worktree.branch} (${diff.worktree.path})`)
    : m.draftCommitRange(baseLabel(diff.base, now, locale), targetLabel(diff.target, now, locale, m))
  const files = diff.files
    .map(file => {
      const counts = file.added === null ? m.binary : `+${file.added} −${file.removed ?? 0}`
      const path = file.from ? `${file.from} → ${file.path}` : file.path

      return `- ${STATUS_MARK[file.status].letter} ${path} (${counts})`
    })
    .join('\n')

  return m.draftCommitPrompt(range, files)
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
  const { Box, Text } = ui
  const { m, diff } = model
  if (model.repoError) return Empty(ui, 'diff-error', [model.repoError, m.checkpointsNeedGit])
  if (!diff) return Empty(ui, 'diff-loading', [m.loading])
  const largest = Math.max(0, ...diff.files.map(file => (file.added ?? 0) + (file.removed ?? 0)))
  const added = diff.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = diff.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  // The counts take one width for every file, so every bar starts in the same column; a binary
  // file's word takes that width too, the added figures padded to it, so no row runs over and wraps.
  const removedWidth = Math.max(...diff.files.map(file => `−${file.removed ?? 0}`.length))
  const figures = Math.max(...diff.files.map(file => `+${file.added ?? 0}`.length))
  const binaryWidth = diff.files.some(file => file.added === null) ? 2 + displayWidth(m.binary) : 0
  const addedWidth = Math.max(figures, binaryWidth - 3 - removedWidth)
  const countsWidth = 2 + addedWidth + 1 + removedWidth
  const pathRoom = Math.max(16, model.bodyColumns - 4 - 4 - CHANGE_BAR - countsWidth)
  // One column for every name, so the folders start together.
  const nameWidth = Math.min(NAME_WIDTH, Math.max(...diff.files.map(file => displayWidth(file.path.split('/').pop() ?? file.path))))

  return (
    <Box key="diff" flexDirection="column">
      {/* What is compared stays in view; pressing it opens the dialog that picks another checkpoint. */}
      {diff.worktree ? (
        // Another worktree's changes: counted from where its branch parted from the main one.
        <Box key="diff-head" gap={1} flexWrap="wrap">
          {Section(ui, 'diff-title', m.worktreeDiffTitle(diff.worktree.branch), m.worktreeDiffSince(diff.base.label))}
          {IconButton(ui, 'diff-worktree-close', '✕', theme.accent, actions.closeWorktree)}
        </Box>
      ) : (
        <Box key="diff-head" gap={1} flexWrap="wrap">
          {Section(ui, 'diff-title', m.diffTitle)}
          <Text dimColor>{m.diffBaseLabel}</Text>
          {SelectField(ui, 'diff-base', baseLabel(diff.base, model.now, model.locale), actions.chooseBase)}
          <Text dimColor>{m.diffTargetLabel}</Text>
          {SelectField(ui, 'diff-target', targetLabel(diff.target, model.now, model.locale, m), actions.chooseTarget)}
        </Box>
      )}
      {diff.files.length === 0 && Empty(ui, 'diff-empty', [m.diffEmpty])}
      {diff.files.length > 0 && (
        <Text key="diff-totals">
          <Text dimColor>{`${m.filesCount(diff.files.length)}  `}</Text>
          {ChangeCounts(ui, 'diff-totals-counts', added, removed)}
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
              const { name, folder } = splitPath(file.path, nameWidth, pathRoom)

              return (
                <Box key={`file-${file.path}`} justifyContent="space-between">
                  <Box gap={1} flexShrink={1}>
                    {Toned(ui, `file-mark-${file.path}`, mark.letter, mark.tone, { isBold: true })}
                    {/* The file's name is the button. Its folder is drawn with `›`, not `/`:
                        a terminal turns a path into a link of its own and takes the click. */}
                    {/* The name at full strength, the folder dim: the two never read as one. */}
                    {LinkButton(ui, `file-open-${file.path}`, `▸ ${padCells(name, nameWidth)}`, () => actions.select(file.path))}
                    {folder !== '' && (
                      <Text dimColor wrap="truncate-end">
                        {folder}
                      </Text>
                    )}
                  </Box>
                  <Text>
                    {ChangeBar(ui, `file-bar-${file.path}`, cells, CHANGE_BAR)}
                    {file.added === null ? (
                      <Text dimColor>{`  ${m.binary}`.padEnd(countsWidth)}</Text>
                    ) : (
                      <Text>
                        <Text>{'  '}</Text>
                        {ChangeCounts(ui, `file-counts-${file.path}`, file.added, file.removed ?? 0, { added: addedWidth, removed: removedWidth })}
                      </Text>
                    )}
                  </Text>
                </Box>
              )
            })}
          </Box>,
        )}
    </Box>
  )
}
