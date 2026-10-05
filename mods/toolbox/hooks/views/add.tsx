import type { ElementTable } from 'claude-code'

import type { DetectedTask } from '../../types'
import type { Messages } from '../i18n'
import { Card, CARD_CHROME, Empty, InputFrame, RankList, Section, TileButton } from '../shared/kit'

export type AddModel = {
  detected: DetectedTask[] | null
  commands: { name: string; description: string; source: string }[] | null
  query: string
  /** Whether Gradle's whole task list can be loaded here. */
  hasGradle: boolean
  hasField: boolean
  m: Messages
  bodyColumns: number
}

export type AddActions = {
  search: (query: string) => void
  addTask: (task: DetectedTask) => void
  addCommand: (name: string) => void
  addShell: () => void
  addPrompt: () => void
  loadGradle: () => void
}

/** Rows of a list shown before the filter is needed to find the rest. */
const ROWS_SHOWN = 30

/** Whether a row holds every word typed, in its name, command or description. */
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()

  return words.every(word => haystack.includes(word))
}

/** The Add tab: a filter, then the project's build tasks by ecosystem, Claude's commands, and a tool of one's own. */
export function AddTab(ui: ElementTable, model: AddModel, actions: AddActions) {
  const { Box } = ui
  const { m } = model
  const Input = model.hasField && 'Input' in ui ? ui.Input : undefined
  const inner = Math.max(20, model.bodyColumns - CARD_CHROME)
  const tasks = (model.detected ?? []).filter(task => matchesQuery(model.query, task.name, task.run, task.description, task.source))
  const sources = [...new Set(tasks.map(task => task.source))]
  const commands = (model.commands ?? []).filter(command => matchesQuery(model.query, command.name, command.description))

  return (
    <Box key="add" flexDirection="column" gap={1}>
      {Section(ui, 'add-title', m.addTitle)}
      {Input &&
        InputFrame(
          ui,
          'add-search-frame',
          true,
          <Input key="add-search" value={model.query} placeholder={m.addSearch} onInput={value => actions.search(value)} onSubmit={value => actions.search(value)} />,
          '⌕',
        )}
      <Box key="add-custom" gap={2}>
        {Section(ui, 'add-custom-title', m.addCustom)}
        {TileButton(ui, 'add-shell', m.addShell, actions.addShell)}
        {TileButton(ui, 'add-prompt', m.addPrompt, actions.addPrompt)}
      </Box>
      <Box key="add-detected" flexDirection="column">
        <Box gap={2}>
          {Section(ui, 'add-detected-title', m.addDetected)}
          {model.hasGradle && TileButton(ui, 'add-gradle-all', m.addGradleAll, actions.loadGradle)}
        </Box>
        {model.detected === null && Empty(ui, 'add-detected-loading', [m.loading])}
        {model.detected !== null && model.detected.length === 0 && Empty(ui, 'add-detected-none', [m.addDetectedNone])}
        {sources.map(source =>
          Card(
            ui,
            `add-source-${source}`,
            false,
            RankList(
              ui,
              `add-source-${source}-rows`,
              tasks
                .filter(task => task.source === source)
                .slice(0, ROWS_SHOWN)
                .map(task => ({ name: `${source} · ${task.name}`, detail: task.description ?? task.run, value: '+', onPress: () => actions.addTask(task) })),
              inner,
            ),
          ),
        )}
      </Box>
      <Box key="add-claude" flexDirection="column">
        {Section(ui, 'add-claude-title', m.addClaude)}
        {model.commands === null && Empty(ui, 'add-claude-loading', [m.loading])}
        {commands.length > 0 &&
          Card(
            ui,
            'add-claude-card',
            false,
            RankList(
              ui,
              'add-claude-rows',
              commands.slice(0, ROWS_SHOWN).map(command => ({ name: `/${command.name}`, detail: command.description, value: '+', onPress: () => actions.addCommand(command.name) })),
              inner,
            ),
          )}
      </Box>
    </Box>
  )
}
