/** How often, machine-wide, the automatic lookup reads every account's usage. */
export const POLL_MS = 5 * 60 * 1000
/** The first wait after a 429 that names no Retry-After; each further 429 doubles it. */
const BACKOFF_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 60 * 60 * 1000

/**
 * What every session shares through `$.store`, so the sessions on one
 * machine make one automatic lookup between them rather than one each.
 */
export type SharedLookup = {
  /** When the last lookup started, by any session; 0 before the first. */
  startedAt: number
  /** Until when automatic lookups wait after a 429; 0 when they need not. */
  backoffUntil: number
  /** The wait the last 429 imposed, doubled by the next one. */
  backoffMs: number
}

/** How often, machine-wide, the live account is looked up while nothing else refreshes it. */
export const LIVE_POLL_MS = 2 * 60 * 1000

export const NO_LOOKUP: SharedLookup = { startedAt: 0, backoffUntil: 0, backoffMs: 0 }

export function readShared(stored: unknown): SharedLookup {
  const value = (stored ?? {}) as Partial<SharedLookup>

  return {
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    backoffUntil: typeof value.backoffUntil === 'number' ? value.backoffUntil : 0,
    backoffMs: typeof value.backoffMs === 'number' ? value.backoffMs : 0,
  }
}

/**
 * Whether an automatic tick looks the usage up itself. A lookup the person
 * asks for never asks this: it always runs.
 */
export function isAutomaticLookupDue(shared: SharedLookup, now: number): boolean {
  return now >= shared.backoffUntil && now - shared.startedAt >= POLL_MS
}

/**
 * The shared record after a 429: wait what `Retry-After` says (seconds or an
 * HTTP date), else twice the last wait, starting at five minutes.
 */
export function afterRateLimit(shared: SharedLookup, now: number, retryAfter: string | undefined): SharedLookup {
  const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter)
  const date = retryAfter === undefined ? Number.NaN : Date.parse(retryAfter)
  let waitMs: number
  if (Number.isFinite(seconds) && seconds >= 0) waitMs = seconds * 1000
  else if (Number.isFinite(date)) waitMs = Math.max(0, date - now)
  else waitMs = Math.min(MAX_BACKOFF_MS, shared.backoffMs > 0 ? shared.backoffMs * 2 : BACKOFF_MS)

  return { ...shared, backoffUntil: now + waitMs, backoffMs: waitMs }
}

/** The shared record after a lookup that met no 429. */
export function afterSuccess(shared: SharedLookup): SharedLookup {
  return { ...shared, backoffUntil: 0, backoffMs: 0 }
}
