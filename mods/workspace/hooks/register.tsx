import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, CheckpointRow, DiffView, Note, Tab, WorktreeRow } from '../types'
import { checkpointRef, clipDiff, promptLabel } from './git'
import { messagesFor, resolveLocale } from './i18n'
import type { Locale, Messages } from './i18n'
import { Dialog, Header, Rule, TabBar, Tiles } from './shared/kit'
import type { Tile } from './shared/kit'
import { releaseDateOf } from './shared/locale'
import { AgentsTab } from './views/agents'
import { CheckpointsTab, clockOf } from './views/checkpoints'
import { DiffTab } from './views/diff'
import { NotesTab } from './views/notes'
import {
  createCheckpoint,
  deleteRef,
  diffFiles,
  diffSummary,
  fileDiff,
  listWorktrees,
  removeWorktree,
  repoRoot,
  restoreCheckpoint,
  snapshotTree,
} from './workspace'
import type { Run } from './workspace'

const tab = atom({ plugin: 'sc-workspace', key: 'tab' } as const, 'agents')
const agents = atom({ plugin: 'sc-workspace', key: 'agents' } as const, [])
const worktrees = atom({ plugin: 'sc-workspace', key: 'worktrees' } as const, [])
const repoError = atom({ plugin: 'sc-workspace', key: 'repoError' } as const, null)
const checkpoints = atom({ plugin: 'sc-workspace', key: 'checkpoints' } as const, [])
const notes = atom({ plugin: 'sc-workspace', key: 'notes' } as const, [])
const diff = atom({ plugin: 'sc-workspace', key: 'diff' } as const, null)
const pendingConfirm = atom({ plugin: 'sc-workspace', key: 'pendingConfirm' } as const, null)
const busy = atom({ plugin: 'sc-workspace', key: 'busy' } as const, null)
const clock = atom({ plugin: 'sc-workspace', key: 'clock' } as const, 0)
const dialog = atom({ plugin: 'sc-workspace', key: 'dialog' } as const, null)
const focused = atom({ plugin: 'sc-workspace', key: 'focused' } as const, null)

const PANE = 'sc-workspace'
/** The product name heading the pane; a name, so it is not translated. */
const BRAND = 'SimpleCORE Mods'
const COMMAND = 'sc:workspace'
/** The `/config` row of the `notesInContext` setting. */
const NOTES_SETTING = 'sc-workspace.notesInContext'
const TABS: Tab[] = ['agents', 'checkpoints', 'notes', 'diff']
const AGENTS_POLL_MS = 3000
const WORKTREES_POLL_MS = 15_000
/** Checkpoints kept per project; older ones lose their refs. */
const CHECKPOINTS_KEPT = 50
/** Checkpoints whose changes since are counted and shown. */
const CHECKPOINTS_SHOWN = 12
/** Lines of one file's diff shown in the Diff tab. */
const DIFF_LINES = 400

let locale: Locale = 'en'
let m: Messages = messagesFor(locale)
let release: { version?: string; date?: string } = {}
/** The repository's top directory, or null outside a repository. */
let root: string | null = null
let home: string | undefined
let sessionId = ''
/** The checkpoint taken as the session started: the Diff tab's default base. */
let baseline: CheckpointRow | undefined
/** When this session first saw each agent, for its elapsed time. */
const firstSeen = new Map<string, number>()

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function debug($: EngineInterface, error: unknown): void {
  $.ui.log(`sc-workspace: ${message(error)}`, { to: 'debug' })
}

/** The command runner the git helpers take, over `$.process.run`. */
function runner($: EngineInterface): Run {
  return (argv, init) => $.process.run(argv, init)
}

const checkpointsKey = (project: string) => `checkpoints:${project}`
const notesKey = (project: string) => `notes:${project}`

function tabLabel(key: Tab): string {
  return { agents: m.tabAgents, checkpoints: m.tabCheckpoints, notes: m.tabNotes, diff: m.tabDiff }[key]
}

function projectName(): string {
  return root ? (root.split('/').pop() ?? root) : ''
}

async function readRelease($: EngineInterface): Promise<{ version?: string; date?: string }> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    if (typeof manifest.version !== 'string') return {}
    const changelogPath = `${$.plugin.root}/CHANGELOG.md`
    const changelog = (await $.fs.exists(changelogPath)) ? await $.fs.read(changelogPath) : ''

    return { version: manifest.version, date: releaseDateOf(changelog, manifest.version) }
  } catch (error) {
    debug($, error)

    return {}
  }
}

// ── agents and worktrees ──────────────────────────────────────────────────

async function refreshAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const rows: AgentRow[] = (await $.agent.list()).map(agent => {
    if (!firstSeen.has(agent.id)) firstSeen.set(agent.id, now)

    return {
      id: agent.id,
      stopId: agent.name ?? agent.teammateId ?? agent.id,
      label: agent.name ?? agent.description,
      type: agent.type,
      status: agent.status,
      firstSeen: firstSeen.get(agent.id) ?? now,
    }
  })
  const current = await read($, agents)
  if (JSON.stringify(current) !== JSON.stringify(rows)) await update($, agents, () => rows)
  // While an agent works its elapsed time moves: a clock tick redraws the rows that read it.
  if (rows.some(row => row.status === 'running' || row.status === 'pending' || row.status === 'waiting')) {
    await update($, clock, () => now)
  }
}

async function refreshWorktrees($: EngineInterface): Promise<void> {
  if (!root) return
  const rows = await listWorktrees(runner($), root)
  const current = await read($, worktrees)
  if (JSON.stringify(current) !== JSON.stringify(rows)) await update($, worktrees, () => rows)
}

async function stopAgent($: EngineInterface, agent: AgentRow): Promise<string> {
  await $.tool.call({ tool: 'TaskStop', task_id: agent.stopId })
  await refreshAgents($)

  return m.stopped(agent.label)
}

async function dropWorktree($: EngineInterface, row: WorktreeRow): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)
  await removeWorktree(runner($), root, row)
  await refreshWorktrees($)

  return m.worktreeRemoved(row.path)
}

// ── checkpoints ───────────────────────────────────────────────────────────

async function saveCheckpoints($: EngineInterface, list: CheckpointRow[]): Promise<void> {
  if (!root) return
  await $.store.set(
    checkpointsKey(root),
    list.map(({ since: _since, ...row }) => row),
  )
  await update($, checkpoints, () => list)
}

/**
 * Takes a checkpoint unless nothing changed since the latest one (or `force`).
 * @returns the checkpoint taken, or null when there was nothing new
 */
async function takeCheckpoint($: EngineInterface, kind: CheckpointRow['kind'], label: string, force = false): Promise<CheckpointRow | null> {
  if (!root) return null
  const run = runner($)
  const tree = await snapshotTree(run, root)
  const list = await read($, checkpoints)
  if (!force && list[0]?.tree === tree) return null
  const own = list.filter(row => row.ref.includes(`/${sessionId}/`))
  const seq = own.reduce((max, row) => Math.max(max, Number(row.ref.split('/').pop()) || 0), 0) + 1
  const ref = checkpointRef(sessionId, seq)
  const { commit } = await createCheckpoint(run, root, ref, label || m.checkpointKind[kind], tree)
  const row: CheckpointRow = { ref, commit, tree, at: await $.clock.now(), label, kind, since: { files: 0, added: 0, removed: 0 } }
  const kept = [row, ...list]
  for (const old of kept.slice(CHECKPOINTS_KEPT)) {
    await deleteRef(run, root, old.ref).catch((error: unknown) => debug($, error))
  }
  await saveCheckpoints($, kept.slice(0, CHECKPOINTS_KEPT))

  return row
}

/** Counts, for the checkpoints shown, what changed since each against the working tree now. */
async function refreshSince($: EngineInterface): Promise<void> {
  if (!root) return
  const run = runner($)
  const tree = await snapshotTree(run, root)
  const list = await read($, checkpoints)
  const counted = await Promise.all(
    list.map(async (row, index) =>
      index < CHECKPOINTS_SHOWN ? { ...row, since: await diffSummary(run, root ?? '', row.commit, tree) } : row,
    ),
  )
  await update($, checkpoints, () => counted)
}

async function restore($: EngineInterface, row: CheckpointRow): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)
  const before = await takeCheckpoint($, 'restore', m.checkpointKind.restore, true)
  if (!before) throw new Error(m.checkpointsNeedGit)
  await restoreCheckpoint(runner($), root, row.commit, row.tree, before.tree)
  await refreshSince($)
  await refreshDiff($)

  return m.restored(clockOf(row.at, await $.clock.now(), locale))
}

// ── diff ──────────────────────────────────────────────────────────────────

/** Compares the working tree with `base` (the current one when absent), keeping the open file open. */
async function refreshDiff($: EngineInterface, base?: DiffView['base']): Promise<void> {
  if (!root) return
  const current = await read($, diff)
  const start = baseline ?? (await read($, checkpoints)).find(row => row.kind === 'session')
  const target = base ?? current?.base ?? (start ? { commit: start.commit, label: m.checkpointKind.session, at: start.at, isSessionStart: true } : undefined)
  if (!target) return
  const run = runner($)
  const tree = await snapshotTree(run, root)
  const files = await diffFiles(run, root, target.commit, tree)
  const openPath = base ? undefined : current?.selected?.path
  let selected: DiffView['selected']
  if (openPath && files.some(file => file.path === openPath)) {
    selected = { path: openPath, ...clipDiff(await fileDiff(run, root, target.commit, tree, openPath), DIFF_LINES) }
  }
  await update($, diff, () => ({ base: target, files, selected, at: Date.now() }))
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  const current = await read($, diff)
  if (!root || !current) return
  if (current.selected?.path === path) {
    await update($, diff, view => (view ? { ...view, selected: undefined } : view))

    return
  }
  const run = runner($)
  const tree = await snapshotTree(run, root)
  const selected = { path, ...clipDiff(await fileDiff(run, root, current.base.commit, tree, path), DIFF_LINES) }
  await update($, diff, view => (view ? { ...view, selected } : view))
}

// ── notes ─────────────────────────────────────────────────────────────────

async function saveNotes($: EngineInterface, list: Note[]): Promise<void> {
  if (root) await $.store.set(notesKey(root), list)
  await update($, notes, () => list)
}

async function addNote($: EngineInterface, text: string): Promise<string | void> {
  const clean = text.trim()
  if (!clean) return
  const note: Note = { id: crypto.randomUUID(), text: clean, isDone: false, at: await $.clock.now() }
  await saveNotes($, [note, ...(await read($, notes))])

  return m.noteAdded(clean.length > 40 ? `${clean.slice(0, 39)}…` : clean)
}

async function openPane($: EngineInterface, next?: Tab): Promise<void> {
  if (next) await update($, tab, () => next)
  await $.ui.open({ id: PANE, title: m.paneTitle, rows: 30 })
  const active = await read($, tab)
  if (active === 'checkpoints') await refreshSince($)
  if (active === 'diff') await refreshDiff($)
  if (active === 'agents') await Promise.all([refreshAgents($), refreshWorktrees($)])
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const isCheckpointEveryPrompt = options.checkpointEveryPrompt !== false
  const isNotesInContext = options.notesInContext === true

  on('session.start', async ($, e, next) => {
    const { language } = await $.settings.read()
    locale = resolveLocale(language, [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')])
    m = messagesFor(locale)
    release = await readRelease($)
    home = await $.env.get('HOME')
    sessionId = await $.session.id()
    root = await repoRoot(runner($), await $.session.root())
    // A pane an earlier build opened and this one no longer draws (the old dialog pane) would
    // stay on screen empty, past the workspace's own Close: close every pane but the workspace.
    for (const pane of await $.ui.panes()) {
      if (pane.id !== PANE) await $.ui.close({ id: pane.id }).catch((error: unknown) => debug($, error))
    }
    await update($, repoError, () => (root ? null : m.checkpointsNeedGit))
    if (root) {
      const storedNotes = await $.store.get(notesKey(root))
      await update($, notes, () => (Array.isArray(storedNotes) ? (storedNotes as Note[]) : []))
      const storedCheckpoints = await $.store.get(checkpointsKey(root))
      await update($, checkpoints, () => (Array.isArray(storedCheckpoints) ? (storedCheckpoints as CheckpointRow[]) : []))
      try {
        baseline = (await takeCheckpoint($, 'session', m.checkpointKind.session)) ?? (await read($, checkpoints))[0]
      } catch (error) {
        debug($, error)
      }
    }
    $.clock.every(AGENTS_POLL_MS, () => void refreshAgents($).catch((error: unknown) => debug($, error)))
    $.clock.every(WORKTREES_POLL_MS, () => {
      void isPaneOpen($)
        .then(isOpen => (isOpen ? refreshWorktrees($) : undefined))
        .catch((error: unknown) => debug($, error))
    })

    return next(e)
  })

  // Where the keyboard is in the pane, so outlined tiles can show it.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE) await update($, focused, () => e.element ?? null)

    return result
  })

  // A new agent shows at once, not at the next poll.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($).catch((error: unknown) => debug($, error))

    return result
  })

  // A checkpoint before every prompt, so whatever the turn changes can be undone.
  on('turn.start', async ($, e, next) => {
    if (isCheckpointEveryPrompt && root) {
      try {
        await takeCheckpoint($, 'turn', promptLabel(e.text))
      } catch (error) {
        debug($, error)
      }
    }

    return next(e)
  })

  // After a turn the open pane catches up: changes since each checkpoint, the diff, the worktrees.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void (async () => {
      if (!(await isPaneOpen($))) return
      const active = await read($, tab)
      if (active === 'checkpoints') await refreshSince($)
      if (active === 'diff') await refreshDiff($)
      if (active === 'agents') await refreshWorktrees($)
    })().catch((error: unknown) => debug($, error))

    return result
  })

  // Open notes ride along with every prompt when the setting asks for it.
  on('prompt.submit', async ($, e, next) => {
    if (!isNotesInContext) return next(e)
    const open = (await read($, notes)).filter(note => !note.isDone)
    if (open.length === 0) return next(e)
    const block = [`Open notes for ${projectName()}:`, ...open.map(note => `- ${note.text}`)].join('\n')

    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // `commands/workspace.md` of the plugin `sc` declares /sc:workspace; this hook answers it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    try {
      if (first === '') {
        await openPane($)

        return { text: m.paneOpened(tabLabel(await read($, tab))) }
      }
      if (first === 'notes' && rest.length > 0) {
        const added = await addNote($, rest.join(' '))
        await openPane($, 'notes')

        return { text: added ?? m.paneOpened(tabLabel('notes')) }
      }
      if ((TABS as string[]).includes(first)) {
        await openPane($, first as Tab)

        return { text: m.paneOpened(tabLabel(first as Tab)) }
      }

      return { text: m.unknownTab(first) }
    } catch (error) {
      return { text: message(error) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const bodyColumns = e.props.bodyColumns ?? 60
    const header = { brand: BRAND, release: release.version ? m.release(release.version, release.date) : undefined }
    // A confirmation in progress takes the whole pane: the header, then the dialog.
    const asked = await read($, dialog)
    const askedRow = asked ? (await read($, checkpoints)).find(one => one.ref === asked.ref) : undefined
    if (asked && askedRow) {
      const since = askedRow.since
      const dismiss = async () => {
        await update($, dialog, () => null)
        await update($, focused, () => null)
      }
      const at = clockOf(askedRow.at, await $.clock.now(), locale)

      return Dialog(
        ui,
        bodyColumns,
        header,
        m.restoreTitle(at),
        [
          { text: m.restoreFrom(askedRow.label || m.checkpointKind[askedRow.kind]) },
          ...(since && since.files > 0 ? [{ text: m.restoreUndoes(m.filesCount(since.files), since.added, since.removed), tone: 'danger' as const }] : []),
          { text: m.restoreUndoHint, tone: 'muted' as const },
        ],
        {
          label: m.restoreConfirm,
          onPress: () => {
            void (async () => {
              await dismiss()
              $.ui.toast(await restore($, askedRow))
            })().catch((error: unknown) => $.ui.toast(message(error)))
          },
        },
        { label: m.cancel, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
        await read($, focused),
      )
    }
    const active = await read($, tab)
    // Reading the clock atom subscribes this pane to the agents' ticks.
    const now = Math.max(await $.clock.now(), await read($, clock))
    const confirm = await read($, pendingConfirm)
    const working = await read($, busy)
    const act = (work: () => Promise<string | void>, label?: string) => () => {
      void (async () => {
        if (label) await update($, busy, () => label)
        try {
          const text = await work()
          if (text) $.ui.toast(text)
        } finally {
          if (label) await update($, busy, () => null)
        }
      })().catch((error: unknown) => $.ui.toast(message(error)))
    }
    const arm = (key: string) => act(async () => {
      await update($, pendingConfirm, () => key)
    })()
    const confirmed = (work: () => Promise<string | void>) =>
      act(async () => {
        await update($, pendingConfirm, () => null)

        return work()
      })()
    const select = (key: string) =>
      act(async () => {
        await update($, pendingConfirm, () => null)
        await openPane($, key as Tab)
      })()

    const agentRows = await read($, agents)
    const noteRows = await read($, notes)
    const checkpointRows = await read($, checkpoints)
    const diffView = await read($, diff)
    const error = await read($, repoError)
    // The session's own start, or the newest one kept when this load took none.
    const sessionStart = baseline ?? checkpointRows.find(row => row.kind === 'session')
    const activeAgents = agentRows.filter(agent => agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting').length
    const openNotes = noteRows.filter(note => !note.isDone).length
    const tabs = [
      { key: 'agents', label: m.tabAgents, hotkey: '1', badge: activeAgents > 0 ? `${activeAgents}` : undefined },
      { key: 'checkpoints', label: m.tabCheckpoints, hotkey: '2', badge: checkpointRows.length > 0 ? `${checkpointRows.length}` : undefined },
      { key: 'notes', label: m.tabNotes, hotkey: '3', badge: openNotes > 0 ? `${openNotes}` : undefined },
      { key: 'diff', label: m.tabDiff, hotkey: '4', badge: diffView && diffView.files.length > 0 ? `${diffView.files.length}` : undefined },
    ]
    const close: Tile = { key: 'close', label: m.closeButton, isDismiss: true, onPress: act(() => $.ui.close({ id: PANE })) }
    const refreshTile = (work: () => Promise<void>): Tile => ({
      key: 'refresh',
      label: working === 'refresh' ? m.refreshingButton : m.refreshButton,
      isMain: true,
      onPress: act(work, 'refresh'),
    })

    let body
    let tiles: Tile[]
    if (active === 'checkpoints') {
      body = CheckpointsTab(
        ui,
        { checkpoints: checkpointRows, repoError: error, now, locale, m, bodyColumns, limit: CHECKPOINTS_SHOWN },
        {
          restore: row =>
            act(async () => {
              await update($, dialog, () => ({ kind: 'restore', ref: row.ref }))
              // The dialog is drawn in this pane, which takes the keys so Enter answers it.
              await $.ui.open({ id: PANE, title: m.paneTitle, focus: true })
            })(),
          compare: row =>
            act(async () => {
              await update($, tab, () => 'diff')
              await refreshDiff($, { commit: row.commit, label: row.label || m.checkpointKind[row.kind], at: row.at, isSessionStart: row.kind === 'session' })
            })(),
        },
      )
      tiles = [
        {
          key: 'checkpoint-now',
          label: m.checkpointNow,
          isMain: true,
          onPress: act(async () => {
            const row = await takeCheckpoint($, 'manual', '')
            await refreshSince($)

            return row ? m.checkpointTaken : m.nothingChanged
          }),
        },
        close,
      ]
    } else if (active === 'notes') {
      body = NotesTab(
        ui,
        { notes: noteRows, project: projectName(), pendingConfirm: confirm, isSentWithPrompts: isNotesInContext, m },
        {
          add: text => act(() => addNote($, text))(),
          toggle: note =>
            act(() =>
              saveNotes(
                $,
                noteRows.map(one => (one.id === note.id ? { ...one, isDone: !one.isDone } : one)),
              ),
            )(),
          insert: note =>
            act(async () => {
              await $.prompt.fill({ text: note.text, mode: 'insert' })
            })(),
          arm,
          remove: note => confirmed(() => saveNotes($, noteRows.filter(one => one.id !== note.id))),
          // The setting's change reloads this module with the new value.
          toggleSending: () =>
            act(async () => {
              const { deny } = await $.config.set({ key: NOTES_SETTING, value: !isNotesInContext })

              return deny ?? (isNotesInContext ? m.notesSendOff : m.notesSendOn)
            })(),
        },
      )
      tiles = [
        {
          key: 'clear-done',
          label: m.clearDone,
          onPress: act(() => saveNotes($, noteRows.filter(note => !note.isDone))),
        },
        close,
      ]
    } else if (active === 'diff') {
      body = DiffTab(
        ui,
        {
          diff: diffView,
          repoError: error,
          // A session-start base needs no way back to the session start, even one from before a reload.
          isSessionBase: !diffView || !sessionStart || diffView.base.isSessionStart === true || diffView.base.commit === sessionStart.commit,
          now,
          locale,
          m,
          bodyColumns,
        },
        {
          select: path => act(() => openFile($, path))(),
          closeFile: () =>
            act(async () => {
              await update($, diff, view => (view ? { ...view, selected: undefined } : view))
            })(),
          resetBase: () =>
            act(async () => {
              if (sessionStart) await refreshDiff($, { commit: sessionStart.commit, label: m.checkpointKind.session, at: sessionStart.at, isSessionStart: true })
            })(),
        },
      )
      tiles = [refreshTile(() => refreshDiff($)), close]
    } else {
      body = AgentsTab(
        ui,
        { agents: agentRows, worktrees: await read($, worktrees), repoError: error, root: root ?? '', home, pendingConfirm: confirm, now, m },
        {
          arm,
          stop: agent => confirmed(() => stopAgent($, agent)),
          removeWorktree: row => confirmed(() => dropWorktree($, row)),
        },
      )
      tiles = [refreshTile(async () => {
        await Promise.all([refreshAgents($), refreshWorktrees($)])
      }), close]
    }

    return (
      <Box flexDirection="column">
        {Header(ui, header.brand, header.release)}
        {TabBar(ui, tabs, active, select)}
        {Rule(ui, 'tabs-rule', bodyColumns)}
        <Box key={`body-${active}`} flexDirection="column" marginTop={1}>
          {body}
        </Box>
        {Tiles(ui, bodyColumns, tiles)}
      </Box>
    )
  })
}
