import type { ElementTable } from 'claude-code'

import type { AgentRow, WorktreeRow } from '../../types'
import { formatDuration } from '../shared/time'
import { isRemovable, shortPath } from '../git'
import type { Messages } from '../i18n'
import { Badge, Card, ConfirmButton, Empty, Section, theme } from '../shared/kit'

export type AgentsModel = {
  agents: AgentRow[]
  worktrees: WorktreeRow[]
  repoError: string | null
  root: string
  home: string | undefined
  pendingConfirm: string | null
  now: number
  m: Messages
}

export type AgentsActions = {
  arm: (key: string) => void
  stop: (agent: AgentRow) => void
  removeWorktree: (row: WorktreeRow) => void
}

const STATUS_STYLE: Record<AgentRow['status'], { mark: string; color?: string; isDim?: boolean }> = {
  running: { mark: '●', color: theme.ok },
  pending: { mark: '○', color: theme.accent },
  waiting: { mark: '◐', color: theme.warn },
  idle: { mark: '◐', isDim: true },
  completed: { mark: '✔', isDim: true },
  failed: { mark: '✖', color: theme.danger },
  killed: { mark: '✖', isDim: true },
}

/** How long ago `since` was: `12m`, `2h 5m`. */
function elapsed(since: number, now: number): string {
  return formatDuration(now - since, '<1m')
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
          const stopKey = `stop:${agent.id}`

          return Card(
            ui,
            `agent-${agent.id}`,
            agent.status === 'running',
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={style.color} dimColor={style.isDim === true}>{`${style.mark} `}</Text>
                <Text bold={agent.status === 'running'}>{agent.label}</Text>
                <Text dimColor>{`  ${agent.type} · ${m.agentStatus[agent.status]} · ${elapsed(agent.firstSeen, model.now)}`}</Text>
              </Text>
              {isStoppable(agent) && (
                <Box flexShrink={0} marginLeft={1}>
                  {ConfirmButton(
                  ui,
                  `stop-${agent.id}`,
                  '■',
                  model.pendingConfirm === stopKey,
                  () => actions.arm(stopKey),
                  () => actions.stop(agent),
                  )}
                </Box>
              )}
            </Box>,
          )
        })}
      </Box>
      <Box key="worktrees-section" flexDirection="column">
        {Section(ui, 'worktrees-title', m.worktreesTitle, model.repoError ? undefined : m.worktreesCount(model.worktrees.length))}
        {model.repoError && Empty(ui, 'worktrees-error', [model.repoError])}
        {!model.repoError && model.worktrees.length === 0 && Empty(ui, 'worktrees-empty', [m.loading])}
        {model.worktrees.map(row => {
          const removeKey = `worktree:${row.path}`
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
              <Text wrap="truncate-end">
                <Text dimColor>{row.isMain ? '◆ ' : '◇ '}</Text>
                <Text bold>{row.branch ?? m.detached}</Text>
                <Text dimColor>{`  ${shortPath(row.path, model.root, model.home)}`}</Text>
                {facts.length > 0 && <Text dimColor>{`  ${facts.join(' · ')}`}</Text>}
                {row.isMain && <Text> </Text>}
                {row.isMain && Badge(ui, 'worktree-main', m.mainWorktree, 'gray')}
                {!row.isMain && row.ahead === 0 && row.changed === 0 && <Text> </Text>}
                {!row.isMain && row.ahead === 0 && row.changed === 0 && Badge(ui, `merged-${row.path}`, m.merged, theme.ok)}
              </Text>
              {isRemovable(row) && (
                <Box flexShrink={0} marginLeft={1}>
                  {ConfirmButton(
                  ui,
                  `remove-worktree-${row.path}`,
                  '✕',
                  model.pendingConfirm === removeKey,
                  () => actions.arm(removeKey),
                  () => actions.removeWorktree(row),
                  )}
                </Box>
              )}
            </Box>,
          )
        })}
      </Box>
    </Box>
  )
}
