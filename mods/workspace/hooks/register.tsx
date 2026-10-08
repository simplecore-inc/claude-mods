import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentActivity, AgentRow, CheckpointRow, DiffPoint, DiffView, MemoryFile, MemoryKind, MemoryScope, Note, Tab, WorktreeRow } from '../types'
import { claudeFiles, frontmatterOf, importsOf, isPathRule, markdownPages, outlineOf, pageOfLine, reflow, searchMemory } from './memory'
import { MemoryTab } from './views/memory'
import { releaseHeader } from './shared/release'
import { LATEST_RELEASE_KEY, RELEASE_CHECK_MS, latestReleaseUrl, latestVersion } from './shared/release'
import type { RunningRelease } from './shared/release'
import { projectFolder } from './shared/claude'
import { checkpointRef, clipDiff, diffPages, finishAgents, keptCheckpoints, promptLabel, shortPath } from './git'
import { adoptStored, changeList, listPaths, readList } from './lists'
import type { ListFiles } from './lists'
import { messagesFor, resolveLocale } from './i18n'
import type { Locale, Messages } from './i18n'
import { isBesideOtherPanes } from './shared/panes'
import { ChoiceDialog, CodeDialog, Dialog, Header, InputDialog, paneTitle, ReaderDialog, Rule, TabBar, Tiles } from './shared/kit'
import { doneMarks, nextSeq, notesContext, numbered } from './notes'
import type { DialogLine, Tile } from './shared/kit'
import { releaseDateOf } from './shared/locale'
import { AgentsTab, toolSummary } from './views/agents'
import { checkpointLabel, CheckpointsTab, clockOf } from './views/checkpoints'
import { baseChoices, commitPrompt, DiffTab, targetChoices } from './views/diff'
import { NotesTab } from './views/notes'
import {
  createCheckpoint,
  deleteRef,
  diffFiles,
  diffSummary,
  fileDiff,
  listWorktrees,
  mergeBase,
  removeWorktree,
  repoRoot,
  restoreCheckpoint,
  restoreFile,
  snapshotIndexPath,
  snapshotTree,
} from './workspace'
import type { Run } from './workspace'
import { removeArgv } from './shared/files'

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
const activity = atom({ plugin: 'sc-workspace', key: 'activity' } as const, {})
const answers = atom({ plugin: 'sc-workspace', key: 'answers' } as const, {})
const finished = atom({ plugin: 'sc-workspace', key: 'finished' } as const, [])
const expandedAgent = atom({ plugin: 'sc-workspace', key: 'expandedAgent' } as const, null)
const memory = atom({ plugin: 'sc-workspace', key: 'memory' } as const, null)
const memoryQuery = atom({ plugin: 'sc-workspace', key: 'memoryQuery' } as const, '')
const memoryScope = atom({ plugin: 'sc-workspace', key: 'memoryScope' } as const, 'all')
const memoryOpen = atom({ plugin: 'sc-workspace', key: 'memoryOpen' } as const, null)
const memoryPage = atom({ plugin: 'sc-workspace', key: 'memoryPage' } as const, 0)
const diffPage = atom({ plugin: 'sc-workspace', key: 'diffPage' } as const, 0)
/** Where the organisation's policy memory sits, on macOS, Linux and WSL, and Windows: whichever exists is read. */
const MANAGED_MEMORY = ['/Library/Application Support/ClaudeCode/CLAUDE.md', '/etc/claude-code/CLAUDE.md', 'C:/Program Files/ClaudeCode/CLAUDE.md']
/** How many hops of `@path` imports Claude Code follows. */
const IMPORT_HOPS = 4
/** The largest memory file Claude Code loads whole; a larger one is skipped. */
const MEMORY_MAX_BYTES = 4 * 1024 * 1024
/** How deep the rules folders are searched for `.md` files. */
const RULES_DEPTH = 6
/** Finished agents kept for the session; older ones are let go. */
const FINISHED_KEPT = 20

const PANE = 'sc-workspace'

/** The mod's name in the pane's title; a name, so it is never translated. */
const MOD_NAME = 'Workspace'

/** The pane's label on the engine's tab row, shown while another pane is open beside it. */
const TAB_LABEL = 'Workspace'

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
const TABS: Tab[] = ['agents', 'checkpoints', 'notes', 'diff', 'memory']
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
const DIFF_LINES = 5_000
/** Characters of a file's diff kept for its dialog, which shows it a page at a time. */
const DIFF_DIALOG_CHARS = 400_000
/** Lines of a diff on one page of its dialog: a fixed count, so the dialog keeps its height. */
const DIFF_PAGE_LINES = 24

let locale: Locale = 'en'
let m: Messages = messagesFor(locale)
/** Whether this session has been told, once, that clicks need fullscreen mode. */
let isClickHintShown = false

/** Marks the click hint as shown when `text` carries it. */
function opened(text: string): string {
  if (text.includes(m.clickHint)) isClickHintShown = true

  return text
}
let release: RunningRelease = {}
/** The repository's top directory, or null outside a repository. */
let root: string | null = null
let home: string | undefined
/** Windows proper (not WSL): files are deleted with cmd.exe, which has no `rm`. */
let isWindows = false
let sessionId = ''
/** The checkpoint taken as the session started: the Diff tab's default base. */
let baseline: CheckpointRow | undefined
/** This session's snapshot index under the git directory, set as the session starts. */
let snapshotIndex = ''
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

/** A snapshot of the working tree in this session's own index, after any snapshot already taken in it. */
async function snapshot($: EngineInterface): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)

  return snapshotTree(runner($), root, snapshotIndex)
}

/**
 * This session's snapshot index in each other worktree it may have shown the
 * changes of: deleted with its own when the session ends. Read from the
 * worktrees listed, so a reload of the plugin between leaves none behind.
 */
async function otherSnapshotIndexes($: EngineInterface): Promise<string[]> {
  const run = runner($)
  const found: string[] = []
  for (const row of await read($, worktrees)) {
    if (row.path === root) continue
    const path = await snapshotIndexPath(run, row.path, sessionId).catch((error: unknown) => {
      debug($, error)

      return ''
    })
    if (path !== '') found.push(path)
  }

  return found
}

/** The plugin store's keys for a project's lists, from before they were files: read once, to move them. */
const checkpointsKey = (project: string) => `checkpoints:${project}`
const notesKey = (project: string) => `notes:${project}`

/** The files of this working tree's notes and checkpoint list; undefined outside a repository. */
let lists: { notes: string; checkpoints: string } | undefined

/** The file calls the lists are kept through, over `$.fs`. */
function listFiles($: EngineInterface): ListFiles {
  return {
    exists: path => $.fs.exists(path),
    read: async path => {
      const text = await $.fs.read(path)

      return typeof text === 'string' ? text : ''
    },
    write: (path, text) => $.fs.write(path, text),
  }
}

function tabLabel(key: Tab): string {
  return { agents: m.tabAgents, checkpoints: m.tabCheckpoints, notes: m.tabNotes, diff: m.tabDiff, memory: m.tabMemory }[key]
}

function projectName(): string {
  return root ? (root.split('/').pop() ?? root) : ''
}

async function readRelease($: EngineInterface): Promise<RunningRelease> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string; repository?: string }
    if (typeof manifest.version !== 'string') return {}
    const changelogPath = `${$.plugin.root}/CHANGELOG.md`
    const changelog = (await $.fs.exists(changelogPath)) ? await $.fs.read(changelogPath) : ''

    return { version: manifest.version, date: releaseDateOf(changelog, manifest.version), repository: manifest.repository }
  } catch (error) {
    debug($, error)

    return {}
  }
}

/** Hears of the latest published release, so the pane header says when an update is due. */
async function followLatestRelease($: EngineInterface): Promise<void> {
  const url = latestReleaseUrl(release.repository)
  if (url === null) return
  const latest = await latestVersion(
    {
      now: () => $.clock.now(),
      get: () => $.store.get(LATEST_RELEASE_KEY),
      set: value => $.store.set(LATEST_RELEASE_KEY, value),
      fetch: (target, init) => $.http.fetch(target, init),
    },
    url,
  )
  release = { ...release, latest }
}

// ── agents and worktrees ──────────────────────────────────────────────────

async function refreshAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const rows: AgentRow[] = (await $.agent.list()).map(agent => {
    if (!firstSeen.has(agent.id)) firstSeen.set(agent.id, now)

    return {
      id: agent.id,
      stopIds: [...new Set([agent.id, agent.name, agent.teammateId].filter((one): one is string => typeof one === 'string' && one !== ''))],
      label: agent.name ?? agent.description,
      type: agent.type,
      status: agent.status,
      firstSeen: firstSeen.get(agent.id) ?? now,
    }
  })
  const current = await read($, agents)
  if (JSON.stringify(current) !== JSON.stringify(rows)) await update($, agents, () => rows)
  // An agent the engine stops listing moves to the finished group, with its answer, for the session.
  const listed = new Set(rows.map(row => row.id))
  const kept = await read($, answers)
  const before = await read($, finished)
  const after = finishAgents(current, rows, before, kept, now, FINISHED_KEPT)
  if (JSON.stringify(after) !== JSON.stringify(before)) await update($, finished, () => after)
  // Activity and answers are kept for the agents listed or finished; the rest go.
  const known = new Set([...listed, ...(await read($, finished)).map(row => row.id)])
  const recorded = await read($, activity)
  if (Object.keys(recorded).some(id => !known.has(id))) {
    await update($, activity, value => Object.fromEntries(Object.entries(value).filter(([id]) => known.has(id))))
  }
  const answered = await read($, answers)
  if (Object.keys(answered).some(id => !known.has(id))) {
    await update($, answers, value => Object.fromEntries(Object.entries(value).filter(([id]) => known.has(id))))
  }
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

/**
 * Stops an agent through Claude Code's TaskStop, by its id first and then by
 * the other names TaskStop takes. A refusal (the person's, a hook's) is said
 * at once and not asked again; a stop no name reaches says why.
 */
async function stopAgent($: EngineInterface, agent: AgentRow): Promise<string> {
  let reason = ''
  try {
    for (const taskId of agent.stopIds) {
      const result = await $.tool.call({ tool: 'TaskStop', task_id: taskId })
      if (result.deny !== undefined) throw new Error(m.stopFailed(agent.label, result.deny))
      if (result.isError !== true) return m.stopped(agent.label)
      reason = result.text ?? reason
    }
    throw new Error(m.stopFailed(agent.label, reason))
  } finally {
    await refreshAgents($)
  }
}

async function dropWorktree($: EngineInterface, row: WorktreeRow): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)
  await removeWorktree(runner($), root, row)
  await refreshWorktrees($)

  return m.worktreeRemoved(row.path)
}

// ── checkpoints ───────────────────────────────────────────────────────────

/**
 * Changes the checkpoint list as its file holds it now and shows the result,
 * with what changed since each as last counted, so a reload or a new session
 * shows the counts at once. Never a list read earlier: that would write over
 * a row another session added or a press made since.
 */
async function changeCheckpoints($: EngineInterface, change: (list: CheckpointRow[]) => CheckpointRow[]): Promise<CheckpointRow[]> {
  if (!lists) return read($, checkpoints)
  const list = await changeList<CheckpointRow>(listFiles($), lists.checkpoints, change)
  await update($, checkpoints, () => list)

  return list
}

/** The checkpoint being taken, which the next waits for: two at once would number themselves alike. */
let checkpointTaking: Promise<unknown> = Promise.resolve()

/**
 * Takes a checkpoint unless nothing changed since the latest one (or `force`),
 * one at a time.
 * @returns the checkpoint taken, or null when there was nothing new
 */
function takeCheckpoint($: EngineInterface, kind: CheckpointRow['kind'], label: string, force = false): Promise<CheckpointRow | null> {
  const taking = checkpointTaking.then(() => takeOneCheckpoint($, kind, label, force))
  checkpointTaking = taking.catch(() => undefined)

  return taking
}

async function takeOneCheckpoint($: EngineInterface, kind: CheckpointRow['kind'], label: string, force: boolean): Promise<CheckpointRow | null> {
  if (!root || !lists) return null
  const run = runner($)
  const tree = await snapshot($)
  const list = await readList<CheckpointRow>(listFiles($), lists.checkpoints)
  if (!force && list[0]?.tree === tree) return null
  // This session's rows are written by it alone, one at a time: the next number is free.
  const own = list.filter(row => row.ref.includes(`/${sessionId}/`))
  const seq = own.reduce((max, row) => Math.max(max, Number(row.ref.split('/').pop()) || 0), 0) + 1
  const ref = checkpointRef(sessionId, seq)
  const { commit } = await createCheckpoint(run, root, ref, label || m.checkpointKind[kind], tree)
  const row: CheckpointRow = { ref, commit, tree, at: await $.clock.now(), label, kind, since: { files: 0, added: 0, removed: 0 } }
  // Pinned checkpoints are kept whatever their age, and this session's start, the Diff tab's
  // default base; the newest 50 others besides. Rows another session wrote meanwhile stay.
  let gone: CheckpointRow[] = []
  await changeCheckpoints($, current => {
    const all = [row, ...current.filter(one => one.ref !== ref)].sort((a, b) => b.at - a.at)
    const result = keptCheckpoints(all, CHECKPOINTS_KEPT, baseline ? [baseline.ref] : [])
    gone = result.gone

    return result.kept
  })
  for (const old of gone) {
    await deleteRef(run, root, old.ref).catch((error: unknown) => debug($, error))
  }

  return row
}

/** The working tree and the checkpoints last counted against it: while both stay, so do the counts. */
let lastCounted = ''

/**
 * Counts what changed since each checkpoint shown against the working tree now,
 * and since the session's start, which the base dialog offers even past them.
 */
async function refreshSince($: EngineInterface): Promise<void> {
  if (!root || !lists) return
  const run = runner($)
  const tree = await snapshot($)
  const list = await read($, checkpoints)
  const shown = list.slice(0, CHECKPOINTS_SHOWN)
  const start = list.find(row => row.ref === baseline?.ref) ?? list.find(row => row.kind === 'session')
  if (start && !shown.includes(start)) shown.push(start)
  const counting = [tree, ...shown.map(row => row.commit)].join(' ')
  if (counting === lastCounted && shown.every(row => row.since !== undefined)) return
  const counted = new Map<string, CheckpointRow['since']>()
  for (const row of shown) counted.set(row.ref, await diffSummary(run, root, row.commit, tree))
  lastCounted = counting
  const changed = list.some(row => counted.has(row.ref) && JSON.stringify(counted.get(row.ref)) !== JSON.stringify(row.since))
  if (!changed) return
  // Applied by ref to the list as its file holds it now: a checkpoint taken while these were counted stays.
  await changeCheckpoints($, current => current.map(row => (counted.has(row.ref) ? { ...row, since: counted.get(row.ref) } : row)))
}

/** Pins a checkpoint (`isPinned`), or unpins it: a pinned one is never deleted to make room. */
async function setPin($: EngineInterface, ref: string, isPinned: boolean): Promise<string> {
  let isFound = false
  await changeCheckpoints($, list =>
    list.map(one => {
      if (one.ref !== ref) return one
      isFound = true

      return { ...one, isPinned }
    }),
  )
  if (!isFound) return m.checkpointsEmpty

  return isPinned ? m.pinned : m.unpinned
}

/** Names a checkpoint and pins it; an empty name takes the name away and leaves the pin. */
async function nameCheckpoint($: EngineInterface, ref: string, name: string): Promise<string | void> {
  const clean = name.replace(/\s+/g, ' ').trim()
  let isFound = false
  await changeCheckpoints($, list =>
    list.map(one => {
      if (one.ref !== ref) return one
      isFound = true
      const { name: _old, ...rest } = one

      return clean ? { ...rest, name: clean, isPinned: true } : rest
    }),
  )
  if (!isFound) return m.checkpointsEmpty

  return clean ? m.named(clean) : undefined
}

async function restore($: EngineInterface, row: CheckpointRow): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)
  const before = await takeCheckpoint($, 'restore', m.checkpointKind.restore, true)
  if (!before) throw new Error(m.checkpointsNeedGit)
  await restoreCheckpoint(runner($), root, row.commit, row.tree, before.tree, isWindows)
  await refreshSince($)
  await refreshDiff($)

  return m.restored(clockOf(row.at, await $.clock.now(), locale))
}

/** Puts one file of the Diff tab back as it was at the base, after a checkpoint that undoes it. */
async function restoreOneFile($: EngineInterface, path: string): Promise<string> {
  if (!root) throw new Error(m.checkpointsNeedGit)
  const view = await read($, diff)
  const file = view?.files.find(one => one.path === path)
  if (!view || !file) return m.diffEmpty
  const before = await takeCheckpoint($, 'restore', m.checkpointKind.restore, true)
  if (!before) throw new Error(m.checkpointsNeedGit)
  await restoreFile(runner($), root, view.base.commit, file, isWindows)
  await update($, diff, current => (current && current.selected?.path === path ? { ...current, selected: undefined } : current))
  await refreshDiff($)
  await refreshSince($)

  return m.fileRestored(path)
}

/** Records what an agent did last, for the Agents tab. */
async function recordActivity($: EngineInterface, agentId: string, entry: Omit<AgentActivity, 'at'>): Promise<void> {
  const at = await $.clock.now()
  await update($, activity, current => ({ ...current, [agentId]: { ...entry, at } }))
}

// ── diff ──────────────────────────────────────────────────────────────────

/** A snapshot of another worktree, untracked files included, in an index of its own for this session. */
async function worktreeTree($: EngineInterface, path: string): Promise<string> {
  const run = runner($)

  return snapshotTree(run, path, await snapshotIndexPath(run, path, sessionId))
}

/** Shows another worktree's changes since its branch parted from the main branch, on the Diff tab. */
async function openWorktreeDiff($: EngineInterface, row: WorktreeRow): Promise<void> {
  if (!root || !row.branch) return
  const main = (await read($, worktrees)).find(one => one.isMain)?.branch
  if (!main) throw new Error(m.detached)
  const run = runner($)
  const commit = await mergeBase(run, root, main, row.branch)
  const files = await diffFiles(run, root, commit, await worktreeTree($, row.path))
  const at = await $.clock.now()
  await update($, tab, () => 'diff')
  await update($, diff, () => ({
    base: { commit, label: main, at: 0, isSessionStart: false },
    worktree: { path: row.path, branch: row.branch ?? '' },
    files,
    at,
  }))
}

/** The commit or tree the Diff tab compares up to: a checkpoint's commit, or a snapshot of the working tree. */
async function targetTree($: EngineInterface, target: DiffPoint | undefined): Promise<string> {
  return target ? target.commit : snapshot($)
}

/**
 * Compares `base` (the current one when absent) with `target`: a later
 * checkpoint, or the working tree when null; the current target when absent.
 * A base picked at or after the target compares with the working tree. The
 * open file stays open while the ends stay.
 */
async function refreshDiff($: EngineInterface, base?: DiffPoint, target?: DiffPoint | null): Promise<void> {
  if (!root) return
  const current = await read($, diff)
  // Another worktree's view stays on it until it is closed; only its files are counted again.
  if (current?.worktree && base === undefined && target === undefined) {
    const files = await diffFiles(runner($), root, current.base.commit, await worktreeTree($, current.worktree.path))
    if (JSON.stringify(files) !== JSON.stringify(current.files)) await update($, diff, view => (view ? { ...view, files, selected: undefined } : view))

    return
  }
  const start = baseline ?? (await read($, checkpoints)).find(row => row.kind === 'session')
  const from = base ?? current?.base ?? (start ? { commit: start.commit, label: m.checkpointKind.session, at: start.at, isSessionStart: true } : undefined)
  if (!from) return
  const wanted = target === null ? undefined : (target ?? current?.target)
  const to = wanted && wanted.at > from.at ? wanted : undefined
  const run = runner($)
  const tree = await targetTree($, to)
  const files = await diffFiles(run, root, from.commit, tree)
  const isSameEnds = !base && target === undefined
  const openPath = isSameEnds ? current?.selected?.path : undefined
  let selected: DiffView['selected']
  if (openPath && files.some(file => file.path === openPath)) {
    selected = { path: openPath, ...clipDiff(await fileDiff(run, root, from.commit, tree, openPath), DIFF_LINES, DIFF_DIALOG_CHARS) }
  }
  const isSame =
    current !== null &&
    current.base.commit === from.commit &&
    current.target?.commit === to?.commit &&
    JSON.stringify(current.files) === JSON.stringify(files) &&
    JSON.stringify(current.selected) === JSON.stringify(selected)
  if (!isSame) {
    const at = await $.clock.now()
    await update($, diff, () => ({ base: from, target: to, files, selected, at }))
  }
}

/** Opens a file's diff in its dialog, on its first page: however long the file list, the diff is never below it. */
async function openFile($: EngineInterface, path: string): Promise<void> {
  const current = await read($, diff)
  if (!root || !current) return
  const run = runner($)
  const tree = current.worktree ? await worktreeTree($, current.worktree.path) : await targetTree($, current.target)
  const selected = { path, ...clipDiff(await fileDiff(run, root, current.base.commit, tree, path), DIFF_LINES, DIFF_DIALOG_CHARS) }
  await update($, diff, view => (view ? { ...view, selected } : view))
  await update($, diffPage, () => 0)
  await update($, dialog, () => ({ kind: 'diff', ref: path }))
  await $.ui.open({ id: PANE, title: TAB_LABEL, focus: true, closeOnEscape: true, rows: READER_PANE_ROWS })
}

// ── memory ────────────────────────────────────────────────────────────────

/**
 * The rows a reader page takes at the pane's width: the reader opens the pane
 * 40 rows tall, and the header, the frame, the title, its line and the tiles
 * take the rest. Fixed, not read from the pane: a pane sizes itself to what it
 * draws, so a page cut to the rows on screen would shrink with every page.
 */
const READER_PAGE_ROWS = 26
/** The pane's rows while the reader is open. */
const READER_PANE_ROWS = 40
/** The columns a reader page wraps at, as the pane last drew; a page is cut to them. */
let readerRoom: { rows: number; columns?: number } = { rows: READER_PAGE_ROWS }

/** Each memory file's text as last read, for the search; the files themselves are in the `memory` state. */
const memoryTexts = new Map<string, string>()

/** A file's text when it is a file Claude Code would load whole; null otherwise. */
async function memoryText($: EngineInterface, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > MEMORY_MAX_BYTES) return null

    return await $.fs.read(path)
  } catch (error) {
    debug($, error)

    return null
  }
}

/** Every `.md` file under `folder`, its subfolders included. */
async function markdownUnder($: EngineInterface, folder: string, depth = 1): Promise<string[]> {
  if (depth > RULES_DEPTH || !(await $.fs.exists(folder))) return []
  const found: string[] = []
  for (const entry of await $.fs.list(folder)) {
    const path = `${folder}/${entry.name}`
    if (entry.kind === 'dir') found.push(...(await markdownUnder($, path, depth + 1)))
    else if (entry.name.endsWith('.md')) found.push(path)
  }

  return found.sort()
}

/** A path as the Memory tab shows it: from the project when inside it, from home with `~` when under it. */
function memoryDisplay(path: string, project: string): string {
  if (path.startsWith(`${project}/`)) return path.slice(project.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`

  return path
}

/** The folders from `folder` up to the filesystem's root, nearest first. */
function foldersUp(folder: string): string[] {
  const found: string[] = []
  let current = folder
  while (current !== '' && current !== '/') {
    found.push(current)
    const parent = current.slice(0, current.lastIndexOf('/'))
    if (parent === current) break
    current = parent
  }

  return found
}

/**
 * Reads every memory file Claude Code loads in this session, as its memory
 * documentation lists them, with the files each imports, and keeps their
 * outlines for the Memory tab.
 */
async function loadMemory($: EngineInterface): Promise<void> {
  const run = runner($)
  const cwd = (await $.session.root()).replaceAll('\\', '/')
  const project = root ?? cwd
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home ?? ''}/.claude`).replaceAll('\\', '/')
  const files: MemoryFile[] = []
  const seen = new Set<string>()
  memoryTexts.clear()
  const add = async (path: string, scope: MemoryScope, kind: MemoryKind, hops = 0, note?: string): Promise<boolean> => {
    if (seen.has(path)) return true
    const text = await memoryText($, path)
    if (text === null) return false
    seen.add(path)
    memoryTexts.set(path, text)
    const front = frontmatterOf(text)
    // A rule with `paths` in its frontmatter loads only when Claude works on a file it matches.
    const isForMatching = kind === 'rule' && isPathRule(text)
    files.push({
      path,
      display: memoryDisplay(path, project),
      scope,
      kind: isForMatching ? 'pathRule' : kind,
      bytes: new TextEncoder().encode(text).length,
      lines: text.split(/\r?\n/).length,
      outline: outlineOf(text),
      ...(note ? { note } : kind === 'auto' && front.description ? { note: front.description } : {}),
    })
    if (hops < IMPORT_HOPS) {
      for (const imported of importsOf(text, path, home ?? '')) await add(imported, scope, 'imported', hops + 1, memoryDisplay(path, project))
    }

    return true
  }
  for (const path of MANAGED_MEMORY) await add(path, 'global', 'managed')
  await add(`${configDir}/CLAUDE.md`, 'global', 'user')
  for (const path of await markdownUnder($, `${configDir}/rules`)) await add(path, 'global', 'userRule')
  // CLAUDE.md and CLAUDE.local.md load from the working directory and every folder above it.
  let hasInstructions = false
  for (const folder of foldersUp(cwd)) {
    const isInside = folder === project || folder.startsWith(`${project}/`)
    if (await add(`${folder}/CLAUDE.md`, 'project', isInside ? 'project' : 'parent')) hasInstructions = true
    if (await add(`${folder}/CLAUDE.local.md`, 'project', isInside ? 'local' : 'parent')) hasInstructions = true
  }
  await add(`${project}/.claude/CLAUDE.md`, 'project', 'project')
  for (const path of await markdownUnder($, `${project}/.claude/rules`)) await add(path, 'project', 'rule')
  // AGENTS.md is read only where no CLAUDE.md or CLAUDE.local.md is.
  if (!hasInstructions) await add(`${cwd}/AGENTS.md`, 'project', 'agents')
  // A subfolder's CLAUDE.md loads when Claude reads files in that folder.
  if (root) {
    // Only those files are asked for, NUL-separated: the list stays short in any repository, and a Korean folder's name is as it is.
    const listed = await run(['git', 'ls-files', '-z', '-co', '--exclude-standard', '--', ':(glob)**/CLAUDE.md', ':(glob)**/CLAUDE.local.md'], {
      cwd: root,
      timeoutMs: 30_000,
    })
    if (listed.exitCode === 0) {
      for (const relative of claudeFiles(listed.stdout)) await add(`${root}/${relative}`, 'project', 'subfolder')
    }
  }
  // Auto memory is kept per git repository, so every worktree of one shares it.
  const settings = (await $.settings.read()) as { autoMemoryDirectory?: unknown }
  let memoryRoot = project
  if (root) {
    const common = await run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })
    if (common.exitCode === 0) memoryRoot = common.stdout.trim().replace(/\/\.git\/?$/, '')
  }
  const autoFolder = typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory.replace(/^~(?=\/)/, home ?? '~') : `${configDir}/projects/${projectFolder(memoryRoot)}/memory`
  await add(`${autoFolder}/MEMORY.md`, 'project', 'autoIndex', 0, memoryDisplay(autoFolder, project))
  for (const path of await markdownUnder($, autoFolder)) if (!path.endsWith('/MEMORY.md')) await add(path, 'project', 'auto')
  // Auto memory's folder is long and named once, under its index: each file is shown from it.
  const shortened = files.map(file =>
    file.path.startsWith(`${autoFolder}/`) ? { ...file, display: `memory/${file.path.slice(autoFolder.length + 1)}` } : file,
  )
  await update($, memory, () => shortened)
}

// ── notes ─────────────────────────────────────────────────────────────────

/**
 * Changes the project's notes as their file holds them now, each numbered,
 * and shows the result. Never a list read earlier: that would write over a
 * note another session added or a press made since. Outside a repository
 * the notes live in the session alone.
 */
async function changeNotes($: EngineInterface, change: (list: Note[]) => Note[]): Promise<Note[]> {
  if (!lists) return update($, notes, list => change(numbered(list)))
  const list = await changeList<Note>(listFiles($), lists.notes, stored => change(numbered(stored)))
  await update($, notes, () => list)

  return list
}

async function addNote($: EngineInterface, text: string): Promise<string | void> {
  const clean = text.trim()
  if (!clean) return
  const at = await $.clock.now()
  await changeNotes($, list => [{ id: crypto.randomUUID(), text: clean, isDone: false, at, seq: nextSeq(list) }, ...list])

  return m.noteAdded(clean.length > 40 ? `${clean.slice(0, 39)}…` : clean)
}

/** Marks a note done, or open again: what the person saw it as, turned over. */
function setNoteDone($: EngineInterface, id: string, isDone: boolean): Promise<Note[]> {
  return changeNotes($, list => list.map(one => (one.id === id ? { ...one, isDone, isSuggestedDone: false } : one)))
}

/** Takes the project's notes as their file holds them, so a note another session wrote shows here. */
async function reloadNotes($: EngineInterface): Promise<void> {
  if (!lists) return
  const stored = await readList<Note>(listFiles($), lists.notes)
  const list = numbered(stored)
  // A note made before numbering gets its number once, in the file too, so it keeps it.
  if (JSON.stringify(list) !== JSON.stringify(stored)) await changeNotes($, current => current)
  else if (JSON.stringify(list) !== JSON.stringify(await read($, notes))) await update($, notes, () => list)
}

/** Marks the notes an answer says it finished, for the person to confirm. */
async function suggestDone($: EngineInterface, answer: string): Promise<void> {
  const marked = new Set(doneMarks(answer))
  if (marked.size === 0) return
  const isMarked = (note: Note) => !note.isDone && note.seq !== undefined && marked.has(note.seq)
  if (!(await read($, notes)).some(isMarked)) return
  await changeNotes($, list => list.map(note => (isMarked(note) ? { ...note, isSuggestedDone: true } : note)))
}

/** Whether a refresh of the visible tab is running: a second one asked meanwhile is dropped. */
let isLiveRefreshing = false
/** The pending refresh after a burst of file-changing tool calls. */
let liveRefreshTimer: { cancel: () => void } | undefined

/**
 * Brings the tab on screen up to date with the working tree and the notes'
 * file, when the pane is open. The Memory tab is read when it opens and when
 * Refresh is pressed: reading every memory file and listing the repository's
 * on each beat costs a large repository more than its few changes are worth.
 */
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
  // Opened to show a tab: a dialog left from a draw the engine refused, or from a closed pane, goes.
  if ((await read($, dialog)) !== null) {
    await update($, dialog, () => null)
    await update($, focused, () => null)
  }
  // Opened only by what the person did, the pane takes the keyboard: with no mouse nothing else hands it the keys.
  await $.ui.open({ id: PANE, title: TAB_LABEL, rows: 30, focus: true, closeOnEscape: true })
  if (!(await read($, paneOpen))) await update($, paneOpen, () => true)
  const active = await read($, tab)
  if (active === 'checkpoints') await refreshSince($)
  if (active === 'diff') await refreshDiff($)
  if (active === 'notes') await reloadNotes($)
  if (active === 'memory') await loadMemory($)
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

/** The files of a working tree's lists, under its repository's git folder; undefined when git cannot say where that is. */
async function listPathsOf($: EngineInterface, top: string): Promise<{ notes: string; checkpoints: string } | undefined> {
  const common = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top })
  if (common.exitCode !== 0 || common.stdout.trim() === '') return undefined

  return listPaths(common.stdout.trim().replaceAll('\\', '/'), top)
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
  lists = root ? await listPathsOf($, root) : undefined
  if (root && lists) {
    // Lists the plugin store held, from before they were files, move to their files once.
    for (const [key, path] of [
      [notesKey(root), lists.notes],
      [checkpointsKey(root), lists.checkpoints],
    ] as const) {
      const stored = await $.store.get(key)
      if (stored === undefined) continue
      await adoptStored(listFiles($), path, stored)
      await $.store.delete(key)
    }
    await reloadNotes($)
    const kept = await readList<CheckpointRow>(listFiles($), lists.checkpoints)
    await update($, checkpoints, () => kept)
    // A reload runs this again in the same session: its start is the checkpoint already taken, never a new one.
    const started = (await read($, checkpoints)).find(row => row.kind === 'session' && row.ref.includes(`/${sessionId}/`))
    try {
      baseline = started ?? (await takeCheckpoint($, 'session', m.checkpointKind.session)) ?? (await read($, checkpoints))[0]
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
 * to stop, worktree to remove or file to put back (`file`, by path); or, for
 * `base` and `target`, which checkpoints the Diff tab compares (`ref` unused).
 */
type Dialog = { kind: 'restore' | 'note' | 'stop' | 'worktree' | 'base' | 'target' | 'file' | 'name' | 'memoryScope' | 'memoryRead' | 'diff'; ref: string }

/** The checkpoints the Diff tab's base is picked from: the newest shown, and the session's own start. */
async function baseCandidates($: EngineInterface) {
  const rows = await read($, checkpoints)
  const start = baseline ?? rows.find(row => row.kind === 'session')
  const listed = rows.slice(0, CHECKPOINTS_SHOWN)
  if (start && !listed.some(row => row.commit === start.commit)) listed.push(start)

  return listed.map(row => ({
    commit: row.commit,
    label: checkpointLabel(row, m),
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
  if (asked.kind === 'base' || asked.kind === 'target' || asked.kind === 'name' || asked.kind === 'memoryScope' || asked.kind === 'memoryRead' || asked.kind === 'diff') return null
  const now = await $.clock.now()
  if (asked.kind === 'restore') {
    const row = (await read($, checkpoints)).find(one => one.ref === asked.ref)
    if (!row) return null
    const since = row.since

    return {
      title: m.restoreTitle(clockOf(row.at, now, locale)),
      lines: [
        { text: m.restoreFrom(checkpointLabel(row, m)) },
        ...(since && since.files > 0 ? [{ text: m.restoreUndoes(m.filesCount(since.files), since.added, since.removed), tone: 'danger' as const }] : []),
        { text: m.restoreUndoHint, tone: 'muted' as const },
      ],
      confirm: m.restoreConfirm,
      run: () => restore($, row),
    }
  }
  if (asked.kind === 'file') {
    const view = await read($, diff)
    const file = view && !view.target ? view.files.find(one => one.path === asked.ref) : undefined
    if (!view || !file) return null

    return {
      title: m.fileRestoreTitle(file.path, clockOf(view.base.at, now, locale)),
      lines: [
        { text: m.restoreFrom(view.base.label) },
        file.status === 'added'
          ? { text: m.fileRestoreAdded, tone: 'danger' as const }
          : file.status === 'renamed' && file.from
            ? { text: m.fileRestoreRenamed(file.from), tone: 'danger' as const }
            : { text: m.fileRestoreUndoes(file.added ?? 0, file.removed ?? 0), tone: 'danger' as const },
        { text: m.restoreUndoHint, tone: 'muted' as const },
      ],
      confirm: m.fileRestoreConfirm,
      run: () => restoreOneFile($, file.path),
    }
  }
  if (asked.kind === 'note') {
    const note = (await read($, notes)).find(one => one.id === asked.ref)
    if (!note) return null

    return {
      title: m.noteDeleteTitle,
      lines: [{ text: `“${note.text}”` }, { text: m.cannotUndo, tone: 'muted' }],
      confirm: m.deleteConfirm,
      run: async () => {
        await changeNotes($, list => list.filter(one => one.id !== note.id))
      },
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
    // A later published release turns the header's date into Update Required: asked now and every few hours.
    void followLatestRelease($).catch((error: unknown) => debug($, error))
    $.clock.every(RELEASE_CHECK_MS, () => {
      void followLatestRelease($).catch((error: unknown) => debug($, error))
    })
    // Windows has USERPROFILE and backslashes; git prints its paths with forward slashes.
    home = ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')))?.replaceAll('\\', '/')
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    // A pane an earlier build opened and this one no longer draws (the old dialog pane) would
    // stay on screen empty, past the workspace's own Close: close every pane but the workspace.
    for (const pane of await $.ui.panes()) {
      if (pane.id !== PANE) await $.ui.close({ id: pane.id }).catch((error: unknown) => debug($, error))
    }
    await adoptSession($)
    // Read at once, not at the first poll: a row a reload left in an earlier shape is replaced before it is pressed.
    await refreshAgents($).catch((error: unknown) => debug($, error))
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

  // The session's snapshot indexes go with it; checkpoints are commits and stay. A /clear goes
  // on in this process under a new session id with no session.start: the new session is taken
  // up here, once the old one has ended.
  on('session.end', async ($, e, next) => {
    const indexes = [snapshotIndex, ...(await otherSnapshotIndexes($))].filter(path => path !== '')
    if (indexes.length > 0) {
      await $.process.run(removeArgv(indexes, isWindows), { timeoutMs: 5000 }).catch((error: unknown) => debug($, error))
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
    // A subagent's or a teammate's call is what it is doing now.
    if (e.agentId) {
      void recordActivity($, e.agentId, { text: toolSummary(String(e.tool), e as unknown as Record<string, unknown>), isAnswer: false }).catch(
        (error: unknown) => debug($, error),
      )
    }
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
    // An agent's turn ends with its answer: its first line is what it did last, and the whole is
    // kept for the finished group. Its status is read again at once, so the row never shows
    // `running` beside an answer.
    if (e.agentId) {
      const agentId = e.agentId
      const answer = e.answer.trim()
      void (async () => {
        if (answer !== '') {
          await recordActivity($, agentId, { text: answer.split('\n')[0] ?? '', isAnswer: true })
          await update($, answers, value => ({ ...value, [agentId]: answer }))
        }
        await refreshAgents($)
      })().catch((error: unknown) => debug($, error))
    } else if (isNotesInContext) {
      // The main loop's answer may say it finished a note sent with the prompt.
      void suggestDone($, e.answer).catch((error: unknown) => debug($, error))
    }
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
    const block = notesContext(projectName(), open)

    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // `commands/workspace.md` of the plugin `sc` declares /sc:workspace; this hook answers it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    // Off fullscreen no click reaches a pane: the first pane a command opens says how to press without one.
    const hint = e.presentation?.isFullscreen === false && !isClickHintShown ? ` ${m.clickHint}` : ''
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    try {
      if (first === '') {
        await openPane($)

        return { text: opened(m.paneOpened(tabLabel(await read($, tab))) + hint) }
      }
      // `toggle [tab]`: closes the pane when it is open, else opens it, on `tab` when one is named.
      if (first === 'toggle') {
        const named = rest[0] && (TABS as string[]).includes(rest[0]) ? (rest[0] as Tab) : undefined
        const text = await togglePane($, named)

        return { text: text === m.paneClosed ? text : opened(text + hint) }
      }
      if (first === 'notes' && rest.length > 0) {
        const added = await addNote($, rest.join(' '))
        await openPane($, 'notes')

        return { text: opened((added ?? m.paneOpened(tabLabel('notes'))) + hint) }
      }
      // `name <text>`: names the newest checkpoint and pins it, where the surface has no field for the dialog.
      if (first === 'name' && rest.length > 0) {
        const newest = (await read($, checkpoints))[0]
        if (!newest) return { text: m.checkpointsEmpty }
        const named = await nameCheckpoint($, newest.ref, rest.join(' '))
        await openPane($, 'checkpoints')

        return { text: opened((named ?? m.paneOpened(tabLabel('checkpoints'))) + hint) }
      }
      if ((TABS as string[]).includes(first)) {
        await openPane($, first as Tab)

        return { text: opened(m.paneOpened(tabLabel(first as Tab)) + hint) }
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
    // A reader page wraps at the pane's width, kept from every draw so a search hit opens at the right page.
    readerRoom = { rows: READER_PAGE_ROWS, columns: bodyColumns - 6 }
    // With another mod's pane open beside it, the engine draws a tab row above the header.
    const isUnderTabs = isBesideOtherPanes('sc-workspace', {
      'sc-accounts': (await $.state.get({ plugin: 'sc-accounts', key: 'paneOpen' })).value === true,
      'sc-workspace': (await $.state.get({ plugin: 'sc-workspace', key: 'paneOpen' })).value === true,
      'sc-toolbox': (await $.state.get({ plugin: 'sc-toolbox', key: 'paneOpen' })).value === true,
    })
    const header = {
      brand: paneTitle(MOD_NAME),
      ...releaseHeader(release, m.release, m.updateRequired),
      isUnderTabs,
      columns: bodyColumns,
      exit: { label: `✕ ${m.closeButton}`, onPress: () => void closePane($).catch((error: unknown) => $.ui.toast(message(error))) },
      backLabel: m.backButton,
    }
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
    if (asked?.kind === 'target') {
      const now = await $.clock.now()
      const view = await read($, diff)
      if (view) {
        const candidates = (await baseCandidates($)).map(({ since: _since, ...point }) => point)

        return ChoiceDialog(
          ui,
          bodyColumns,
          header,
          m.targetTitle,
          targetChoices(candidates, view, now, locale, m).map(choice => ({
            ...choice,
            onPress: () => {
              void (async () => {
                await dismiss()
                if (!choice.isCurrent) await refreshDiff($, undefined, choice.target)
              })().catch((error: unknown) => $.ui.toast(message(error)))
            },
          })),
          { label: m.cancel, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
          await read($, focused),
        )
      }
    }
    if (asked?.kind === 'diff') {
      const view = await read($, diff)
      const files = view?.files ?? []
      const at = files.findIndex(one => one.path === asked.ref)
      const file = files[at]
      const selected = view?.selected?.path === asked.ref ? view.selected : undefined
      if (view && file && selected) {
        // Whole hunks on every page, each under a header of its own, so every page draws as a diff.
        const pages = diffPages(selected.text, DIFF_PAGE_LINES)
        const count = pages.length
        const index = Math.min(Math.max(0, await read($, diffPage)), count - 1)
        const turn = (step: number) => () => {
          void update($, diffPage, () => index + step).catch((error: unknown) => debug($, error))
        }
        const open = (path: string) => () => void openFile($, path).catch((error: unknown) => $.ui.toast(message(error)))
        const previousFile = files[at - 1]
        const nextFile = files[at + 1]
        const counts = file.added === null ? m.binary : `+${file.added} −${file.removed ?? 0}`
        const omitted = selected.omitted > 0 && index === count - 1 ? ` · ${m.linesOmitted(selected.omitted)}` : ''

        return CodeDialog(
          ui,
          bodyColumns,
          header,
          file.path,
          `${counts} · ${m.diffDialogSince(view.base.label)}${omitted}`,
          { source: pages[index] ?? '', format: 'diff', path: file.path, empty: m.binary },
          { index, count, label: m.readerPage(index + 1, count) },
          {
            previous: { label: m.readerPrevious, onPress: turn(-1) },
            next: { label: m.readerNext, onPress: turn(1) },
            extra: [
              ...(previousFile ? [{ key: 'diff-previous-file', label: m.diffPreviousFile, onPress: open(previousFile.path) }] : []),
              ...(nextFile ? [{ key: 'diff-next-file', label: m.diffNextFile, onPress: open(nextFile.path) }] : []),
              // Only the working tree can be written back: a file compared between two checkpoints, or another worktree's, has no restore.
              ...(!view.target && !view.worktree ? [{ key: 'diff-file-restore', label: m.diffRestoreFile, onPress: () => void update($, dialog, () => ({ kind: 'file', ref: file.path })).catch((error: unknown) => debug($, error)) }] : []),
            ],
            close: { label: m.closeButton, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
          },
          await read($, focused),
        )
      }
    }
    if (asked?.kind === 'memoryRead') {
      const file = (await read($, memory))?.find(one => one.path === asked.ref)
      const text = memoryTexts.get(asked.ref)
      if (file && text !== undefined) {
        const pages = markdownPages(text, readerRoom)
        const index = Math.min(Math.max(0, await read($, memoryPage)), pages.length - 1)
        const front = frontmatterOf(text)
        const turn = (step: number) => () => {
          void update($, memoryPage, () => index + step).catch((error: unknown) => debug($, error))
        }
        // An auto-memory file leads with its name and description; its frontmatter is not drawn.
        const lead = front.name ? `**${front.name}**${front.description ? `: ${front.description}` : ''}\n\n` : ''

        return ReaderDialog(
          ui,
          bodyColumns,
          header,
          file.display,
          m.readerSubtitle(file.path.replace(home ?? '\u0000', '~'), m.memoryKind[file.kind], m.memoryLines(file.lines)),
          // Lines wrapped in the file read as the paragraphs they are.
          reflow(index === 0 ? `${lead}${pages[index]?.text ?? ''}` : (pages[index]?.text ?? '')),
          { index, count: pages.length, label: m.readerPage(index + 1, pages.length) },
          {
            previous: { label: m.readerPrevious, onPress: turn(-1) },
            next: { label: m.readerNext, onPress: turn(1) },
            close: { label: m.closeButton, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
          },
          await read($, focused),
        )
      }
    }
    if (asked?.kind === 'memoryScope') {
      const current = await read($, memoryScope)
      const scopes = ['all', 'global', 'project'] as const

      return ChoiceDialog(
        ui,
        bodyColumns,
        header,
        m.memoryScopeTitle,
        scopes.map(scope => ({
          key: `memory-scope-${scope}`,
          label: m.memoryScope[scope],
          isCurrent: scope === current,
          onPress: () => {
            void (async () => {
              await dismiss()
              await update($, memoryScope, () => scope)
            })().catch((error: unknown) => $.ui.toast(message(error)))
          },
        })),
        { label: m.cancel, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
        await read($, focused),
      )
    }
    if (asked?.kind === 'name') {
      const row = (await read($, checkpoints)).find(one => one.ref === asked.ref)
      if (row) {
        return InputDialog(
          ui,
          bodyColumns,
          header,
          m.nameTitle(clockOf(row.at, await $.clock.now(), locale)),
          [{ text: m.restoreFrom(checkpointLabel(row, m)) }, { text: m.nameHint, tone: 'muted' }],
          {
            key: 'checkpoint-name',
            placeholder: m.namePlaceholder,
            ...(row.name ? { value: row.name } : {}),
            submitLabel: m.nameSave,
            hasField: e.surface !== 'mobile',
            noInput: m.nameNoInput,
            onSubmit: value => {
              void (async () => {
                await dismiss()
                const text = await nameCheckpoint($, row.ref, value)
                if (text) $.ui.toast(text)
              })().catch((error: unknown) => $.ui.toast(message(error)))
            },
          },
          { label: m.cancel, onPress: () => void dismiss().catch((error: unknown) => debug($, error)) },
          await read($, focused),
        )
      }
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
    const ask = (kind: Dialog['kind'], ref: string, then?: () => Promise<void>) =>
      act(async () => {
        await update($, dialog, () => ({ kind, ref }))
        // The dialog is drawn in this pane, which takes the keys so Enter answers it; Esc
        // asks the pane to close, which the ui.close hook turns into Cancel.
        await $.ui.open({ id: PANE, title: TAB_LABEL, focus: true, closeOnEscape: true })
        await then?.()
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
      { key: 'memory', label: m.tabMemory, hotkey: '5' },
    ]
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
        { checkpoints: checkpointRows, repoError: error, now, locale, m, bodyColumns, limit: CHECKPOINTS_SHOWN, isEveryPrompt: isCheckpointEveryPrompt },
        {
          restore: row => ask('restore', row.ref),
          compare: row =>
            act(async () => {
              await update($, tab, () => 'diff')
              await update($, diff, view => (view?.worktree ? null : view))
              await refreshDiff($, { commit: row.commit, label: checkpointLabel(row, m), at: row.at, isSessionStart: row.kind === 'session' }, null)
            })(),
          compareTurn: (row, next) =>
            act(async () => {
              await update($, tab, () => 'diff')
              await update($, diff, view => (view?.worktree ? null : view))
              await refreshDiff(
                $,
                { commit: row.commit, label: checkpointLabel(row, m), at: row.at, isSessionStart: row.kind === 'session' },
                { commit: next.commit, label: checkpointLabel(next, m), at: next.at, isSessionStart: next.kind === 'session' },
              )
            })(),
          name: row => ask('name', row.ref),
          togglePin: row => act(() => setPin($, row.ref, row.isPinned !== true))(),
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
      ]
    } else if (active === 'notes') {
      body = NotesTab(
        ui,
        { notes: noteRows, project: projectName(), isSentWithPrompts: isNotesInContext, hasField: e.surface !== 'mobile', m },
        {
          add: text => act(() => addNote($, text))(),
          // What the person saw, turned over, applied to the notes as they are now: a second press
          // before the redraw, or a note another session added, is never written over.
          toggle: note => act(() => setNoteDone($, note.id, !note.isDone).then(() => undefined))(),
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
          onPress: act(() => changeNotes($, list => list.filter(note => !note.isDone)).then(() => undefined)),
        },
      ]
    } else if (active === 'memory') {
      const files = await read($, memory)
      const scope = await read($, memoryScope)
      const query = await read($, memoryQuery)
      const searched = (files ?? []).filter(file => scope === 'all' || file.scope === scope)
      body = MemoryTab(
        ui,
        {
          files,
          scope,
          query,
          hits: searchMemory(
            searched.map(file => ({ path: file.path, text: memoryTexts.get(file.path) ?? '' })),
            query,
          ),
          open: await read($, memoryOpen),
          hasField: e.surface !== 'mobile',
          m,
          bodyColumns,
        },
        {
          chooseScope: () => ask('memoryScope', ''),
          search: value => act(() => update($, memoryQuery, () => value).then(() => undefined))(),
          toggle: file => act(() => update($, memoryOpen, open => (open === file.path ? null : file.path)).then(() => undefined))(),
          read: (file, line) =>
            act(async () => {
              const text = memoryTexts.get(file.path) ?? ''
              await update($, memoryPage, () => (line === undefined ? 0 : pageOfLine(markdownPages(text, readerRoom), line)))
              await update($, dialog, () => ({ kind: 'memoryRead', ref: file.path }))
              await $.ui.open({ id: PANE, title: TAB_LABEL, focus: true, closeOnEscape: true, rows: READER_PANE_ROWS })
            })(),
          insert: file =>
            act(async () => {
              await $.prompt.fill({ text: `@${file.path} `, mode: 'insert' })

              return m.memoryInserted(file.display)
            })(),
        },
      )
      tiles = [refreshTile(() => loadMemory($))]
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
          // The dialog shows what changed since each checkpoint, counted here when it opens:
          // nothing else counts them outside the Checkpoints tab.
          chooseBase: () => ask('base', '', () => refreshSince($)),
          chooseTarget: () => ask('target', ''),
          closeWorktree: () =>
            act(async () => {
              await update($, diff, () => null)
              await refreshDiff($)
            })(),
        },
      )
      const draft: Tile = {
        key: 'draft-commit',
        label: m.draftCommit,
        onPress: act(async () => {
          const view = await read($, diff)
          if (!view || view.files.length === 0) return m.diffEmpty
          // Put in at the cursor, so what the person was typing stays.
          await $.prompt.fill({ text: commitPrompt(view, now, locale, m), mode: 'insert' })

          return m.draftCommitFilled
        }),
      }
      tiles = diffView && diffView.files.length > 0 ? [refreshTile(() => refreshDiff($)), draft] : [refreshTile(() => refreshDiff($))]
    } else {
      body = AgentsTab(
        ui,
        {
          agents: agentRows,
          activity: await read($, activity),
          finished: await read($, finished),
          expandedAgent: await read($, expandedAgent),
          worktrees: await read($, worktrees), repoError: error, root: root ?? '', home, now, m },
        {
          stop: agent => ask('stop', agent.id),
          removeWorktree: row => ask('worktree', row.path),
          toggleAnswer: agent => act(() => update($, expandedAgent, open => (open === agent.id ? null : agent.id)).then(() => undefined))(),
          openWorktree: row => act(() => openWorktreeDiff($, row))(),
        },
      )
      tiles = [refreshTile(async () => {
        await Promise.all([refreshAgents($), refreshWorktrees($)])
      })]
    }

    return (
      <Box flexDirection="column">
        {Header(ui, header)}
        {TabBar(ui, tabs, active, select)}
        <Box key={`body-${active}`} flexDirection="column" marginTop={1}>
          {body}
        </Box>
        {Tiles(ui, bodyColumns, tiles)}
      </Box>
    )
  })
}
