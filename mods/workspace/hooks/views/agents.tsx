import type { ElementTable } from 'claude-code'

import type { AgentActivity, AgentRow, FinishedAgent, WorktreeRow } from '../../types'
import { printable } from '../shared/layout'
import { formatDuration } from '../shared/time'
import { isRemovable, shortPath } from '../git'
import type { Messages } from '../i18n'
import type { Tone } from '../shared/kit'
import { Badge, Card, Empty, IconButton, LinkButton, Section, SubLine, theme, Toned } from '../shared/kit'

export type AgentsModel = {
  agents: AgentRow[]
  /** What each agent did last, by agent id. */
  activity: Record<string, AgentActivity>
  /** Agents the engine no longer lists, newest first. */
  finished: FinishedAgent[]
  /** The finished agent whose answer is shown in full, or null. */
  expandedAgent: string | null
  worktrees: WorktreeRow[]
  repoError: string | null
  root: string
  home: string | undefined
  now: number
  m: Messages
}

export type AgentsActions = {
  stop: (agent: AgentRow) => void
  removeWorktree: (row: WorktreeRow) => void
  /** Shows or hides a finished agent's answer in full. */
  toggleAnswer: (agent: FinishedAgent) => void
  /** Opens the Diff tab on another worktree's changes. */
  openWorktree: (row: WorktreeRow) => void
}

const STATUS_STYLE: Record<AgentRow['status'], { mark: string; tone?: Tone; isDim?: boolean }> = {
  running: { mark: '●', tone: 'ok' },
  pending: { mark: '○', tone: 'accent' },
  waiting: { mark: '◐', tone: 'warn' },
  idle: { mark: '◐', isDim: true },
  completed: { mark: '✔', isDim: true },
  failed: { mark: '✖', tone: 'danger' },
  killed: { mark: '✖', isDim: true },
}

/** How long ago `since` was: `12m`, `2h 5m`. */
function elapsed(since: number, now: number): string {
  return formatDuration(now - since, '<1m')
}

/** Input fields that say what a tool call works on, in the order one is looked for. */
const SUBJECT_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']

/**
 * A tool call in a few words: the tool, and the first line of what it works
 * on (`Bash: npm test`, `Edit: src/app.ts`), or the tool alone.
 */
export function toolSummary(tool: string, input: Record<string, unknown>): string {
  const subject = SUBJECT_FIELDS.map(field => input[field]).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const line = subject?.trim().split('\n')[0]?.trim()

  return line ? `${tool}: ${line}` : tool
}

/** An agent's last activity as its card shows it: how long ago first, so cutting a long answer never hides it. */
export function activityText(activity: AgentActivity, now: number, m: Messages): string {
  return `${m.activityAgo(elapsed(activity.at, now))} · ${activity.isAnswer ? '✔ ' : ''}${activity.text}`
}

export function isStoppable(agent: AgentRow): boolean {
  return agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting'
}

export function AgentsTab(ui: ElementTable, model: AgentsModel, actions: AgentsActions) {
  const { Box, Text } = ui
  const { m } = model
  const active = model.agents.filter(isStoppable).length

  return (
    <Box key="agents" flexDirection="column" gap={1}>
      <Box key="agents-section" flexDirection="column">
        {Section(ui, 'agents-title', m.agentsTitle, m.agentsCount(model.agents.length, active))}
        {model.agents.length === 0 && Empty(ui, 'agents-empty', [m.agentsEmpty])}
        {model.agents.map(agent => {
          const style = STATUS_STYLE[agent.status]
          const lastActivity = model.activity[agent.id]

          return Card(
            ui,
            `agent-${agent.id}`,
            agent.status === 'running',
            <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                {Toned(ui, `agent-mark-${agent.id}`, `${style.mark} `, style.tone, { isDim: style.isDim === true })}
                <Text bold={agent.status === 'running'}>{printable(agent.label)}</Text>
                <Text dimColor>{`  ${printable(agent.type)} · ${m.agentStatus[agent.status]} · ${elapsed(agent.firstSeen, model.now)}`}</Text>
              </Text>
              {isStoppable(agent) && (
                <Box flexShrink={0} marginLeft={1}>
                  {/* Stopping asks in a dialog first. */}
                  {IconButton(ui, `stop-${agent.id}`, '■', theme.danger, () => actions.stop(agent))}
                </Box>
              )}
            </Box>
            {lastActivity && SubLine(ui, `activity-${agent.id}`, activityText(lastActivity, model.now, m))}
            </Box>,
          )
        })}
      </Box>
      {model.finished.length > 0 && (
        <Box key="finished-section" flexDirection="column">
          {Section(ui, 'finished-title', m.finishedTitle, m.finishedDetail(model.finished.length))}
          {Card(
            ui,
            'finished-card',
            false,
            <Box flexDirection="column">
              {model.finished.map(agent => {
                const style = STATUS_STYLE[agent.status]
                const isOpen = model.expandedAgent === agent.id
                const lastActivity = model.activity[agent.id]

                return (
                  <Box key={`finished-${agent.id}`} flexDirection="column">
                    <Box justifyContent="space-between">
                      <Text wrap="truncate-end">
                        {Toned(ui, `finished-mark-${agent.id}`, `${style.mark} `, style.tone, { isDim: style.isDim === true })}
                        <Text>{printable(agent.label)}</Text>
                        <Text dimColor>{`  ${printable(agent.type)} · ${m.activityAgo(elapsed(agent.endedAt, model.now))}`}</Text>
                      </Text>
                      <Box flexShrink={0} marginLeft={1}>
                        {IconButton(ui, `answer-${agent.id}`, isOpen ? '▾' : '▸', theme.accent, () => actions.toggleAnswer(agent))}
                      </Box>
                    </Box>
                    {!isOpen && lastActivity && SubLine(ui, `finished-activity-${agent.id}`, activityText(lastActivity, model.now, m))}
                    {isOpen && (
                      <Box key={`answer-text-${agent.id}`} paddingLeft={2} marginBottom={1}>
                        {Toned(ui, `answer-body-${agent.id}`, agent.answer ?? m.noAnswer, undefined, { isDim: agent.answer === undefined, wrap: 'wrap' })}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>,
          )}
        </Box>
      )}
      <Box key="worktrees-section" flexDirection="column">
        {Section(ui, 'worktrees-title', m.worktreesTitle, model.repoError ? undefined : m.worktreesCount(model.worktrees.length))}
        {model.repoError && Empty(ui, 'worktrees-error', [model.repoError])}
        {!model.repoError && model.worktrees.length === 0 && Empty(ui, 'worktrees-empty', [m.loading])}
        {model.worktrees.map(row => {
          const facts = [
            row.changed > 0 ? m.changedFiles(row.changed) : row.changed === 0 ? m.clean : undefined,
            row.ahead !== undefined && row.ahead > 0 ? `↑${row.ahead}` : undefined,
            row.behind !== undefined && row.behind > 0 ? `↓${row.behind}` : undefined,
          ].filter(Boolean)

          return Card(
            ui,
            `worktree-${row.path}`,
            false,
            <Box justifyContent="space-between">
              <Box flexShrink={1}>
                <Text dimColor>{row.isMain ? '◆ ' : '◇ '}</Text>
                {/* Another worktree's name opens its changes; this one's are the Diff tab's own. */}
                {!row.isMain && row.branch
                  ? LinkButton(ui, `worktree-open-${row.path}`, row.branch, () => actions.openWorktree(row))
                  : <Text bold>{printable(row.branch ?? m.detached)}</Text>}
              <Text wrap="truncate-end">
                <Text dimColor>{`  ${printable(shortPath(row.path, model.root, model.home))}`}</Text>
                {facts.length > 0 && <Text dimColor>{`  ${facts.join(' · ')}`}</Text>}
                {row.isMain && <Text> </Text>}
                {row.isMain && Badge(ui, 'worktree-main', m.mainWorktree, 'gray')}
                {!row.isMain && row.ahead === 0 && row.changed === 0 && <Text> </Text>}
                {!row.isMain && row.ahead === 0 && row.changed === 0 && Badge(ui, `merged-${row.path}`, m.merged, theme.ok)}
              </Text>
              </Box>
              {isRemovable(row) && (
                <Box flexShrink={0} marginLeft={1}>
                  {/* Removing asks in a dialog first. */}
                  {IconButton(ui, `remove-worktree-${row.path}`, '✕', theme.danger, () => actions.removeWorktree(row))}
                </Box>
              )}
            </Box>,
          )
        })}
      </Box>
    </Box>
  )
}
