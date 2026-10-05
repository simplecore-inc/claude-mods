import type { ElementTable } from 'claude-code'

import type { RunStatus, Tool, ToolKind } from '../../types'
import type { Messages } from '../i18n'
import type { StatusTile, TileAction, Tone } from '../shared/kit'
import { Card, CARD_CHROME, Empty, IconButton, LinkButton, Section, StatusTiles, SubLine, theme, Tiles, Toned } from '../shared/kit'
import { displayWidth, truncate } from '../shared/layout'
import { askedParams } from '../tools'

/** How far a shell run says it has got. */
export type Activity = { progress?: number }

export type ToolsModel = {
  tools: Tool[]
  runs: Record<string, RunStatus>
  activity: Record<string, Activity>
  error: string | null
  path: string
  now: number
  m: Messages
  bodyColumns: number
}

export type ToolsActions = {
  run: (tool: Tool) => void
  stop: (tool: Tool) => void
  log: (tool: Tool) => void
  edit: (tool: Tool) => void
  remove: (tool: Tool) => void
}

const KINDS: ToolKind[] = ['shell', 'claude', 'prompt']

/** A run's mark and its tone: running, done, failed, stopped or waiting. */
export function runMark(run: RunStatus | undefined): { mark: string; tone?: Tone } {
  if (!run) return { mark: ' ' }
  if (run.state === 'running') return { mark: '●', tone: 'ok' }
  if (run.state === 'queued') return { mark: '◐', tone: 'warn' }
  if (run.state === 'failed') return { mark: '✖', tone: 'danger' }
  if (run.state === 'stopped') return { mark: '■', tone: 'warn' }

  return { mark: '✔', tone: 'ok' }
}

/**
 * A run as both views say it: its state, how it ended, and, while it runs,
 * how long it has run; once ended, how long it took and how long ago.
 */
export function runText(run: RunStatus, now: number, m: Messages): string {
  const ended = run.state === 'failed' && typeof run.code === 'number' ? ` (${m.exitCode(run.code)})` : ''
  if (run.endedAt === undefined) return `${m.state[run.state]} · ${elapsed(now - run.startedAt)}`

  return `${m.state[run.state]}${ended} · ${m.took(elapsed(run.endedAt - run.startedAt))} · ${m.ago(elapsed(now - run.endedAt))}`
}

/** The tools list: each kind its own card, a row a tool with its state and its buttons. */
export function ToolsTab(ui: ElementTable, model: ToolsModel, actions: ToolsActions) {
  const { Box, Text } = ui
  const { m } = model
  const inner = Math.max(20, model.bodyColumns - CARD_CHROME)
  const row = (tool: Tool) => {
    const run = model.runs[tool.id]
    const mark = runMark(run)
    const isRunning = run?.state === 'running'
    const status = run ? runText(run, model.now, m) : askedParams(tool).length > 0 ? m.asked : ''
    const room = Math.max(10, inner - displayWidth(status) - 16)

    return (
      <Box key={`tool-${tool.id}`} flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={1} flexShrink={1}>
            {Toned(ui, `tool-mark-${tool.id}`, mark.mark, mark.tone)}
            {LinkButton(ui, `tool-run-name-${tool.id}`, truncate(tool.name, room), () => actions.run(tool))}
            <Text dimColor wrap="truncate-end">
              {status}
            </Text>
          </Box>
          <Box gap={2} flexShrink={0} marginLeft={1}>
            {tool.kind === 'shell' && isRunning
              ? IconButton(ui, `tool-stop-${tool.id}`, '■', theme.danger, () => actions.stop(tool))
              : IconButton(ui, `tool-run-${tool.id}`, '▶', theme.ok, () => actions.run(tool))}
            {tool.kind === 'shell' && run !== undefined && IconButton(ui, `tool-log-${tool.id}`, '≡', theme.accent, () => actions.log(tool))}
            {IconButton(ui, `tool-edit-${tool.id}`, '✎', theme.accent, () => actions.edit(tool))}
            {IconButton(ui, `tool-remove-${tool.id}`, '✕', theme.danger, () => actions.remove(tool))}
          </Box>
        </Box>
        {SubLine(ui, `tool-command-${tool.id}`, tool.run)}
      </Box>
    )
  }

  return (
    <Box key="tools" flexDirection="column" gap={1}>
      {Section(ui, 'tools-title', m.toolsTitle, m.toolsDetail(model.path))}
      {model.error && Toned(ui, 'tools-error', model.error, 'danger', { wrap: 'wrap' })}
      {model.tools.length === 0 && Empty(ui, 'tools-empty', [m.toolsEmpty, m.toolsEmptyHint])}
      {KINDS.map(kind => {
        const tools = model.tools.filter(tool => tool.kind === kind)
        if (tools.length === 0) return null

        return (
          <Box key={`tools-${kind}`} flexDirection="column">
            {Section(ui, `tools-${kind}-title`, m.kindTitle[kind])}
            {Card(ui, `tools-${kind}-card`, false, <Box flexDirection="column">{tools.map(row)}</Box>)}
          </Box>
        )
      })}
    </Box>
  )
}

/** A quarter-step circle for a share done, empty to full. */
const PROGRESS_ICONS = ['○', '◔', '◑', '◕', '●']
/** A circle turning a quarter each beat, for a run that does not say how far it has got. */
const SPINNER_ICONS = ['◴', '◷', '◶', '◵']
/** The beat the quick view redraws on while something runs, in milliseconds. */
export const QUICK_BEAT_MS = 500

/** The icon of a share done: one of five circles filling by quarters. */
export function progressIcon(percent: number): string {
  return PROGRESS_ICONS[Math.min(4, Math.max(0, Math.round(percent / 25)))] ?? '○'
}

/** Seconds as `12s`, `3m 20s` or `1h 5m`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`

  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

const IDLE_ICON: Record<ToolKind, string> = { shell: '▶', claude: '›', prompt: '¶' }

/**
 * A tool as its quick tile shows it: the icon and its tone, the status line,
 * the ground, and whether the ground is lit on this beat.
 */
export function quickTile(tool: Tool, run: RunStatus | undefined, activity: Activity | undefined, now: number, m: Messages): Omit<StatusTile, 'key' | 'onPress' | 'actions'> {
  const beat = Math.floor(now / QUICK_BEAT_MS)
  const isOn = beat % 2 === 0
  if (run?.state === 'running') {
    const progress = activity?.progress

    return {
      icon: progress === undefined ? (SPINNER_ICONS[beat % 4] ?? '◴') : progressIcon(progress),
      ...(isOn ? { iconTone: 'ok' as const } : {}),
      title: tool.name,
      status: [runText(run, now, m), progress === undefined ? '' : `${Math.round(progress)}%`].filter(Boolean).join(' · '),
      ground: 'ok',
    }
  }
  if (run?.state === 'queued') return { icon: isOn ? '◌' : '○', iconTone: 'warn', title: tool.name, status: runText(run, now, m), ground: 'warn', isLit: isOn }
  if (run) {
    const tone: Tone = run.state === 'failed' ? 'danger' : run.state === 'stopped' ? 'warn' : 'ok'

    return { icon: runMark(run).mark, iconTone: tone, title: tool.name, status: runText(run, now, m), ...(run.state === 'failed' ? { ground: 'danger' as const } : {}) }
  }
  const notes = [m.pressToRun, m.kindIdle[tool.kind], tool.confirm ? m.asksFirst : '', askedParams(tool).length > 0 ? m.asked : ''].filter(Boolean)

  return { icon: IDLE_ICON[tool.kind], iconTone: 'accent', title: tool.name, status: notes.join(' · ') }
}

/** The quick view's first line: what runs, waits and failed, or how the tiles work when nothing does. */
export function quickSummary(runs: Record<string, RunStatus>, m: Messages): { text: string; tone?: Tone } {
  const all = Object.values(runs)
  const count = (state: RunStatus['state']) => all.filter(run => run.state === state).length
  const parts: { text: string; tone: Tone }[] = [
    ...(count('running') > 0 ? [{ text: m.summaryRunning(count('running')), tone: 'ok' as const }] : []),
    ...(count('queued') > 0 ? [{ text: m.summaryWaiting(count('queued')), tone: 'warn' as const }] : []),
    ...(count('failed') > 0 ? [{ text: m.summaryFailed(count('failed')), tone: 'danger' as const }] : []),
  ]
  if (parts.length === 0) return { text: m.quickHint }

  return { text: parts.map(part => part.text).join(' · '), tone: parts[0]?.tone }
}

/**
 * The quick view: a line saying what runs and failed, then every tool a tile,
 * two to a row, saying how it stands. A tile not yet run, a Claude command and
 * a prompt run when pressed; a shell tool that has run opens its log, and ▶ on
 * it runs it again, ■ stops it while it runs. Then Settings; the header closes the pane.
 */
export function QuickView(
  ui: ElementTable,
  model: ToolsModel,
  actions: { run: (tool: Tool) => void; stop: (tool: Tool) => void; log: (tool: Tool) => void; settings: () => void },
) {
  const { Box } = ui
  const { m } = model
  const summary = quickSummary(model.runs, m)
  const tiles: StatusTile[] = model.tools.map(tool => {
    const run = model.runs[tool.id]
    const isRunning = run?.state === 'running'
    const hasLog = tool.kind === 'shell' && run !== undefined
    const buttons: TileAction[] = [
      ...(hasLog && !isRunning ? [{ key: `quick-run-${tool.id}`, glyph: '▶', tone: theme.ok, onPress: () => actions.run(tool) }] : []),
      ...(isRunning ? [{ key: `quick-stop-${tool.id}`, glyph: '■', tone: theme.danger, onPress: () => actions.stop(tool) }] : []),
      ...(hasLog ? [{ key: `quick-log-${tool.id}`, glyph: '≡', tone: theme.accent, onPress: () => actions.log(tool) }] : []),
    ]

    return {
      key: `quick-${tool.id}`,
      ...quickTile(tool, run, model.activity[tool.id], model.now, m),
      actions: buttons,
      onPress: () => (hasLog ? actions.log(tool) : actions.run(tool)),
    }
  })

  return (
    <Box key="quick" flexDirection="column">
      {model.error && Toned(ui, 'quick-error', model.error, 'danger', { wrap: 'wrap' })}
      {model.tools.length === 0 && Empty(ui, 'quick-empty', [m.quickEmpty])}
      {tiles.length > 0 && Toned(ui, 'quick-summary', summary.text, summary.tone, { isDim: summary.tone === undefined, wrap: 'wrap' })}
      {/* The tools in a box of their own, apart from the pane's Settings and Close. */}
      {tiles.length > 0 && Card(ui, 'quick-card', false, StatusTiles(ui, model.bodyColumns - CARD_CHROME, tiles))}
      {Tiles(ui, model.bodyColumns, [{ key: 'quick-settings', label: m.settingsButton, onPress: actions.settings }])}
    </Box>
  )
}
