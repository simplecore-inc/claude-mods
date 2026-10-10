import type { CodexAccountView, CodexLogin, LimitView } from '../types'
import { open } from './codex/server'
import type { Host } from './codex/server'
import type { Messages } from './i18n'
import type { Cell, Io } from './io'
import { message, within } from './io'
import { truncate } from './shared/layout'

/** How old a Codex reading may get while the pane is open before it is looked up again. */
export const CODEX_LOOKUP_MS = 5 * 60 * 1000
/** How long the Codex lookup waits for `codex app-server`, from its start to both answers. */
export const CODEX_TIMEOUT_MS = 15_000

/**
 * What the Codex card reaches the machine through: the Codex server is
 * started in the session's folder, and the card's state is this session's
 * own, as the Codex login depends on the environment the session started in
 * (`CODEX_HOME`).
 */
export type CodexAccountContext = {
  io: Io
  host: Host
  cwd: () => Promise<string>
  cell: Cell<CodexAccountView | null>
  messages: () => Messages
}

/**
 * Cells a limit's own name may take: every card's gauges share the widest
 * label's width, so a long name from Codex would widen the Claude cards' too.
 */
const LIMIT_NAME_CELLS = 12

/** A window's label as the Claude cards name theirs: `5h`, `wk`, else its hours or days. */
export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h'
  if (minutes === 10_080) return 'wk'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`

  return `${Math.round(minutes / 60)}h`
}

type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
type Limit = { limitId?: unknown; limitName?: unknown; primary?: Window | null; secondary?: Window | null; credits?: unknown }

function limitOf(window: Window | null | undefined, label?: string): LimitView[] {
  if (!window || typeof window.usedPercent !== 'number') return []
  const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null
  const resetsAt = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : undefined

  return [{ label: label ?? (minutes === null ? '?' : windowLabel(minutes)), percent: Math.max(0, Math.min(100, window.usedPercent)), ...(resetsAt ? { resetsAt } : {}) }]
}

/** `account/read`'s answer as the card names the login. */
export function loginOf(answer: unknown): CodexLogin {
  const account = (answer as { account?: { type?: unknown; email?: unknown; planType?: unknown } | null } | null)?.account
  if (account?.type === 'chatgpt') {
    return { kind: 'chatgpt', email: typeof account.email === 'string' ? account.email : null, plan: typeof account.planType === 'string' ? account.planType : null }
  }

  return account?.type === 'apiKey' ? { kind: 'apiKey' } : { kind: 'none' }
}

/**
 * `account/rateLimits/read`'s answer as the card draws it: the main limit's
 * windows by their length, then each other limit's windows under its name,
 * and the credits when the account has them.
 */
export function limitsOf(answer: unknown): { limits: LimitView[]; credits?: CodexAccountView['credits'] } {
  const read = answer as { rateLimits?: Limit | null; rateLimitsByLimitId?: Record<string, Limit> | null } | null
  const main = read?.rateLimits
  const limits = [...limitOf(main?.primary), ...limitOf(main?.secondary)]
  // The main limit is also listed by its id; without an id it is known by its windows.
  const windowsOf = (limit: Limit) => JSON.stringify([limit.primary ?? null, limit.secondary ?? null])
  const isMain = (id: string, other: Limit) => (typeof main?.limitId === 'string' ? id === main.limitId : main != null && windowsOf(other) === windowsOf(main))
  for (const [id, other] of Object.entries(read?.rateLimitsByLimitId ?? {})) {
    if (isMain(id, other)) continue
    const name = truncate(typeof other.limitName === 'string' && other.limitName !== '' ? other.limitName : id, LIMIT_NAME_CELLS)
    // Each of its windows: the first under its name, a second also under the window's length.
    const windows = [other.primary, other.secondary].filter((window): window is Window => window != null)
    windows.forEach((window, index) => {
      const length = typeof window.windowDurationMins === 'number' ? ` ${windowLabel(window.windowDurationMins)}` : ` ${index + 1}`
      limits.push(...limitOf(window, index === 0 ? name : `${name}${length}`))
    })
  }
  const credits = main?.credits as { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | undefined
  if (credits?.hasCredits !== true) return { limits }
  const balance = typeof credits.balance === 'string' || typeof credits.balance === 'number' ? Number(credits.balance) : NaN

  return { limits, credits: { isUnlimited: credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null } }
}

/** Asks one `codex app-server` for the login and its limits, and ends it however the asking ends. */
async function lookUp(ctx: CodexAccountContext): Promise<{ login: CodexLogin; limits: LimitView[]; credits?: CodexAccountView['credits'] }> {
  let stop: (() => void) | undefined
  let isOver = false
  const asking = (async () => {
    const cwd = await ctx.cwd()
    // A wait given up before the server is spawned spawns none.
    if (isOver) throw new Error('the Codex lookup was given up')
    const started = await open(ctx.host, [], cwd, end => (stop = end))
    const login = loginOf(await started.call('account/read', { refreshToken: false }))
    // A signed-out Codex has no limits to read.
    if (login.kind === 'none') return { login, limits: [] }

    return { login, ...limitsOf(await started.call('account/rateLimits/read')) }
  })()
  try {
    return await within(ctx.io, asking, CODEX_TIMEOUT_MS, ctx.messages().codexNoAnswer(CODEX_TIMEOUT_MS / 1000))
  } finally {
    // Ends the server however far it got, a start still waiting on Codex included.
    isOver = true
    stop?.()
  }
}

/** Whether a lookup runs in this process now: a second one waits for the next tick. */
let isLooking = false

/**
 * Looks the Codex account up when asked (Refresh), or when the last lookup is
 * older than `CODEX_LOOKUP_MS`. A failed lookup keeps the figures before it,
 * says why, and is tried again after the same time. Nothing runs where the
 * Codex CLI does not (the cell is null).
 */
export async function refreshCodexAccount(ctx: CodexAccountContext, isAsked: boolean): Promise<void> {
  // Taken before the first wait, so a Refresh and the tick never run two lookups at once.
  if (isLooking) return
  isLooking = true
  try {
    await lookUpWhenDue(ctx, isAsked)
  } finally {
    isLooking = false
  }
}

async function lookUpWhenDue(ctx: CodexAccountContext, isAsked: boolean): Promise<void> {
  const before = await ctx.cell.get()
  if (before === null) return
  const now = await ctx.io.now()
  if (!isAsked && before.lookedAt > 0 && now - before.lookedAt < CODEX_LOOKUP_MS) return
  try {
    const found = await lookUp(ctx)
    const at = await ctx.io.now()
    await ctx.cell.set({ login: found.login, reading: { limits: found.limits, fetchedAt: at }, ...(found.credits ? { credits: found.credits } : {}), lookedAt: at })
  } catch (error) {
    const at = await ctx.io.now()
    const reading = { limits: before.reading?.limits ?? [], fetchedAt: before.reading?.fetchedAt ?? at, error: message(error) }
    await ctx.cell.set({ ...before, reading, lookedAt: at })
  }
}
