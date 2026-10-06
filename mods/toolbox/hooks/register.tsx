import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DetectedTask, RunStatus, Tab, Tool, ToolKind, ToolParam } from '../types'
import { BUILD_FILES, detectTasks, MARKER_FILES, parseGradleTaskList, pnpmWorkspaceGlobs, unreadableFiles, workspaceGlobs } from './detect'
import { messagesFor, resolveLocale } from './i18n'
import type { Locale, Messages } from './i18n'
import { LOG_FILE_BYTES, LogBuffer, newestPart, pathSuggestions, progressOf, splitTyped } from './paths'
import { isBesideOtherPanes } from './shared/panes'
import { Dialog, FormDialog, Header, LogDialog, paneTitle, TabBar, Tiles } from './shared/kit'
import type { FormField, Tile } from './shared/kit'
import { releaseDateOf } from './shared/locale'
import {
  applyToolChange,
  askedParams,
  CONFIRMED_COMMANDS,
  DEFAULT_IGNORE,
  fill,
  paramNames,
  parseTools,
  settleRuns,
  summarize,
  startingValues,
  TOOLBOX_DIR,
  TOOLS_FILE,
  valuesProblem,
  workingFolder,
} from './tools'
import type { ToolChange } from './tools'
import { AddTab } from './views/add'
import { elapsed, QUICK_BEAT_MS, QuickView, runText, ToolsTab } from './views/tools'

const tab = atom({ plugin: 'sc-toolbox', key: 'tab' } as const, 'tools')
const tools = atom({ plugin: 'sc-toolbox', key: 'tools' } as const, [])
const toolsError = atom({ plugin: 'sc-toolbox', key: 'toolsError' } as const, null)
const runs = atom({ plugin: 'sc-toolbox', key: 'runs' } as const, {})
const summary = atom({ plugin: 'sc-toolbox', key: 'summary' } as const, { running: 0, waiting: 0, failed: 0 })
const seenAt = atom({ plugin: 'sc-toolbox', key: 'seenAt' } as const, 0)
const paneOpen = atom({ plugin: 'sc-toolbox', key: 'paneOpen' } as const, false)
const logTick = atom({ plugin: 'sc-toolbox', key: 'logTick' } as const, 0)
const detected = atom({ plugin: 'sc-toolbox', key: 'detected' } as const, null)
const unreadable = atom({ plugin: 'sc-toolbox', key: 'unreadable' } as const, [])
const commands = atom({ plugin: 'sc-toolbox', key: 'commands' } as const, null)
const addQuery = atom({ plugin: 'sc-toolbox', key: 'addQuery' } as const, '')
const dialog = atom({ plugin: 'sc-toolbox', key: 'dialog' } as const, null)
const draft = atom({ plugin: 'sc-toolbox', key: 'draft' } as const, {})
const suggest = atom({ plugin: 'sc-toolbox', key: 'suggest' } as const, null)
const follow = atom({ plugin: 'sc-toolbox', key: 'follow' } as const, true)
const focused = atom({ plugin: 'sc-toolbox', key: 'focused' } as const, null)

const PANE = 'sc-toolbox'
/** The accounts band's toolbox cell: a row of Buttons, `band-toolbox` then `band-toolbox-1` and on. */
const BAND_PLUGIN = 'sc-accounts'
const BAND_CELL = 'band-toolbox'
const COMMAND = 'sc:toolbox'
const TAB_LABEL = 'Toolbox'
/** The mod's name in the pane's header; a name, so it is never translated. */
const MOD_NAME = 'Toolbox'
/** How often the drawn log catches up with output while a run writes. */
const LOG_TICK_MS = 200
/** How often a running tool's log file is written. */
const LOG_WRITE_MS = 2000
/** The characters of output the log dialog draws at once: about a pane's worth, paged with Older and Newer. */
const LOG_WINDOW_CHARS = 6_000
/** Lines of the log drawn at once: what fits the pane with the dialog's title, status and buttons. */
const LOG_WINDOW_LINES = 22
/** How long a stopped run is given before it is killed outright. */
const STOP_GRACE_MS = 3000
/** Rows the pane takes in its settings view, and in the quick view. */
const SETTINGS_ROWS = 40
/** The quick view's rows: its header, the summary line, the box's border and the footer, and three for each row of two tiles. */
const quickRows = (count: number) => Math.min(SETTINGS_ROWS, 12 + Math.ceil(Math.max(1, count) / 2) * 3)
/** How often the quick view redraws while something runs or waits: the blink and the spinner's step. */
const BLINK_MS = QUICK_BEAT_MS
/**
 * The shell a tool's command runs under: job control on, so the command
 * gets a process group of its own and stopping it stops everything it
 * started; the group's number is written first, to stderr, for the stop.
 * `wait` keeps its own notice of a stopped job out of the command's output.
 */
const WRAP = 'set -m\nsh -c "$1" &\npid=$!\necho "__TOOLBOX_GROUP__ $pid" >&2\nwait $pid 2>/dev/null'
const GROUP_LINE = /^__TOOLBOX_GROUP__ (\d+)\n?/

/** What a dialog asks about: a tool's values, its log, its settings, its removal, or its restart. */
type Asked = { kind: 'ask' | 'log' | 'edit' | 'remove' | 'restart' | 'confirm'; id: string }

let locale: Locale = 'en'
let m: Messages = messagesFor(locale)
/** Whether this session has been told, once, that clicks need fullscreen mode. */
let isClickHintShown = false

/** Marks the click hint as shown when `text` carries it. */
function opened(text: string): string {
  if (text.includes(m.clickHint)) isClickHintShown = true

  return text
}
let release: { version?: string; date?: string } = {}
/** The project's root: where `.toolbox/` lives and commands run from. */
let root = ''
let isWindows = false
/** Each tool's output as it arrives, by tool id. */
const buffers = new Map<string, LogBuffer>()
/** Each running shell tool: its stream, to end it, and its process group, to stop what it started. */
const running = new Map<string, { stop: () => void; group?: number; stopped?: boolean }>()
/** Each tool's log file text as written last, so a write adds the new lines. */
const logFiles = new Map<string, string>()
/** How each run this module started last stood: a /clear empties the session's state while they go on. */
const held = new Map<string, RunStatus>()
/** How long after a /clear ends the old session the new one is taken up, once the engine has switched ids. */
const CLEAR_SETTLE_MS = 300
/** The line the log dialog ends at when it does not follow the newest. */
let logLast: number | undefined
let tickTimer: { cancel: () => void } | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function debug($: EngineInterface, error: unknown): void {
  $.ui.log(`sc-toolbox: ${message(error)}`, { to: 'debug' })
}

const toolboxPath = (name: string) => `${root}/${TOOLBOX_DIR}/${name}`

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

// ── tools ─────────────────────────────────────────────────────────────────

/** Reads `.toolbox/toolbox.json`; a project without one has no tools yet. */
async function loadTools($: EngineInterface): Promise<void> {
  const path = toolboxPath(TOOLS_FILE)
  try {
    if (!(await $.fs.exists(path))) {
      await update($, tools, () => [])
      await update($, toolsError, () => null)

      return
    }
    const { tools: list, problems } = parseTools(await $.fs.read(path))
    await update($, tools, () => list)
    await update($, toolsError, () => (problems.length > 0 ? m.toolsProblem(problems.join(', ')) : null))
  } catch (error) {
    await update($, toolsError, () => m.toolsUnreadable(message(error)))
  }
}

/**
 * Saves one change to `.toolbox/toolbox.json` as the file holds it now, then
 * reads the tools back: an edit made to the file since the pane read it (by
 * hand, or by Claude through the toolbox skill), an entry the pane cannot read
 * and a field it does not know all stay. Making the folder writes its
 * `.gitignore` too, keeping the logs and the remembered values out of git;
 * whether the tools are shared is the person's to decide there.
 */
async function changeTools($: EngineInterface, change: ToolChange): Promise<void> {
  await ensureIgnore($)
  const path = toolboxPath(TOOLS_FILE)
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
  await $.fs.write(path, applyToolChange(typeof text === 'string' ? text : undefined, change))
  await loadTools($)
}

/**
 * Writes `.toolbox/.gitignore` the first time the toolbox writes anything, so
 * its logs and remembered values stay out of git even when the person wrote
 * `toolbox.json` by hand; an existing one is the person's and is left alone.
 */
async function ensureIgnore($: EngineInterface): Promise<void> {
  const ignore = toolboxPath('.gitignore')
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, DEFAULT_IGNORE)
}

/** The values each tool was last run with, from `.toolbox/state.json`. */
async function rememberedValues($: EngineInterface): Promise<Record<string, Record<string, string>>> {
  try {
    const path = toolboxPath('state.json')
    if (!(await $.fs.exists(path))) return {}
    const data = JSON.parse(await $.fs.read(path)) as { values?: Record<string, Record<string, string>> }

    return data.values ?? {}
  } catch (error) {
    debug($, error)

    return {}
  }
}

async function remember($: EngineInterface, id: string, values: Record<string, string>): Promise<void> {
  await ensureIgnore($)
  const all = await rememberedValues($)
  await $.fs.write(toolboxPath('state.json'), `${JSON.stringify({ values: { ...all, [id]: values } }, null, 2)}\n`)
}

// ── detection ─────────────────────────────────────────────────────────────

/** Reads the project's build files, a workspace package's `package.json` too, and finds their tasks. */
async function detect($: EngineInterface): Promise<void> {
  const files: Record<string, string> = {}
  const exists = new Set<string>()
  const readIfThere = async (relative: string) => {
    const path = `${root}/${relative}`
    if (!(await $.fs.exists(path))) return
    exists.add(relative)
    if (BUILD_FILES.includes(relative) || relative.endsWith('package.json')) files[relative] = await $.fs.read(path)
  }
  for (const name of [...BUILD_FILES, ...MARKER_FILES]) await readIfThere(name)
  // A workspace's packages, by their folder globs (`packages/*` and `apps/web` alike), as package.json or pnpm names them.
  const globs = [...workspaceGlobs(files['package.json'] ?? '{}'), ...pnpmWorkspaceGlobs(files['pnpm-workspace.yaml'] ?? '')]
  for (const glob of [...new Set(globs)]) {
    const base = glob.replace(/\/\*+$/, '')
    if (glob.endsWith('*') && (await $.fs.exists(`${root}/${base}`))) {
      for (const entry of await $.fs.list(`${root}/${base}`)) if (entry.kind === 'dir') await readIfThere(`${base}/${entry.name}/package.json`)
    } else await readIfThere(`${glob}/package.json`)
  }
  await update($, detected, () => detectTasks(files, exists))
  await update($, unreadable, () => unreadableFiles(files))
}

/** Gradle's own whole task list, asked of Gradle once, added to what was found. */
async function loadGradleTasks($: EngineInterface): Promise<string | void> {
  const gradle = (await $.fs.exists(`${root}/gradlew`)) ? './gradlew' : 'gradle'
  const { exitCode, stdout, stderr } = await $.process.run([gradle, 'tasks', '--all', '-q'], { cwd: root, timeoutMs: 600_000 })
  if (exitCode !== 0) return stderr.trim().split('\n').pop() ?? `${gradle} exited ${exitCode}`
  const all = parseGradleTaskList(stdout, gradle)
  await update($, detected, current => [...(current ?? []).filter(task => task.source !== 'gradle'), ...all])
}

async function loadCommands($: EngineInterface): Promise<void> {
  // Claude Code's own commands first, then the user's, plugins' and MCP servers'; a source not
  // known here (skills) after them all.
  const order = ['builtin', 'user', 'plugin', 'mcp']
  const rank = (source: unknown) => {
    const at = order.indexOf(String(source))

    return at === -1 ? order.length : at
  }
  const list = [...(await $.command.list())].sort((a, b) => rank(a.source) - rank(b.source) || a.name.localeCompare(b.name))
  await update($, commands, () => list.map(command => ({ name: command.name, description: command.description, source: String(command.source) })))
}

// ── running ───────────────────────────────────────────────────────────────

/** Redraws the log dialog soon, once for a burst of output. */
function scheduleTick($: EngineInterface): void {
  if (tickTimer) return
  tickTimer = $.clock.after(LOG_TICK_MS, () => {
    tickTimer = undefined
    void update($, logTick, n => n + 1).catch((error: unknown) => debug($, error))
  })
}

/** Writes what a run added to its log file, keeping the file's newest part under the limit. */
async function writeLog($: EngineInterface, id: string): Promise<void> {
  const added = buffers.get(id)?.takePending() ?? ''
  if (added === '') return
  const kept = newestPart(`${logFiles.get(id) ?? ''}${added}`, LOG_FILE_BYTES)
  logFiles.set(id, kept)
  await ensureIgnore($)
  await $.fs.write(toolboxPath(`logs/${id}.log`), kept)
}

/** A past run's output from its log file, for a log opened with nothing held: after a reload, or in a new session. */
async function loadLog($: EngineInterface, id: string): Promise<void> {
  const path = toolboxPath(`logs/${id}.log`)
  if (!(await $.fs.exists(path))) return
  const text = await $.fs.read(path)
  const buffer = new LogBuffer()
  buffer.push(text)
  buffer.end()
  buffer.takePending()
  buffers.set(id, buffer)
  logFiles.set(id, text)
}

async function setRun($: EngineInterface, id: string, change: (current: RunStatus | undefined) => RunStatus): Promise<void> {
  const all = await update($, runs, current => ({ ...current, [id]: change(current[id]) }))
  const status = all[id]
  if (status) held.set(id, status)
  await refreshSummary($)
}

/** The counts the band shows, from the runs and when the toolbox was last looked at. */
async function refreshSummary($: EngineInterface): Promise<void> {
  const next = summarize(await read($, runs), await read($, seenAt))
  await update($, summary, current => (current.running === next.running && current.waiting === next.waiting && current.failed === next.failed ? current : next))
}

/** Runs a shell tool: its command under the wrapping shell, its output into the log as it comes. */
async function runShell($: EngineInterface, tool: Tool, command: string): Promise<void> {
  const cwd = workingFolder(root, tool.cwd)
  const buffer = new LogBuffer()
  buffers.set(tool.id, buffer)
  logFiles.set(tool.id, '')
  const startedAt = await $.clock.now()
  await setRun($, tool.id, () => ({ state: 'running', startedAt, command }))
  const argv = isWindows ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] : ['sh', '-c', WRAP, 'sh', command]
  const stream = $.process.spawn({ argv, cwd })
  // Ending the stream kills the child it started.
  const entry: { stop: () => void; group?: number; stopped?: boolean } = { stop: () => void stream.return(undefined as never) }
  running.set(tool.id, entry)
  const writer = $.clock.every(LOG_WRITE_MS, () => void writeLog($, tool.id).catch((error: unknown) => debug($, error)))
  let ending: { code: number | null; signal: string | null } = { code: null, signal: null }
  try {
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        if (next.value) ending = next.value
        break
      }
      let text = next.value.text
      // The wrapper's first word is the run's process group, for a stop.
      if (next.value.stream === 'stderr' && entry.group === undefined) {
        const group = GROUP_LINE.exec(text)
        if (group?.[1]) {
          entry.group = Number(group[1])
          text = text.slice(group[0].length)
        }
      }
      if (text !== '') {
        buffer.push(text)
        scheduleTick($)
      }
    }
  } catch (error) {
    buffer.push(`${message(error)}\n`)
    ending = { code: 1, signal: null }
  } finally {
    writer.cancel()
    buffer.end()
    running.delete(tool.id)
    await writeLog($, tool.id).catch((error: unknown) => debug($, error))
    const endedAt = await $.clock.now()
    const state = entry.stopped ? 'stopped' : ending.code === 0 ? 'done' : 'failed'
    await setRun($, tool.id, current => ({ ...(current ?? { startedAt, command }), state, endedAt, code: ending.code, signal: ending.signal }))
    scheduleTick($)
    // The end of a run is said even with the pane closed; a stop the person pressed needs no word.
    if (state === 'done') $.ui.toast(m.finishedToast(tool.name, elapsed(endedAt - startedAt)))
    if (state === 'failed') $.ui.toast(m.failedToast(tool.name, typeof ending.code === 'number' ? ` (${m.exitCode(ending.code)})` : ''))
  }
}

/**
 * Stops a running shell tool: its whole process group is sent TERM, then
 * KILL if it is still there after a grace period; the stream is ended either way.
 */
async function stopTool($: EngineInterface, tool: Tool): Promise<string> {
  const entry = running.get(tool.id)
  if (!entry) return m.stoppedToast(tool.name)
  entry.stopped = true
  if (entry.group !== undefined && !isWindows) {
    const group = entry.group
    await $.process.run(['kill', '-TERM', `-${group}`]).catch((error: unknown) => debug($, error))
    $.clock.after(STOP_GRACE_MS, () => {
      if (!running.has(tool.id)) return
      void $.process
        .run(['kill', '-KILL', `-${group}`])
        .catch((error: unknown) => debug($, error))
        .finally(() => entry.stop())
    })
  } else entry.stop()

  return m.stoppedToast(tool.name)
}

/** Runs a tool with its values: a shell command in the background, a slash command or a prompt through Claude Code. */
async function runTool($: EngineInterface, tool: Tool, values: Record<string, string>): Promise<string> {
  const command = fill(tool, values)
  if (askedParams(tool).length > 0) await remember($, tool.id, values)
  if (tool.kind === 'shell') {
    void runShell($, tool, command).catch((error: unknown) => debug($, error))

    return m.started(tool.name)
  }
  if (tool.kind === 'claude') {
    // Already waiting for the session to be idle: a second press would run it twice.
    if (waiting.has(tool.id)) return m.alreadyQueued(tool.name)
    const [name = '', ...rest] = command.trim().replace(/^\//, '').split(/\s+/)
    const startedAt = await $.clock.now()
    await setRun($, tool.id, () => ({ state: 'queued', startedAt, command }))
    waiting.add(tool.id)
    // A slash command runs once the session is idle: the row says it waits until then.
    void $.command
      .run({ command: name, args: rest.join(' ') })
      .then(async () => {
        waiting.delete(tool.id)
        const endedAt = await $.clock.now()
        await setRun($, tool.id, current => ({ ...(current ?? { startedAt, command }), state: 'done', endedAt }))
      })
      .catch(async (error: unknown) => {
        waiting.delete(tool.id)
        debug($, error)
        $.ui.toast(m.failedToast(tool.name, ''))
        const endedAt = await $.clock.now()
        await setRun($, tool.id, current => ({ ...(current ?? { startedAt, command }), state: 'failed', endedAt }))
      })

    return m.queuedToast(tool.name)
  }
  if (tool.submit) {
    await $.prompt.submit({ text: command })

    return m.sent
  }
  // Put in at the cursor, so what the person was typing stays.
  await $.prompt.fill({ text: command, mode: 'insert' })

  return m.filled
}

// ── pane ──────────────────────────────────────────────────────────────────

// Opened only by what the person did, the pane takes the keyboard: with no mouse nothing else hands it the keys.
async function openPane($: EngineInterface, next?: Tab | 'quick', focus = true): Promise<void> {
  if (next === 'quick') await update($, tab, () => 'tools')
  else if (next) await update($, tab, () => next)
  // Opened to show the tools: a dialog left from a draw the engine refused, or from a closed pane, goes.
  if ((await read($, dialog)) !== null) {
    await update($, dialog, () => null)
    await update($, suggest, () => null)
    await update($, focused, () => null)
  }
  quick = next === 'quick'
  // Opening the toolbox shows every failure, so the band stops counting them.
  const openedAt = await $.clock.now()
  await update($, seenAt, () => openedAt)
  await refreshSummary($)
  await loadTools($)
  const count = (await read($, tools)).length
  await $.ui.open({ id: PANE, title: TAB_LABEL, rows: quick ? quickRows(count) : SETTINGS_ROWS, ...(focus ? { focus: true, closeOnEscape: true } : {}) })
  await update($, paneOpen, () => true)
  // While the pane is open, something running or waiting redraws it on a beat, for the blink and the elapsed time.
  blinker ??= $.clock.every(BLINK_MS, () => {
    if (running.size > 0 || waiting.size > 0) void update($, logTick, n => n + 1).catch((error: unknown) => debug($, error))
  })
  // Read afresh each time the Add tab opens: a build file changed, or a plugin was added since.
  if (!quick && (await read($, tab)) === 'add') await Promise.all([detect($), loadCommands($)])
}

/** Whether the pane shows the quick tiles rather than the settings. */
let quick = false

/** The beat that redraws the open pane while a tool runs or waits; none while the pane is closed. */
let blinker: { cancel: () => void } | undefined
/** The Claude commands waiting for the session to be idle. */
const waiting = new Set<string>()

function stopBlinker(): void {
  blinker?.cancel()
  blinker = undefined
}

async function closePane($: EngineInterface): Promise<void> {
  stopBlinker()
  await $.ui.close({ id: PANE })
  await update($, paneOpen, () => false)
}

/** The fields of the add-or-edit dialog, from the draft: the tool's own, then a few for each `{{name}}` its command holds. */
function editFields(values: Record<string, string>, kind: ToolKind, set: (key: string, value: string) => Promise<void>): FormField[] {
  const field = (key: string, label: string, extra: Partial<FormField> = {}): FormField => ({ key, label, value: values[key] ?? '', onInput: value => set(key, value), ...extra })
  const fields: FormField[] = [field('name', m.fieldName), field('run', m.fieldRun[kind])]
  if (kind === 'shell') fields.push(field('cwd', m.fieldCwd, { placeholder: '.' }))
  fields.push(field('confirm', m.fieldConfirm, { options: [{ value: 'run', label: m.confirmRunNow }, { value: 'ask', label: m.confirmAskFirst }] }))
  if (kind === 'prompt') {
    fields.push(field('submit', m.fieldSubmit, { options: [{ value: 'fill', label: m.submitFill }, { value: 'send', label: m.submitSend }] }))
  }
  for (const name of paramNames(values.run ?? '')) {
    const type = values[`p:${name}:type`] ?? 'text'
    const mode = values[`p:${name}:mode`] ?? 'ask'
    fields.push(
      field(`p:${name}:type`, m.paramType(name), { options: [{ value: 'text', label: m.typeText }, { value: 'path', label: m.typePath }, { value: 'choice', label: m.typeChoice }] }),
      field(`p:${name}:mode`, m.paramMode(name), { options: [{ value: 'ask', label: m.modeAsk }, { value: 'fixed', label: m.modeFixed }] }),
      field(`p:${name}:value`, m.paramValue(name, mode)),
    )
    if (type === 'choice') fields.push(field(`p:${name}:choices`, m.paramChoices(name)))
    if (type === 'path') fields.push(field(`p:${name}:glob`, m.paramGlob(name), { placeholder: '*' }))
  }

  return fields
}

/** A tool's settings as the edit dialog's draft. */
function toDraft(tool: Pick<Tool, 'name' | 'kind' | 'run' | 'cwd' | 'params' | 'submit' | 'confirm'>): Record<string, string> {
  const values: Record<string, string> = { kind: tool.kind, name: tool.name, run: tool.run, cwd: tool.cwd ?? '', submit: tool.submit ? 'send' : 'fill', confirm: tool.confirm ? 'ask' : 'run' }
  for (const [name, param] of Object.entries(tool.params ?? {})) {
    values[`p:${name}:type`] = param.type
    values[`p:${name}:mode`] = param.mode
    values[`p:${name}:value`] = param.value ?? ''
    values[`p:${name}:choices`] = (param.choices ?? []).join(', ')
    values[`p:${name}:glob`] = param.glob ?? ''
  }

  return values
}

/** The edit dialog's draft as a tool. */
function fromDraft(id: string, values: Record<string, string>, group?: string): Tool {
  const kind = (values.kind as ToolKind) || 'shell'
  const params: Record<string, ToolParam> = {}
  for (const name of paramNames(values.run ?? '')) {
    const type = (values[`p:${name}:type`] as ToolParam['type']) || 'text'
    const choices = (values[`p:${name}:choices`] ?? '').split(',').map(one => one.trim()).filter(Boolean)
    params[name] = {
      type,
      mode: values[`p:${name}:mode`] === 'fixed' ? 'fixed' : 'ask',
      ...(values[`p:${name}:value`] ? { value: values[`p:${name}:value`] } : {}),
      ...(type === 'choice' && choices.length > 0 ? { choices } : {}),
      ...(type === 'path' && values[`p:${name}:glob`] ? { glob: values[`p:${name}:glob`] } : {}),
    }
  }

  return {
    id,
    name: (values.name ?? '').trim(),
    kind,
    run: (values.run ?? '').trim(),
    ...(kind === 'shell' && values.cwd && values.cwd !== '.' ? { cwd: values.cwd } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(kind === 'prompt' && values.submit === 'send' ? { submit: true } : {}),
    ...(values.confirm === 'ask' ? { confirm: true } : {}),
    ...(group ? { group } : {}),
  }
}

/**
 * Fills the state a session draws from: the project's tools, whether the
 * pane is open, and the runs. A reload leaves runs this load does not hold:
 * none stays marked running or waiting with nothing behind it. A /clear
 * leaves no runs in the state at all: those this module still holds are put
 * back as they stand.
 */
async function adoptSession($: EngineInterface): Promise<void> {
  root = (await $.session.root()).replaceAll('\\', '/')
  await loadTools($)
  const now = await $.clock.now()
  // The pane as the engine keeps it, open or not.
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  await update($, paneOpen, () => isOpen)
  const isHeld = (id: string) => running.has(id) || waiting.has(id)
  const going = Object.fromEntries([...held].filter(([id]) => isHeld(id)))
  await update($, runs, all => ({ ...going, ...settleRuns(all ?? {}, isHeld, now) }))
  await refreshSummary($)
}

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { language } = await $.settings.read()
    locale = resolveLocale(language, [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')])
    m = messagesFor(locale)
    release = await readRelease($)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    await adoptSession($)

    return next(e)
  })

  // A /clear goes on in this process under a new session id, with no session.start and none of
  // the session's state: the new session is taken up here, its tools and the runs still going.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_SETTLE_MS, () => {
        void adoptSession($).catch((error: unknown) => debug($, error))
      })
    }

    return result
  })

  // Esc (or the close mark) while a dialog asks closes the dialog and keeps the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, dialog)) !== null) {
      await update($, dialog, () => null)
      await update($, suggest, () => null)
      if (quick) await $.ui.open({ id: PANE, title: TAB_LABEL, rows: quickRows((await read($, tools)).length) })

      return { value: undefined }
    }
    if (e.id === PANE) {
      stopBlinker()
      await update($, paneOpen, () => false)
    }

    return next(e)
  })

  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE) await update($, focused, () => e.element ?? null)

    return result
  })

  // The accounts band's toolbox cell, pressed: the quick tiles open inside the person's press,
  // so the pane counts as asked for and is placed at any width; pressed again, they close.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== BAND_PLUGIN || e.component !== 'AbovePrompt' || !(e.element === BAND_CELL || e.element?.startsWith(`${BAND_CELL}-`))) return next(e)
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isShown && pane.isPlaced && quick) await closePane($)
    else {
      if (pane) await $.ui.close({ id: PANE })
      await openPane($, 'quick')
    }

    return { element: e.element }
  })

  // `commands/toolbox.md` of the plugin `sc` declares /sc:toolbox; this hook answers it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    // Off fullscreen no click reaches a pane: the first pane a command opens says how to press without one.
    const hint = e.presentation?.isFullscreen === false && !isClickHintShown ? ` ${m.clickHint}` : ''
    const [verb = ''] = e.args.trim().split(/\s+/)
    try {
      // A command opens the Add tab afresh, without a filter typed in an earlier visit.
      if (verb === 'add') await update($, addQuery, () => '')
      if (verb === 'add' || verb === 'tools') await openPane($, verb)
      else await openPane($, 'quick')

      return { text: opened((verb === 'add' ? m.openedAdd : verb === 'tools' ? m.openedSettings : m.openedQuick) + hint) }
    } catch (error) {
      return { text: message(error) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const bodyColumns = e.props.bodyColumns ?? 60
    const header = {
      brand: paneTitle(MOD_NAME),
      release: release.version ? m.release(release.version, release.date) : undefined,
      isUnderTabs: isBesideOtherPanes('sc-toolbox', {
      'sc-accounts': (await $.state.get({ plugin: 'sc-accounts', key: 'paneOpen' })).value === true,
      'sc-workspace': (await $.state.get({ plugin: 'sc-workspace', key: 'paneOpen' })).value === true,
      'sc-toolbox': (await $.state.get({ plugin: 'sc-toolbox', key: 'paneOpen' })).value === true,
    }),
      columns: bodyColumns,
      exit: { label: `✕ ${m.closeButton}`, onPress: () => void closePane($).catch((error: unknown) => $.ui.toast(message(error))) },
      backLabel: m.backButton,
    }
    const hasField = e.surface !== 'mobile'
    const act = (work: () => Promise<string | void>) => () => {
      void work()
        .then(text => text && $.ui.toast(text))
        .catch((error: unknown) => $.ui.toast(message(error)))
    }
    const dismiss = async () => {
      await update($, dialog, () => null)
      await update($, suggest, () => null)
      await update($, focused, () => null)
      // Back from a dialog, the quick view takes its own height again.
      if (quick) await $.ui.open({ id: PANE, title: TAB_LABEL, rows: quickRows((await read($, tools)).length) })
    }
    const openDialog = async (next: Asked, values: Record<string, string> = {}) => {
      await update($, draft, () => values)
      await update($, suggest, () => null)
      await update($, dialog, () => next)
      await $.ui.open({ id: PANE, title: TAB_LABEL, rows: SETTINGS_ROWS, focus: true, closeOnEscape: true })
    }
    const list = await read($, tools)
    const byId = (id: string) => list.find(tool => tool.id === id)
    // Running a tool: one that asks for values asks first, one already running asks to restart.
    const start = async (tool: Tool) => {
      if (tool.kind === 'shell' && running.has(tool.id)) return openDialog({ kind: 'restart', id: tool.id })
      const values = startingValues(tool, (await rememberedValues($))[tool.id] ?? {})
      // The values dialog is itself the question; a tool with none asks to confirm when set to.
      if (askedParams(tool).length > 0) return openDialog({ kind: 'ask', id: tool.id }, values)
      if (tool.confirm) return openDialog({ kind: 'confirm', id: tool.id }, values)

      return runTool($, tool, values)
    }
    const asked = await read($, dialog)
    const values = await read($, draft)
    // Settles once the value is kept, so Enter in a field submits what was typed.
    const setDraft = (key: string, value: string): Promise<void> =>
      update($, draft, current => ({ ...current, [key]: value }))
        .then(() => undefined)
        .catch((error: unknown) => debug($, error))

    if (asked?.kind === 'ask' && byId(asked.id)) {
      const tool = byId(asked.id) as Tool
      const offered = await read($, suggest)
      const fields: FormField[] = askedParams(tool).map(name => {
        const param = tool.params?.[name]
        const onInput = (value: string): Promise<void> => {
          const kept = setDraft(name, value)
          // A path is offered as it is typed: the folder typed into is listed.
          if (param?.type !== 'path') return kept
          void (async () => {
            const { folder } = splitTyped(value)
            const path = folder === '' ? root : `${root}/${folder}`
            const entries = (await $.fs.exists(path)) ? await $.fs.list(path) : []
            await update($, suggest, () => ({ field: name, items: pathSuggestions(value, entries, { pathKind: param.pathKind, glob: param.glob }) }))
          })().catch((error: unknown) => debug($, error))

          return kept
        }

        return {
          key: name,
          label: name,
          value: values[name] ?? '',
          ...(param?.type === 'choice' && param.choices ? { options: param.choices.map(choice => ({ value: choice, label: choice })) } : {}),
          ...(offered?.field === name ? { suggestions: offered.items } : {}),
          onInput,
          onPick: onInput,
        }
      })

      return FormDialog(
        ui,
        bodyColumns,
        header,
        m.askTitle(tool.name),
        // The command as it will run, filled with what is typed so far.
        [{ text: m.askPreview(fill(tool, { ...startingValues(tool), ...values })), tone: 'muted' }],
        fields,
        {
          submit: {
            label: m.runButton,
            onPress: act(async () => {
              const current = await read($, draft)
              const wrong = valuesProblem(tool, current)
              if (wrong) return m.notChoice(wrong)
              await dismiss()

              return runTool($, tool, current)
            }),
          },
          cancel: { label: m.cancel, onPress: act(dismiss) },
        },
        { hasField, noInput: m.noInput },
        await read($, focused),
      )
    }

    if (asked?.kind === 'log' && byId(asked.id)) {
      const tool = byId(asked.id) as Tool
      // Reading the tick redraws the dialog as output arrives.
      await read($, logTick)
      const run = (await read($, runs))[tool.id]
      const isFollowing = await read($, follow)
      const buffer = buffers.get(tool.id) ?? new LogBuffer()
      const window = buffer.window(LOG_WINDOW_CHARS, isFollowing ? undefined : logLast, LOG_WINDOW_LINES)
      const now = await $.clock.now()
      const tone = run?.state === 'failed' ? 'danger' : run?.state === 'running' ? 'ok' : undefined
      const tile = (key: string, label: string, onPress: () => void): Tile => ({ key, label, onPress })

      return LogDialog(
        ui,
        bodyColumns,
        header,
        m.logTitle(tool.name),
        { text: run ? m.logStatus(runText(run, now, m), run.command) : buffer.lines.length > 0 ? m.logFromFile : m.logNoRun, ...(tone ? { tone } : {}) },
        { text: window.text, firstLine: window.first + 1, empty: m.logEmpty },
        {
          ...(window.first > 0
            ? { older: tile('log-older', m.logOlder, () => void (async () => {
                logLast = window.first
                await update($, follow, () => false)
              })()) }
            : {}),
          ...(!isFollowing && window.last < buffer.lines.length
            ? { newer: tile('log-newer', m.logNewer, () => void (async () => {
                logLast = Math.min(buffer.lines.length, window.last + (window.last - window.first))
                await update($, logTick, n => n + 1)
              })()) }
            : {}),
          follow: { key: 'log-follow', label: isFollowing ? m.logFollowing : m.logFollow, isMain: isFollowing, onPress: () => void update($, follow, isOn => !isOn) },
          ...(run?.state === 'running'
            ? { stop: tile('log-stop', m.stopButton, act(() => stopTool($, tool))) }
            : {
                again: tile('log-again', m.againButton, act(async () => {
                  await dismiss()

                  return start(tool)
                })),
              }),
          close: { key: 'dialog-cancel', label: m.closeButton, isDismiss: true, onPress: act(dismiss) },
        },
        await read($, focused),
      )
    }

    if (asked?.kind === 'edit') {
      const existing = byId(asked.id)
      const kind = (values.kind as ToolKind) || existing?.kind || 'shell'
      // The parameters' settings change with the command, so the fields follow the draft.
      return FormDialog(
        ui,
        bodyColumns,
        header,
        existing ? m.editTitle(existing.name) : m.newTitle,
        [],
        editFields(values, kind, setDraft),
        {
          submit: {
            label: m.save,
            onPress: act(async () => {
              const current = await read($, draft)
              const tool = fromDraft(existing?.id ?? '', { ...current, kind }, existing?.group ?? current.group)
              if (tool.name === '' || tool.run === '') return m.nameMissing
              // A new tool takes an id no tool in the file holds as it is now.
              const { id: _unsaved, ...added } = tool
              await changeTools($, existing ? { put: tool } : { add: added })
              await dismiss()

              return existing ? m.saved(tool.name) : m.added(tool.name)
            }),
          },
          cancel: { label: m.cancel, onPress: act(dismiss) },
        },
        { hasField, noInput: m.noInput },
        await read($, focused),
      )
    }

    if (asked?.kind === 'confirm' && byId(asked.id)) {
      const tool = byId(asked.id) as Tool

      return Dialog(
        ui,
        bodyColumns,
        header,
        m.confirmTitle(tool.name),
        [{ text: fill(tool, values) }, { text: m.confirmHint, tone: 'muted' }],
        {
          label: m.runButton,
          onPress: act(async () => {
            await dismiss()

            return runTool($, tool, values)
          }),
        },
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
      )
    }

    if ((asked?.kind === 'remove' || asked?.kind === 'restart') && byId(asked.id)) {
      const tool = byId(asked.id) as Tool
      const isRemove = asked.kind === 'remove'

      return Dialog(
        ui,
        bodyColumns,
        header,
        isRemove ? m.removeTitle(tool.name) : m.restartTitle(tool.name),
        [{ text: isRemove ? m.removeHint : m.restartHint, tone: 'muted' }],
        {
          label: isRemove ? m.removeConfirm : m.restartConfirm,
          onPress: act(async () => {
            await dismiss()
            if (isRemove) {
              await changeTools($, { remove: tool.id })

              return m.removed(tool.name)
            }
            await stopTool($, tool)
            // The old run ends before the new one takes its log.
            while (running.has(tool.id)) await new Promise<void>(resolve => $.clock.after(100, resolve))
            const again = startingValues(tool, (await rememberedValues($))[tool.id] ?? {})

            return askedParams(tool).length > 0 ? openDialog({ kind: 'ask', id: tool.id }, again).then(() => undefined) : runTool($, tool, again)
          }),
        },
        { label: m.cancel, onPress: act(dismiss) },
        await read($, focused),
      )
    }

    const now = Math.max(await $.clock.now(), await read($, logTick))
    // How far each running shell tool says it has got.
    const activity = Object.fromEntries(
      [...buffers.entries()].map(([id, buffer]) => [id, { progress: running.has(id) ? progressOf([...buffer.lines, buffer.current]) : undefined }]),
    )
    const model = { tools: list, runs: await read($, runs), activity, error: await read($, toolsError), path: `${TOOLBOX_DIR}/${TOOLS_FILE}`, now, m, bodyColumns }
    const toolActions = {
      run: (tool: Tool) => act(() => start(tool))(),
      stop: (tool: Tool) => act(() => stopTool($, tool))(),
      log: (tool: Tool) =>
        act(async () => {
          await update($, follow, () => true)
          logLast = undefined
          if (!buffers.has(tool.id)) await loadLog($, tool.id)
          await openDialog({ kind: 'log', id: tool.id })
        })(),
      edit: (tool: Tool) => act(() => openDialog({ kind: 'edit', id: tool.id }, toDraft(tool)))(),
      remove: (tool: Tool) => act(() => openDialog({ kind: 'remove', id: tool.id }))(),
    }

    if (quick) {
      return (
        <Box flexDirection="column">
          {Header(ui, header)}
          <Box key="body-quick" flexDirection="column" marginTop={1}>
            {QuickView(ui, model, {
              run: toolActions.run,
              stop: toolActions.stop,
              log: toolActions.log,
              settings: act(() => openPane($, 'tools')),
            })}
          </Box>
        </Box>
      )
    }

    const active = await read($, tab)
    const tabs = [
      { key: 'tools', label: m.tabTools, hotkey: '1', badge: list.length > 0 ? `${list.length}` : undefined },
      { key: 'add', label: m.tabAdd, hotkey: '2' },
    ]
    const select = (key: string) => act(() => openPane($, key as Tab))()
    const newTool = (kind: ToolKind, values: Partial<Record<string, string>> = {}, group?: string) =>
      act(() => openDialog({ kind: 'edit', id: '' }, { kind, name: '', run: '', cwd: '', submit: 'fill', confirm: 'run', ...(group ? { group } : {}), ...values } as Record<string, string>))()
    const fromTask = (task: DetectedTask) =>
      act(() =>
        openDialog(
          { kind: 'edit', id: '' },
          { ...toDraft({ name: task.name, kind: 'shell', run: task.run, cwd: task.cwd, params: task.params }), group: task.source },
        ),
      )()
    const body =
      active === 'add'
        ? AddTab(
            ui,
            {
              detected: await read($, detected),
              unreadable: await read($, unreadable),
              commands: await read($, commands),
              query: await read($, addQuery),
              hasGradle: (await read($, detected))?.some(task => task.source === 'gradle') === true,
              hasField,
              m,
              bodyColumns,
            },
            {
              search: query => void update($, addQuery, () => query).catch((error: unknown) => debug($, error)),
              addTask: fromTask,
              addCommand: name => newTool('claude', { name: `/${name}`, run: `/${name}`, confirm: CONFIRMED_COMMANDS.includes(name) ? 'ask' : 'run' }, 'claude'),
              addShell: () => newTool('shell', {}, 'custom'),
              addPrompt: () => newTool('prompt', {}, 'custom'),
              loadGradle: act(() => loadGradleTasks($)),
            },
          )
        : ToolsTab(ui, model, toolActions)

    return (
      <Box flexDirection="column">
        {Header(ui, header)}
        {TabBar(ui, tabs, active, select)}
        <Box key={`body-${active}`} flexDirection="column" marginTop={1}>
          {body}
        </Box>
        {Tiles(ui, bodyColumns, [{ key: 'quick', label: m.quickButton, onPress: act(() => openPane($, 'quick')) }])}
      </Box>
    )
  })
}
