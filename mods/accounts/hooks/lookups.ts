import type { UsageView } from '../types'
import { AnthropicError, USAGE_URL, failedReading, heldReading, lookedUpOnly, needsRefresh, parseSpend, parseUsage, usageInit, withMeasured } from './anthropic'
import type { MeasuredWindow } from './anthropic'
import { USAGE_KEY, exclusive, figuresTrustedFrom, isLiveTokenOf, oauthAccountKey, organizationOf, savedIds, syncLive } from './accounts'
import type { AccountsContext } from './accounts'
import { REFRESH_TIMEOUT_MS, ensureFresh, liveOauthAccount, readLiveCredential, readVault, refreshOrcaCopy } from './credentials'
import type { OauthAccount } from './credentials'
import { message, within } from './io'
import { isSameGrant } from './keychain'
import type { Credential } from './keychain'
import { LockBusyError } from './lock'
import { orcaAccountFor } from './orca'
import type { OrcaAccount } from './orca'
import { ORCA_COPY_MARGIN_MS } from './orcaCopies'
import { orcaCopyPlace, rememberedOrca } from './orcaClient'
import { LIVE_POLL_MS, afterRateLimit, afterSuccess, isAutomaticLookupDue, readShared } from './schedule'

/**
 * Every saved account's rate limits: looked up with each account's own
 * token, shared with the other sessions through the store, and the live
 * account's kept equal to what Claude Code's own responses report.
 */

const LOOKUP_KEY = 'lookup'
/** The `$.store` key holding when any session last looked the live account up. */
export const LIVE_LOOKUP_KEY = 'liveLookupAt'
/** How long the usage endpoint may take to answer. */
const USAGE_TIMEOUT_MS = 15_000

/** The login changed between reading whose it is and looking it up: the answer would be another account's. */
class LoginChangedError extends Error {}

/**
 * An inactive account's token needs refreshing, and Orca keeps a copy of its
 * login where this mod cannot reach it (no keychain item, or no folder Orca
 * marks as that account's): refreshing only this mod's copy would leave Orca's
 * spent, so it is left alone.
 */
class HeldByOrcaError extends Error {}

/** The Orca account that keeps a copy of a saved account's login, as Orca last said; undefined when it keeps none. */
async function orcaKeeperOf(ctx: AccountsContext, uuid: string): Promise<OrcaAccount | undefined> {
  const email = (await ctx.accounts.get()).find(one => one.uuid === uuid)?.email
  const remembered = await rememberedOrca(ctx.io)
  if (email === undefined || remembered === null) return undefined
  const details = (await ctx.io.store.get(oauthAccountKey(uuid))) as OauthAccount | undefined

  return orcaAccountFor(remembered, email, organizationOf(details))
}

/**
 * A saved account's token, refreshed first when it nears expiry. Where Orca
 * keeps a copy of the same grant, both copies are refreshed together, so Orca
 * never writes a spent login later.
 */
async function savedToken(ctx: AccountsContext, uuid: string, saved: Credential, live: Credential | null): Promise<string> {
  const { io } = ctx
  const noAnswer = ctx.messages().refreshNoAnswer(REFRESH_TIMEOUT_MS / 1000)
  const keeper = needsRefresh(saved, await io.now()) ? await orcaKeeperOf(ctx, uuid) : undefined
  if (!keeper) return (await ensureFresh(io, uuid, saved, live, noAnswer)).claudeAiOauth.accessToken
  const place = await orcaCopyPlace(io, keeper.id)
  const step = place === null ? 'absent' : await refreshOrcaCopy(io, uuid, place, ORCA_COPY_MARGIN_MS, noAnswer)
  const fresh = step === 'refreshed' || step === 'fresh' ? await readVault(io, uuid) : null
  if (fresh === null) throw new HeldByOrcaError(uuid)

  return fresh.claudeAiOauth.accessToken
}

/**
 * One account's reading. The live login is Claude Code's to refresh, never
 * this mod's, so it is looked up with the token Claude Code holds, once that
 * token is known to be this account's; a saved login that is the live grant
 * (the config naming another account for a moment) is the live account's too.
 */
async function readingFor(ctx: AccountsContext, uuid: string, liveUuid: string | null, live: Credential | null): Promise<UsageView> {
  const { io } = ctx
  const m = ctx.messages()
  const saved = uuid === liveUuid ? null : await readVault(io, uuid)
  let token: string
  if (uuid === liveUuid || isSameGrant(saved, live)) {
    if (live === null) throw new Error(m.noStoredLogin)
    if (!isLiveTokenOf(live, uuid)) throw new LoginChangedError(uuid)
    token = live.claudeAiOauth.accessToken
  } else {
    if (saved === null) throw new Error(m.noStoredLogin)
    token = await savedToken(ctx, uuid, saved, live)
  }
  const response = await within(io, io.fetch(USAGE_URL, usageInit({ token })), USAGE_TIMEOUT_MS, m.usageNoAnswer(USAGE_TIMEOUT_MS / 1000))
  if (!response.ok) throw new AnthropicError(`usage endpoint answered ${response.status}`, response.status, response.headers['retry-after'])
  const body: unknown = JSON.parse(response.text)
  const spend = parseSpend(body)

  return { limits: parseUsage(body), fetchedAt: await io.now(), source: 'lookup', ...(spend ? { spend } : {}) }
}

/** Reads the live account alone and shares the reading; what a switch and Claude Code's own readings ask for. */
export async function refreshLive(ctx: AccountsContext): Promise<void> {
  const { io } = ctx
  const liveUuid = await syncLive(ctx)
  if (liveUuid === null) return
  await io.store.set(LIVE_LOOKUP_KEY, await io.now())
  let reading: UsageView
  try {
    reading = await readingFor(ctx, liveUuid, liveUuid, await readLiveCredential(io))
  } catch (error) {
    if (error instanceof LoginChangedError) return
    reading = failedReading((await ctx.usage.get())[liveUuid], error, await io.now(), ctx.messages())
  }
  await ctx.usage.update(map => ({ ...map, [liveUuid]: reading }))
  await io.store.set(USAGE_KEY, { ...lookedUpOnly(await io.store.get(USAGE_KEY)), [liveUuid]: reading })
}

/** Looks the live account up when no session has for `LIVE_POLL_MS` and no 429 holds lookups back: it stays current between Claude Code's own readings. */
export async function pollLive(ctx: AccountsContext): Promise<void> {
  const { io } = ctx
  const lastLiveLookup = Number((await io.store.get(LIVE_LOOKUP_KEY)) ?? 0)
  const { backoffUntil } = readShared(await io.store.get(LOOKUP_KEY))
  const now = await io.now()
  if (now >= backoffUntil && now - lastLiveLookup >= LIVE_POLL_MS) await refreshLive(ctx)
}

/** Shows the readings the last lookup, by any session on this machine, stored. */
export async function adoptSharedUsage(ctx: AccountsContext): Promise<void> {
  const stored = lookedUpOnly(await ctx.io.store.get(USAGE_KEY))
  await ctx.usage.update(map => ({ ...lookedUpOnly(map), ...stored }))
}

/**
 * Reads every saved account's rate limits, one after another, and shares
 * them with the other sessions. `isAsked` is a lookup the person asked for:
 * it runs at once, past the shared schedule and any 429 wait.
 */
export async function refreshAll(ctx: AccountsContext, isAsked: boolean): Promise<void> {
  const { io } = ctx
  if (await ctx.isRefreshing.get()) return
  const startedAt = await io.now()
  let shared = readShared(await io.store.get(LOOKUP_KEY))
  if (!isAsked && !isAutomaticLookupDue(shared, startedAt)) {
    // Reusing another session's lookup still needs this session to know which account is live.
    await syncLive(ctx)
    await adoptSharedUsage(ctx)

    return
  }
  // Claim the slot before the requests go out, so a session ticking meanwhile reuses this lookup.
  shared = { ...shared, startedAt }
  await io.store.set(LOOKUP_KEY, shared)
  await ctx.isRefreshing.set(true)
  let retryAfter: string | undefined
  let isRateLimited = false
  try {
    const liveUuid = await syncLive(ctx)
    for (const account of await ctx.accounts.get()) {
      try {
        const reading = await exclusive(async () => {
          // Whose login Claude Code uses now, read again for each account: a switch here or in another
          // session may have made this one live since the lookup began, and the live login is never refreshed here.
          const liveNow = (await liveOauthAccount(io).catch(() => null))?.accountUuid ?? liveUuid

          return readingFor(ctx, account.uuid, liveNow, await readLiveCredential(io).catch(() => null))
        })
        await ctx.usage.update(map => ({ ...map, [account.uuid]: reading }))
      } catch (error) {
        // Another session switched meanwhile, or is refreshing this account: nothing is filed this time.
        if (error instanceof LoginChangedError || error instanceof LockBusyError) continue
        // Left to Orca: the figures last looked up stay, and the card says why they age.
        if (error instanceof HeldByOrcaError) {
          const now = await io.now()
          await ctx.usage.update(map => ({ ...map, [account.uuid]: heldReading(map[account.uuid], now) }))
          continue
        }
        if (error instanceof AnthropicError && error.status === 429) {
          isRateLimited = true
          retryAfter = error.retryAfter ?? retryAfter
        }
        const now = await io.now()
        await ctx.usage.update(map => ({ ...map, [account.uuid]: failedReading(map[account.uuid], error, now, ctx.messages()) }))
      }
    }
  } finally {
    // Only the accounts saved now: the reading of one removed meanwhile, in any session, is not written back.
    const known = await savedIds(ctx)
    const readings = lookedUpOnly(await ctx.usage.get())
    await io.store.set(USAGE_KEY, Object.fromEntries(Object.entries(readings).filter(([uuid]) => known.has(uuid))))
    const now = await io.now()
    await io.store.set(LOOKUP_KEY, isRateLimited ? afterRateLimit(shared, now, retryAfter) : afterSuccess(shared))
    await ctx.isRefreshing.set(false)
  }
}

/**
 * Keeps the live account's five-hour and weekly figures equal to the ones
 * this session's latest response reported, which need no lookup and no rate
 * limit. Only once a turn has begun since the live account last changed:
 * before that, the session's figures may be the previous login's. Written
 * when they differ from what is shown, or when the shown reading is a minute
 * old, so a figure filed wrongly is put right by the next response.
 */
export async function adoptSessionFigures(ctx: AccountsContext, windows: readonly MeasuredWindow[], turnStartedAt: number): Promise<void> {
  const { io } = ctx
  const liveUuid = await ctx.live.get()
  if (liveUuid === null || turnStartedAt === 0 || turnStartedAt <= (await figuresTrustedFrom(io))) return
  const measured = windows.filter(window => window.kind === 'five_hour' || window.kind === 'seven_day')
  if (measured.length === 0) return
  const now = await io.now()
  const current = (await ctx.usage.get())[liveUuid]
  const next = withMeasured(current, measured, now)
  const shown = (reading: UsageView | undefined) => JSON.stringify((reading?.limits ?? []).filter(limit => limit.label === '5h' || limit.label === 'wk'))
  if (shown(current) === shown(next) && current?.isStale !== true && now - (current?.fetchedAt ?? 0) < 60_000) return
  await ctx.usage.update(map => ({ ...map, [liveUuid]: next }))
  await io.store.set(USAGE_KEY, { ...lookedUpOnly(await io.store.get(USAGE_KEY)), [liveUuid]: next })
}

/**
 * Claude Code's own response reported its windows. They are the live
 * account's only when this turn began after the live account last changed,
 * and when the login Claude Code is configured with is still the one this
 * session knows: a switch made in another session reaches every session's
 * requests at once but this session's `live` only at its next read, and the
 * new login's figures must never be filed under the account it replaced.
 * Otherwise the account is read again and looked up instead.
 */
export async function adoptMeasured(ctx: AccountsContext, windows: readonly MeasuredWindow[], turnStartedAt: number): Promise<void> {
  const { io } = ctx
  const liveUuid = await ctx.live.get()
  if (liveUuid === null || windows.length === 0) return
  const configured = await liveOauthAccount(io).catch((error: unknown) => {
    // An unreadable config names no account: the figures are not filed.
    io.log(message(error))

    return null
  })
  if (configured?.accountUuid !== liveUuid) {
    void syncLive(ctx)
      .then(() => refreshLive(ctx))
      .catch((error: unknown) => io.log(message(error)))

    return
  }
  if (turnStartedAt > (await figuresTrustedFrom(io))) {
    const now = await io.now()
    const reading = withMeasured((await ctx.usage.get())[liveUuid], [...windows], now)
    await ctx.usage.update(map => ({ ...map, [liveUuid]: reading }))
    await io.store.set(USAGE_KEY, { ...lookedUpOnly(await io.store.get(USAGE_KEY)), [liveUuid]: reading })

    return
  }
  void refreshLive(ctx).catch((error: unknown) => io.log(message(error)))
}
