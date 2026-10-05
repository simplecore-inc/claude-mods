import type { ElementTable } from 'claude-code'

import type { StorageView } from '../../types'
import type { Locale, Messages } from '../i18n'
import { Card, CARD_CHROME, Empty, RankList, Section, SelectField, StatRow, TileButton } from '../shared/kit'
import { resetClock } from '../shared/time'
import { byteSize } from '../storage'

export type StorageModel = {
  storage: StorageView | null
  cleanupDays: number
  now: number
  locale: Locale
  m: Messages
  bodyColumns: number
}

export type StorageActions = {
  /** Opens the dialog that picks how long a session must be idle to be deleted. */
  chooseDays: () => void
  /** Opens the dialog that confirms the cleanup. */
  cleanUp: () => void
}

/** Project folders listed before the rest are left out. */
const PROJECTS_SHOWN = 8

export function StorageTab(ui: ElementTable, model: StorageModel, actions: StorageActions) {
  const { Box, Text } = ui
  const { m, storage } = model
  if (!storage) return Empty(ui, 'storage-loading', [m.storageScanning])
  const inner = Math.max(20, model.bodyColumns - CARD_CHROME)
  const day = (at: number) => resetClock(new Date(at).toISOString(), model.now, model.locale)

  return (
    <Box key="storage" flexDirection="column" gap={1}>
      <Box key="storage-head" flexDirection="column">
        {Section(ui, 'storage-title', m.storageTitle, m.storageDetail(storage.root))}
        {StatRow(ui, 'storage-stats', [
          { label: m.storageKinds, value: byteSize(storage.transcripts.bytes) },
          { label: m.storageSubagents, value: byteSize(storage.subagents.bytes) },
          { label: m.storageOther, value: byteSize(storage.other.bytes) },
        ])}
        <Text dimColor>{`${byteSize(storage.bytes)} · ${m.storageSessions(storage.sessions)}`}</Text>
      </Box>
      <Text key="storage-auto" dimColor wrap="wrap">
        {m.storageAuto(storage.autoDays, storage.isAutoDefault)}
      </Text>
      {/* What a cleanup deletes is picked here and confirmed in a dialog that names its size. */}
      <Box key="storage-cleanup" gap={1} flexWrap="wrap">
        <Text dimColor>{m.cleanupLabel}</Text>
        {SelectField(ui, 'cleanup-days-field', m.cleanupDays(model.cleanupDays), actions.chooseDays)}
        {TileButton(ui, 'cleanup', m.cleanupButton, actions.cleanUp)}
      </Box>
      {Section(ui, 'storage-projects-title', m.storageProjects)}
      {Card(
        ui,
        'storage-projects',
        false,
        RankList(
          ui,
          'storage-project-rows',
          storage.projects.slice(0, PROJECTS_SHOWN).map(project => ({
            name: project.name,
            detail: m.storageProjectDetail(m.storageSessions(project.sessions), day(project.lastActive)),
            value: byteSize(project.bytes),
          })),
          inner,
        ),
      )}
      {storage.folders.length > 0 && Section(ui, 'storage-folders-title', m.storageFolders)}
      {storage.folders.length > 0 &&
        Card(
          ui,
          'storage-folders',
          false,
          RankList(
            ui,
            'storage-folder-rows',
            storage.folders.map(folder => ({ name: folder.name, detail: '', value: byteSize(folder.bytes) })),
            inner,
          ),
        )}
    </Box>
  )
}
