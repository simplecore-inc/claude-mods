import type { ElementTable } from 'claude-code'

import type { MemoryFile, MemoryScope } from '../../types'
import type { Messages } from '../i18n'
import type { MemoryHit } from '../memory'
import { displayWidth, printable, truncate } from '../shared/layout'
import { Card, CARD_CHROME, Empty, IconButton, InputFrame, LinkButton, OutlineList, RankList, Section, SelectField, SubLine, theme } from '../shared/kit'

export type MemoryModel = {
  files: MemoryFile[] | null
  scope: 'all' | MemoryScope
  query: string
  /** The lines the search found; empty with no query. */
  hits: MemoryHit[]
  open: string | null
  /** Whether the surface draws a text field (every surface but mobile). */
  hasField: boolean
  m: Messages
  bodyColumns: number
}

export type MemoryActions = {
  chooseScope: () => void
  search: (query: string) => void
  toggle: (file: MemoryFile) => void
  /** Opens the reader on the file, at the page that holds `line` when one is given. */
  read: (file: MemoryFile, line?: number) => void
  /** Puts `@path` in the prompt, so Claude reads the file. */
  insert: (file: MemoryFile) => void
}

/** Outline entries shown under an open file. */
const OUTLINE_SHOWN = 40

export function MemoryTab(ui: ElementTable, model: MemoryModel, actions: MemoryActions) {
  const { Box, Text } = ui
  const { m } = model
  if (!model.files) return Empty(ui, 'memory-loading', [m.loading])
  const Input = model.hasField && 'Input' in ui ? ui.Input : undefined
  const inner = Math.max(20, model.bodyColumns - CARD_CHROME)
  const shown = model.files.filter(file => model.scope === 'all' || file.scope === model.scope)
  const byPath = new Map(model.files.map(file => [file.path, file]))
  const row = (file: MemoryFile) => {
    const isOpen = model.open === file.path
    const facts = `${m.memoryKind[file.kind]} · ${m.memoryLines(file.lines)}`
    // The path is cut to what the facts and the insert button leave, so the row stays one line.
    const label = truncate(printable(file.display), Math.max(12, inner - displayWidth(facts) - 8))

    return (
      <Box key={`memory-${file.path}`} flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={1} flexShrink={1}>
            {/* ▸ unfolds the outline; the name opens the whole file to read. */}
            {IconButton(ui, `memory-outline-toggle-${file.path}`, isOpen ? '▾' : '▸', theme.accent, () => actions.toggle(file))}
            {LinkButton(ui, `memory-open-${file.path}`, label, () => actions.read(file))}
            <Text dimColor wrap="truncate-end">
              {facts}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            {IconButton(ui, `memory-insert-${file.path}`, '↵', theme.accent, () => actions.insert(file))}
          </Box>
        </Box>
        {file.note && SubLine(ui, `memory-note-${file.path}`, file.kind === 'imported' ? m.memoryImportedBy(file.note) : file.note)}
        {isOpen &&
          (file.outline.length > 0
            ? OutlineList(ui, `memory-outline-${file.path}`, file.outline.slice(0, OUTLINE_SHOWN), inner)
            : SubLine(ui, `memory-outline-${file.path}`, m.memoryEmptyOutline))}
      </Box>
    )
  }
  const group = (scope: MemoryScope) => {
    const files = shown.filter(file => file.scope === scope)
    if (files.length === 0) return null
    const title = scope === 'global' ? m.memoryGlobal : m.memoryProject
    const detail = scope === 'global' ? m.memoryGlobalDetail : m.memoryProjectDetail

    return (
      <Box key={`memory-group-${scope}`} flexDirection="column">
        {Section(ui, `memory-${scope}-title`, title, detail)}
        {Card(ui, `memory-${scope}-card`, false, <Box flexDirection="column">{files.map(row)}</Box>)}
      </Box>
    )
  }

  return (
    <Box key="memory" flexDirection="column" gap={1}>
      <Box key="memory-head" flexDirection="column">
        {Section(ui, 'memory-title', m.memoryTitle, m.memoryDetail(model.files.length))}
        <Box key="memory-scope" gap={1} marginTop={1}>
          <Text dimColor>{m.memoryScopeLabel}</Text>
          {SelectField(ui, 'memory-scope-field', m.memoryScope[model.scope], actions.chooseScope)}
        </Box>
        {Input && (
          <Box key="memory-search" marginTop={1}>
            {InputFrame(
              ui,
              'memory-search-frame',
              true,
              <Input key="memory-search-input" value={model.query} placeholder={m.memorySearch} onInput={value => actions.search(value)} onSubmit={value => actions.search(value)} />,
              '⌕',
            )}
          </Box>
        )}
      </Box>
      {model.query.trim() !== '' ? (
        model.hits.length === 0 ? (
          Empty(ui, 'memory-no-hits', [m.memoryNoHits(model.query.trim())])
        ) : (
          <Box key="memory-hits" flexDirection="column">
            {Section(ui, 'memory-hits-title', m.memoryHits(model.hits.length, model.query.trim()))}
            {Card(
              ui,
              'memory-hits-card',
              false,
              RankList(
                ui,
                'memory-hit-rows',
                model.hits.map(hit => {
                  const file = byPath.get(hit.path)

                  // A line found opens the file at the page that holds it.
                  return { name: hit.text, detail: `${file?.display ?? hit.path}:${hit.line}`, value: '', ...(file ? { onPress: () => actions.read(file, hit.line) } : {}) }
                }),
                inner,
              ),
            )}
          </Box>
        )
      ) : shown.length === 0 ? (
        Empty(ui, 'memory-none', [m.memoryNone])
      ) : (
        <Box key="memory-groups" flexDirection="column" gap={1}>
          {group('global')}
          {group('project')}
        </Box>
      )}
    </Box>
  )
}
