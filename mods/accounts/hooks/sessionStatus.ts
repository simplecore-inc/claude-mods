import type { SessionUsage, SettingsSource } from 'claude-code'

import type { SessionEffort, StatusInfo } from '../types'
import { syncLive } from './accounts'
import type { AccountsContext } from './accounts'
import { StatusCollector } from './collector'
import type { CollectorIo } from './collector'
import { globalConfigPath, liveOauthAccount } from './credentials'
import { feedWebhook } from './feed'
import type { FeedContext } from './feed'
import type { Cell } from './io'
import { message } from './io'
import { adoptSessionFigures, adoptSharedUsage } from './lookups'
import { displayModel, savedModelEffort, startingEffort } from './status'
import type { EffortSettings } from './status'

/**
 * The session's status as the band draws it and the webhook sends it: the
 * model and effort, the task, the branch and PR, ULTRACODE, the context, the
 * lines changed. Read every two seconds; a slow read is never overlapped.
 */

/** What a status read reads beyond the machine. */
export type StatusContext = {
  accounts: AccountsContext
  feed: FeedContext
  cwd: () => Promise<string>
  model: () => Promise<string>
  usage: () => Promise<SessionUsage>
  settings: () => Promise<{ fastMode?: unknown }>
  /** One settings source as loaded: the effort a session starts at is settled source by source. */
  settingsOf: (source: SettingsSource) => Promise<EffortSettings>
  status: Cell<StatusInfo | null>
  /** The effort this session runs at, kept in its own state so a reload keeps it; null before it is settled. */
  sessionEffort: Cell<SessionEffort | null>
  turnStartedAt: () => number
}

/** The levels `/effort` names. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
/** How long after `/effort` opens its list a level saved for the model is taken as this session's pick. */
const EFFORT_PICK_MS = 60_000

/** Each session's lines added and removed, a store key of its own: `lines:<session id>`. */
const LINES_PREFIX = 'lines:'
/** Lines counts kept this long after their session last changed them. */
const LINES_KEPT_MS = 7 * 24 * 60 * 60 * 1000
/** The one map every session's count was kept in before each had a key of its own. */
const LEGACY_LINES_KEY = 'lines'

let collector: StatusCollector | null = null
let configPath = ''
let sessionRoot = ''
let sessionId = ''
/**
 * The session's effort as this module last set it. A /clear goes on in this
 * process with the state emptied and the effort as it was; a reload keeps the
 * state and loses this. Each covers what the other does not.
 */
let heldEffort: SessionEffort | null = null
/** `/effort` opened its list: the level saved for the model then, and until when a change there is this session's pick. */
let effortPick: { from: string | null; until: number } | null = null
/** This session's lines added and removed by file-changing tool calls. */
let lines = { added: 0, removed: 0 }
/** When Claude Code's config was last seen changed: a switch in any session rewrites it. */
let configSeenAt = 0
/** Whether a status read is under way. */
let isCollecting = false

/** Sets up what the status is read from, at session start. */
export function startStatus(io: CollectorIo, where: { configPath: string; sessionRoot: string }): void {
  collector = new StatusCollector(io)
  configPath = where.configPath
  sessionRoot = where.sessionRoot
}

/** Sets the session's effort, here and in its state; a level the state already holds is not written again. */
async function setEffort(ctx: StatusContext, level: string | null): Promise<void> {
  heldEffort = { level }
  if ((await ctx.sessionEffort.get())?.level !== level) await ctx.sessionEffort.set(heldEffort)
}

/**
 * Takes up a session: its own lines counted so far, and its effort. The effort
 * is the session's own, never the settings as they stand now: their
 * `effortLevel` is the default for new sessions, and another window saving one
 * changes no session already running. So it is the one the state kept (a
 * reload), or this module (a /clear, which empties the state), else the
 * default as the session starts.
 */
export async function beginSession(ctx: StatusContext, id: string, isCleared: boolean): Promise<void> {
  sessionId = id
  const { store } = ctx.accounts.io
  // A count kept before each session had a key of its own sits in one map under `lines`.
  const saved = ((await store.get(`${LINES_PREFIX}${id}`)) ?? ((await store.get(LEGACY_LINES_KEY)) as Record<string, unknown> | undefined)?.[id]) as
    | { added?: number; removed?: number }
    | undefined
  lines = { added: saved?.added ?? 0, removed: saved?.removed ?? 0 }
  effortPick = null
  const kept = (await ctx.sessionEffort.get()) ?? (isCleared ? heldEffort : null)
  await setEffort(ctx, kept ? kept.level : await startingEffortOf(ctx))
}

async function startingEffortOf(ctx: StatusContext): Promise<string | null> {
  const sources: SettingsSource[] = ['user', 'project', 'local', 'flag', 'policy']
  const settings = await Promise.all(sources.map(source => ctx.settingsOf(source)))

  return startingEffort(Object.fromEntries(sources.map((source, index) => [source, settings[index]])), await ctx.model())
}

/** The effort a main-loop request was sent with, as the engine settled it: the session's own; none for a model that takes none. */
export async function noteRequestEffort(ctx: StatusContext, effort: string | number | undefined): Promise<void> {
  effortPick = null
  await setEffort(ctx, effort === undefined ? null : String(effort))
}

/**
 * This session's `/effort`, once it has run: the level it names, at once.
 * Run bare, it opens a list, and a pick saved as the default for new sessions
 * is saved for the model in the user's settings, now or once the list closes:
 * such a change within a minute is this session's. A pick kept to this
 * session saves nothing, and shows from the next request.
 */
export async function noteEffortCommand(ctx: StatusContext, args: string, userBefore: EffortSettings): Promise<void> {
  const named = args.trim().toLowerCase()
  effortPick = null
  if (EFFORT_LEVELS.has(named)) {
    await setEffort(ctx, named)

    return
  }
  effortPick = { from: savedModelEffort(userBefore, await ctx.model()), until: (await ctx.accounts.io.now()) + EFFORT_PICK_MS }
  await followEffortPick(ctx)
}

/** Takes a level `/effort` saved from its list as this session's effort, while the pick is fresh. */
export async function followEffortPick(ctx: StatusContext): Promise<void> {
  if (!effortPick) return
  if ((await ctx.accounts.io.now()) > effortPick.until) {
    effortPick = null

    return
  }
  const level = savedModelEffort(await ctx.settingsOf('user'), await ctx.model())
  if (level === null || level === effortPick.from) return
  effortPick = null
  await setEffort(ctx, level)
}

/** The effort the band shows: the session's own. */
export async function effortShown(ctx: StatusContext): Promise<string | null> {
  return ((await ctx.sessionEffort.get()) ?? heldEffort)?.level ?? null
}

/**
 * Adds an edit's lines to this session's count, kept under the session's own
 * store key so a reload keeps it and no session writes another's; counts a
 * week old are dropped.
 */
export async function countLines(ctx: StatusContext, change: { added: number; removed: number }): Promise<void> {
  if (change.added === 0 && change.removed === 0) return
  const { io } = ctx.accounts
  lines = { added: lines.added + change.added, removed: lines.removed + change.removed }
  const now = await io.now()
  await io.store.set(`${LINES_PREFIX}${sessionId}`, { ...lines, at: now })
  for (const key of await io.store.keys()) {
    if (key === LEGACY_LINES_KEY) await io.store.delete(key)
    if (!key.startsWith(LINES_PREFIX) || key === `${LINES_PREFIX}${sessionId}`) continue
    const entry = (await io.store.get(key)) as { at?: unknown } | undefined
    if (typeof entry?.at !== 'number' || now - entry.at >= LINES_KEPT_MS) await io.store.delete(key)
  }
}

/**
 * Follows a switch made in another session within one status read: when
 * Claude Code's config changed and names another login than this session's,
 * the live account is read again and the figures the switching session
 * stored are shown at once, rather than at the next minute's tick.
 */
async function followLogin(ctx: StatusContext): Promise<void> {
  const { io } = ctx.accounts
  const path = await globalConfigPath(io)
  if (!(await io.exists(path))) return
  const { mtimeMs } = await io.stat(path)
  if (mtimeMs === configSeenAt) return
  configSeenAt = mtimeMs
  const configured = await liveOauthAccount(io)
  if (configured === null || configured.accountUuid === (await ctx.accounts.live.get())) return
  await syncLive(ctx.accounts)
  await adoptSharedUsage(ctx.accounts)
}

/** Reads the session's status: what the band draws and the webhook is sent. */
export async function collectStatus(ctx: StatusContext): Promise<StatusInfo | null> {
  if (!collector || isCollecting) return null
  isCollecting = true
  try {
    return await collectStatusOnce(ctx, collector)
  } finally {
    isCollecting = false
  }
}

async function collectStatusOnce(ctx: StatusContext, reader: StatusCollector): Promise<StatusInfo> {
  const { io } = ctx.accounts
  await followLogin(ctx).catch((error: unknown) => io.log(message(error)))
  const usageNow = await ctx.usage()
  await adoptSessionFigures(ctx.accounts, usageNow.rateLimits, ctx.turnStartedAt()).catch((error: unknown) => io.log(message(error)))
  const cwd = await ctx.cwd()
  const modelId = await ctx.model()
  const settings = await ctx.settings()
  await followEffortPick(ctx)
  const branch = await reader.branch(cwd)
  const now = await io.now()
  const [pr, task, ultracode] = await Promise.all([
    reader.pullRequest(cwd, branch, now),
    reader.task(configPath, sessionId),
    reader.transcript(configPath, sessionRoot, sessionId, now).then(path => reader.ultracode(path)),
  ])
  const next: StatusInfo = {
    updatedAt: now,
    model: displayModel(modelId),
    effort: await effortShown(ctx),
    ultracode,
    fast: settings.fastMode === true,
    contextUsed: usageNow.context.percent ?? null,
    task,
    dir: cwd.split('/').filter(Boolean).pop() ?? cwd,
    branch,
    pr,
    linesAdded: lines.added,
    linesRemoved: lines.removed,
  }
  const current = await ctx.status.get()
  const { updatedAt: _was, ...currentRest } = current ?? { updatedAt: 0 }
  const { updatedAt: _now, ...nextRest } = next
  if (JSON.stringify(currentRest) !== JSON.stringify(nextRest)) await ctx.status.set(next)
  await feedWebhook(ctx.feed, next, modelId, cwd, usageNow.cost?.usd ?? null).catch((error: unknown) => io.log(message(error)))

  return next
}
