import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, CheckpointRow, DiffView, Note, Tab, WorktreeRow } from '../types'
import { checkpointRef, clipDiff, promptLabel, shortPath } from './git'
import { messagesFor, resolveLocale } from './i18n'
import type { Locale, Messages } from './i18n'
import { ChoiceDialog, Dialog, Header, Rule, TabBar, Tiles } from './shared/kit'
import type { DialogLine, Tile } from './shared/kit'
import { releaseDateOf } from './shared/locale'
import { AgentsTab } from './views/agents'
import { CheckpointsTab, clockOf } from './views/checkpoints'
import { baseChoices, DiffTab } from './views/diff'
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
  snapshotIndexPath,
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
const busy = atom({ plugin: 'sc-workspace', key: 'busy' } as const, null)
const clock = atom({ plugin: 'sc-workspace', key: 'clock' } as const, 0)
const dialog = atom({ plugin: 'sc-workspace', key: 'dialog' } as const, null)
const focused = atom({ plugin: 'sc-workspace', key: 'focused' } as const, null)
const paneOpen = atom({ plugin: 'sc-workspace', key: 'paneOpen' } as const, false)
/** Whether the accounts pane is open, as that plugin publishes it: with both open, the engine draws tabs. */
const accountsPaneOpen = { plugin: 'sc-accounts', key: 'paneOpen' } as const

const PANE = 'sc-workspace'
/** The product name heading the pane; a name, so it is not translated. */
const BRAND = 'SimpleCORE Mods'

/** The mod's name in the pane's title; a name, so it is never translated. */
const MOD_NAME = 'Workspace'

/** The pane's name, the brand and the mod's: the engine's tab label, and the header's when no tabs show. */
function paneName(): string {
  return `${BRAND}: ${MOD_NAME}`
}
const COMMAND = 'sc:workspace'
/** How long after a /clear ends the old session the new one is taken up, once the engine has switched ids. */
const CLEAR_SETTLE_MS = 300
/**
 * The accounts mod's band cells, the place and the lines changed, which toggle
 * this pane on its Diff tab. A cell is a row of Buttons, one per coloured run:
 * `band-place`, then `band-place-1`, `band-place-2` and on.
 */
const BAND = { plugin: 'sc-accounts', cells: ['band-place', 'band-lines'] }

function isBandCell(element: string): boolean {
  return BAND.cells.some(cell => element === cell || element.startsWith(`${cell}-`))
}
/** The `/config` row of the `notesInContext` setting. */
const NOTES_SETTING = 'sc-workspace.notesInContext'
const TABS: Tab[] = ['agents', 'checkpoints', 'notes', 'diff']
const AGENTS_POLL_MS = 3000
const WORKTREES_POLL_MS = 15_000
/** How often the open pane's Checkpoints, Diff or Notes tab is brought up to date. */
const LIVE_POLL_MS = 5000
/** How long file-changing tool calls must settle before the tab is refreshed. */
const LIVE_SETTLE_MS = 1500
/** Tools whose calls may change files in the working tree. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
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
/** This session's snapshot index under the git directory, set as the session starts. */
let snapshotIndex = ''
/** Snapshots run one at a time: two at once in one index would trip git's index lock. */
let snapshotChain: Promise<unknown> = Promise.resolve()
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

/** A snapshot of the working tree, queued behind any snapshot this session is already taking. */
function snapshot($: EngineInterface): Promise<string> {
  const next = snapshotChain.then(() => {
    if (!root) throw new Error(m.checkpointsNeedGit)

    return snapshotTree(runner($), root, snapshotIndex)
  })
  snapshotChain = next.catch(() => undefined)

  return next
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
  const tree = await snapshot($)
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
  const tree = await snapshot($)
  const list = await read($, checkpoints)
  const counted = new Map<string, CheckpointRow['since']>()
  for (const row of list.slice(0, CHECKPOINTS_SHOWN)) counted.set(row.ref, await diffSummary(run, root, row.commit, tree))
  // Merged by ref into the list as it stands now: a checkpoint taken while these were counted stays.
  const changed = list.some(row => counted.has(row.ref) && JSON.stringify(counted.get(row.ref)) !== JSON.stringify(row.since))
  if (changed) await update($, checkpoints, current => current.map(row => (counted.has(row.ref) ? { ...row, since: counted.get(row.ref) } : row)))
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
  const tree = await snapshot($)
  const files = await diffFiles(run, root, target.commit, tree)
  const openPath = base ? undefined : current?.selected?.path
  let selected: DiffView['selected']
  if (openPath && files.some(file => file.path === openPath)) {
    selected = { path: openPath, ...clipDiff(await fileDiff(run, root, target.commit, tree, openPath), DIFF_LINES) }
  }
  const isSame =
    current !== null &&
    current.base.commit === target.commit &&
    JSON.stringify(current.files) === JSON.stringify(files) &&
    JSON.stringify(current.selected) === JSON.stringify(selected)
  if (!isSame) await update($, diff, () => ({ base: target, files, selected, at: Date.now() }))
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  const current = await read($, diff)
  if (!root || !current) return
  if (current.selected?.path === path) {
    await update($, diff, view => (view ? { ...view, selected: undefined } : view))

    return
  }
  const run = runner($)
  const tree = await snapshot($)
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

/** Takes the project's notes as the store holds them, so a note another session wrote shows here. */
async function reloadNotes($: EngineInterface): Promise<void> {
  if (!root) return
  const stored = await $.store.get(notesKey(root))
  const list = Array.isArray(stored) ? (stored as Note[]) : []
  if (JSON.stringify(list) !== JSON.stringify(await read($, notes))) await update($, notes, () => list)
}

/** Whether a refresh of the visible tab is running: a second one asked meanwhile is dropped. */
let isLiveRefreshing = false
/** The pending refresh after a burst of file-changing tool calls. */
let liveRefreshTimer: { cancel: () => void } | undefined

/** Brings the tab on screen up to date with the working tree and the store, when the pane is open. */
async function refreshVisible($: EngineInterface): Promise<void> {
  if (isLiveRefreshing || !(await isPaneOpen($))) return
  isLiveRefreshing = true
  try {
    const active = await read($, tab)
    if (active === 'checkpoints') await refreshSince($)
    if (active === 'diff') await refreshDiff($)
    if (active === 'notes') await reloadNotes($)
  } finally {
    isLiveRefreshing = false
  }
}

/** Refreshes once a burst of file-changing tool calls has settled. */
function scheduleLiveRefresh($: EngineInterface): void {
  liveRefreshTimer?.cancel()
  liveRefreshTimer = $.clock.after(LIVE_SETTLE_MS, () => {
    liveRefreshTimer = undefined
    void refreshVisible($).catch((error: unknown) => debug($, error))
  })
}

async function openPane($: EngineInterface, next?: Tab): Promise<void> {
  if (next) await update($, tab, () => next)
  await $.ui.open({ id: PANE, title: paneName(), rows: 30 })
  if (!(await read($, paneOpen))) await update($, paneOpen, () => true)
  const active = await read($, tab)
  if (active === 'checkpoints') await refreshSince($)
  if (active === 'diff') await refreshDiff($)
  if (active === 'notes') await reloadNotes($)
  if (active === 'agents') await Promise.all([refreshAgents($), refreshWorktrees($)])
}

/**
 * Closes the pane when it is in view, else opens it on `next` (the tab last
 * shown without one); says which. A pane behind another pane's tab, or waiting
 * undrawn from an open nobody asked for, is opened afresh: in front, and placed.
 */
async function togglePane($: EngineInterface, next?: Tab): Promise<string> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isShown && pane.isPlaced) {
    // A dialog left asking would greet the next open.
    if ((await read($, dialog)) !== null) await update($, dialog, () => null)
    await closePane($)

    return m.paneClosed
  }
  if (pane) await $.ui.close({ id: PANE })
  await openPane($, next)

  return m.paneOpened(tabLabel(next ?? (await read($, tab))))
}

/**
 * Fills the state a session draws from: its id and snapshot index, the
 * project's notes and checkpoints, a checkpoint of the session's start, and
 * whether the pane is open. Run at session start, and again after a /clear,
 * whose new session starts with none.
 */
async function adoptSession($: EngineInterface): Promise<void> {
  sessionId = await $.session.id()
  root = await repoRoot(runner($), await $.session.root())
  snapshotIndex = root ? await snapshotIndexPath(runner($), root, sessionId) : ''
  await update($, repoError, () => (root ? null : m.checkpointsNeedGit))
  await update($, diff, () => null)
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
  if (await syncPaneOpen($)) await refreshVisible($)
}

/** Closes the pane and says so at once: the engine raises no ui.close to the plugin that asked. */
async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  if (await read($, paneOpen)) await update($, paneOpen, () => false)
}

/** Brings `paneOpen` in line with the panes the engine holds, however the pane was closed. */
async function syncPaneOpen($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if ((await read($, paneOpen)) !== isOpen) await update($, paneOpen, () => isOpen)

  return isOpen
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

/**
 * What the dialog asks about: one checkpoint to restore, note to delete, agent
 * to stop or worktree to remove; or, for `base`, which checkpoint the Diff tab
 * compares with (`ref` unused).
 */
type Dialog = { kind: 'restore' | 'note' | 'stop' | 'worktree' | 'base'; ref: string }

/** The checkpoints the Diff tab's base is picked from: the newest shown, and the session's own start. */
async function baseCandidates($: EngineInterface) {
  const rows = await read($, checkpoints)
  const start = baseline ?? rows.find(row => row.kind === 'session')
  const listed = rows.slice(0, CHECKPOINTS_SHOWN)
  if (start && !listed.some(row => row.commit === start.commit)) listed.push(start)

  return listed.map(row => ({
    commit: row.commit,
    label: row.label || m.checkpointKind[row.kind],
    at: row.at,
    isSessionStart: row.kind === 'session',
    since: row.since,
  }))
}

/**
 * What the dialog says for what it asks about, and what its confirming button
 * runs; null when that thing is gone (the dialog then shows nothing to confirm).
 */
async function dialogSpec(
  $: EngineInterface,
  asked: Dialog,
): Promise<{ title: string; lines: DialogLine[]; confirm: string; run: () => Promise<string | void> } | null> {
  if (asked.kind === 'base') return null
  const now = await $.clock.now()
  if (asked.kind === 'restore') {
    const row = (await read($, checkpoints)).find(one => one.ref === asked.ref)
    if (!row) return null
    const since = row.since

    return {
      title: m.restoreTitle(clockOf(row.at, now, locale)),
      lines: [
        { text: m.restoreFrom(row.label || m.checkpointKind[row.kind]) },
        ...(since && since.files > 0 ? [{ text: m.restoreUndoes(m.filesCount(since.files), since.added, since.removed), tone: 'danger' as const }] : []),
        { text: m.restoreUndoHint, tone: 'muted' as const },
      ],
      confirm: m.restoreConfirm,
      run: () => restore($, row),
    }
  }
  if (asked.kind === 'note') {
    const note = (await read($, notes)).find(one => one.id === asked.ref)
    if (!note) return null

    return {
      title: m.noteDeleteTitle,
      lines: [{ text: `“${note.text}”` }, { text: m.cannotUndo, tone: 'muted' }],
      confirm: m.deleteConfirm,
      run: async () => saveNotes($, (await read($, notes)).filter(one => one.id !== note.id)),
    }
  }
  if (asked.kind === 'stop') {
    const agent = (await read($, agents)).find(one => one.id === asked.ref)
    if (!agent) return null

    return {
      title: m.stopTitle(agent.label),
      lines: [{ text: `${agent.type} · ${m.agentStatus[agent.status]}` }, { text: m.stopHint, tone: 'muted' }],
      confirm: m.stopConfirm,
      run: () => stopAgent($, agent),
    }
  }
  const row = (await read($, worktrees)).find(one => one.path === asked.ref)
  if (!row) return null

  return {
    title: m.worktreeTitle(row.branch ?? m.detached),
    lines: [{ text: shortPath(row.path, root ?? '', home) }, { text: m.worktreeHint, tone: 'danger' }],
    confirm: m.removeConfirm,
    run: () => dropWorktree($, row),
  }
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
    // A pane an earlier build opened and this one no longer draws (the old dialog pane) would
    // stay on screen empty, past the workspace's own Close: close every pane but the workspace.
    for (const pane of await $.ui.panes()) {
      if (pane.id !== PANE) await $.ui.close({ id: pane.id }).catch((error: unknown) => debug($, error))
    }
    await adoptSession($)
    $.clock.every(AGENTS_POLL_MS, () => void refreshAgents($).catch((error: unknown) => debug($, error)))
    // Edits made outside the session (an editor, a script) show within a few seconds too.
    $.clock.every(LIVE_POLL_MS, () => {
      void syncPaneOpen($)
        .then(() => refreshVisible($))
        .catch((error: unknown) => debug($, error))
    })
    $.clock.every(WORKTREES_POLL_MS, () => {
      void isPaneOpen($)
        .then(isOpen => (isOpen ? refreshWorktrees($) : undefined))
        .catch((error: unknown) => debug($, error))
    })

    return next(e)
  })

  // Esc (or the close mark) while the dialog asks cancels the dialog and keeps the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, dialog)) !== null) {
      await update($, dialog, () => null)
      await update($, focused, () => null)

      return { value: undefined }
    }
    const result = await next(e)
    if (e.id === PANE && (await read($, paneOpen))) await update($, paneOpen, () => false)

    return result
  })

  // The session's snapshot index goes with it; checkpoints are commits and stay. A /clear goes
  // on in this process under a new session id with no session.start: the new session is taken
  // up here, once the old one has ended.
  on('session.end', async ($, e, next) => {
    if (snapshotIndex) {
      await $.process.run(['rm', '-f', '--', snapshotIndex], { timeoutMs: 5000 }).catch((error: unknown) => debug($, error))
    }
    const result = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_SETTLE_MS, () => {
        void adoptSession($).catch((error: unknown) => debug($, error))
      })
    }

    return result
  })

  // Where the keyboard is in the pane, so outlined tiles can show it.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE) await update($, focused, () => e.element ?? null)

    return result
  })

  // A file-changing tool call, a subagent's too, refreshes the visible tab once the burst settles.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (FILE_TOOLS.has(String(e.tool))) scheduleLiveRefresh($)

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
      // `toggle [tab]`: closes the pane when it is open, else opens it, on `tab` when one is named.
      if (first === 'toggle') {
        const named = rest[0] && (TABS as string[]).includes(rest[0]) ? (rest[0] as Tab) : undefined

        return { text: await togglePane($, named) }
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

  // The accounts band's place or lines changed, pressed: toggled here, inside the person's
  // press, so the pane counts as asked for and is placed at any width.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== BAND.plugin || e.component !== 'AbovePrompt' || !isBandCell(e.element)) return next(e)
    await togglePane($, 'diff')

    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const bodyColumns = e.props.bodyColumns ?? 60
    // The pane's name once: on the engine's tab while the accounts pane is open beside it, else here.
    const isTabbed = (await $.state.get(accountsPaneOpen)).value === true
    const header = { brand: isTabbed ? '' : paneName(), release: release.version ? m.release(release.version, release.date) : undefined }
    // A dialog in progress takes the whole pane: the header, then the dialog.
    const asked = await read($, dialog)
    const dismiss = async () => {
      await update($, dialog, () => null)
      await update($, focused, () => null)
    }
    if (asked?.kind === 'base') {
      const now = await $.clock.now()
      const choices = baseChoices(await baseCandidates($), (await read($, diff))?.base, now, locale, m)

      return ChoiceDialog(
        ui,
        bodyColumns,
        header,
        m.baseTitle,
        choices.map(choice => ({
          ...choice,
          onPress: () => {
            void (async () => {
              await dismiss()
              if (!choice.isCurrent) await refreshDiff($, choice.base)
            })().catch((error: unknown) => $.ui.toast(message(error)))
          },
        })),
        { label: m.cancel, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
        await read($, focused),
      )
    }
    const spec = asked ? await dialogSpec($, asked) : null
    if (asked && spec) {
      return Dialog(
        ui,
        bodyColumns,
        header,
        spec.title,
        spec.lines,
        {
          label: spec.confirm,
          onPress: () => {
            void (async () => {
              await dismiss()
              const text = await spec.run()
              if (text) $.ui.toast(text)
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
    // Whatever cannot be taken back asks in the dialog first.
    const ask = (kind: Dialog['kind'], ref: string) =>
      act(async () => {
        await update($, dialog, () => ({ kind, ref }))
        // The dialog is drawn in this pane, which takes the keys so Enter answers it; Esc
        // asks the pane to close, which the ui.close hook turns into Cancel.
        await $.ui.open({ id: PANE, title: paneName(), focus: true, closeOnEscape: true })
      })()
    const select = (key: string) => act(() => openPane($, key as Tab))()

    const agentRows = await read($, agents)
    const noteRows = await read($, notes)
    const checkpointRows = await read($, checkpoints)
    const diffView = await read($, diff)
    const error = await read($, repoError)
    const activeAgents = agentRows.filter(agent => agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting').length
    const openNotes = noteRows.filter(note => !note.isDone).length
    const tabs = [
      { key: 'agents', label: m.tabAgents, hotkey: '1', badge: activeAgents > 0 ? `${activeAgents}` : undefined },
      { key: 'checkpoints', label: m.tabCheckpoints, hotkey: '2', badge: checkpointRows.length > 0 ? `${checkpointRows.length}` : undefined },
      { key: 'notes', label: m.tabNotes, hotkey: '3', badge: openNotes > 0 ? `${openNotes}` : undefined },
      { key: 'diff', label: m.tabDiff, hotkey: '4', badge: diffView && diffView.files.length > 0 ? `${diffView.files.length}` : undefined },
    ]
    const close: Tile = { key: 'close', label: m.closeButton, isDismiss: true, onPress: act(() => closePane($)) }
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
          restore: row => ask('restore', row.ref),
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
        { notes: noteRows, project: projectName(), isSentWithPrompts: isNotesInContext, hasField: e.surface !== 'mobile', m },
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
          remove: note => ask('note', note.id),
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
          chooseBase: () => ask('base', ''),
        },
      )
      tiles = [refreshTile(() => refreshDiff($)), close]
    } else {
      body = AgentsTab(
        ui,
        { agents: agentRows, worktrees: await read($, worktrees), repoError: error, root: root ?? '', home, now, m },
        {
          stop: agent => ask('stop', agent.id),
          removeWorktree: row => ask('worktree', row.path),
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
