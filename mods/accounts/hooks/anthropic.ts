import type { HttpInit } from 'claude-code'

import type { LimitView, Money, SpendView, UsageView } from '../types'
import type { Messages } from './i18n'
import { isAccountId } from './keychain'
import type { Credential } from './keychain'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The response's `Retry-After` header, when it sent one. */
    readonly retryAfter?: string,
  ) {
    super(message)
  }
}

type RawLimit = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
}

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null

type RawUsage = {
  limits?: RawLimit[]
  five_hour?: RawWindow
  seven_day?: RawWindow
}

function labelOf(limit: RawLimit): string {
  if (limit.kind === 'session') return '5h'
  if (limit.kind === 'weekly_all') return 'wk'

  return limit.scope?.model?.display_name ?? limit.kind ?? '?'
}

/** Turns the usage endpoint's body into the windows the pane draws. */
export function parseUsage(body: unknown): LimitView[] {
  const raw = (body ?? {}) as RawUsage
  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    return raw.limits
      .filter(limit => typeof limit.percent === 'number')
      .map(limit => ({ label: labelOf(limit), percent: limit.percent as number, resetsAt: limit.resets_at ?? undefined }))
  }
  const windows: [string, RawWindow | undefined][] = [
    ['5h', raw.five_hour],
    ['wk', raw.seven_day],
  ]

  return windows.flatMap(([label, window]) =>
    typeof window?.utilization === 'number'
      ? [{ label, percent: window.utilization, resetsAt: window.resets_at ?? undefined }]
      : [],
  )
}

type RawMoney = { amount_minor?: unknown; currency?: unknown; exponent?: unknown } | null

/** An amount as the endpoint writes it, or undefined when any part is missing. */
function moneyOf(raw: RawMoney | undefined): Money | undefined {
  if (!raw || typeof raw.amount_minor !== 'number' || typeof raw.currency !== 'string' || typeof raw.exponent !== 'number') return undefined

  return { minor: raw.amount_minor, currency: raw.currency, exponent: raw.exponent }
}

/**
 * What the account spent past its plan, from the usage endpoint's `spend`:
 * shown only when spending is on or something was spent, and only with every
 * part of the amount given. Nothing is estimated.
 */
export function parseSpend(body: unknown): SpendView | undefined {
  const spend = (body as { spend?: { used?: RawMoney; limit?: RawMoney; enabled?: unknown } | null } | null)?.spend
  const used = moneyOf(spend?.used)
  if (!spend || !used || (spend.enabled !== true && used.minor === 0)) return undefined
  const limit = moneyOf(spend.limit)

  return limit ? { used, limit } : { used }
}

/** An amount in its currency's units, as many decimals as the endpoint says: `12.34 USD`. */
export function moneyText(money: Money): string {
  return `${(money.minor / 10 ** money.exponent).toFixed(money.exponent)} ${money.currency}`
}

/** The usage request: with a bearer token, or with the session's own credential handle. */
export function usageInit(auth: { token: string } | { handle: string }): HttpInit {
  if ('handle' in auth) return { headers: { 'anthropic-beta': OAUTH_BETA }, auth: auth.handle }

  return { headers: { 'anthropic-beta': OAUTH_BETA, Authorization: `Bearer ${auth.token}` } }
}

export function needsRefresh(credential: Credential, now: number): boolean {
  return credential.claudeAiOauth.expiresAt - EXPIRY_MARGIN_MS <= now
}

export function refreshInit(credential: Credential): HttpInit {
  const oauth = credential.claudeAiOauth

  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (oauth.scopes ?? []).join(' '),
    }),
  }
}

/** The credential after a refresh; the server rotates the refresh token, so it must be saved. */
export function applyRefresh(credential: Credential, responseText: string, now: number): Credential {
  const body = JSON.parse(responseText) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new AnthropicError('token refresh returned no access token')
  }
  const oauth = credential.claudeAiOauth

  return {
    ...credential,
    claudeAiOauth: {
      ...oauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? oauth.refreshToken,
      expiresAt: now + body.expires_in * 1000,
    },
  }
}

/** Whose a token is, as the profile endpoint answers. */
export type TokenOwner = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string
}

export function parseProfile(text: string): TokenOwner {
  const body = JSON.parse(text) as {
    account?: { uuid?: string; email?: string }
    organization?: { uuid?: string; name?: string }
  }
  if (typeof body.account?.uuid !== 'string' || typeof body.account.email !== 'string') {
    throw new AnthropicError('profile endpoint named no account')
  }
  // The id names a keychain item and a vault file: one that could reach elsewhere is no account.
  if (!isAccountId(body.account.uuid)) throw new AnthropicError(`profile endpoint named an account id this mod cannot file: ${JSON.stringify(body.account.uuid)}`)

  return {
    accountUuid: body.account.uuid,
    emailAddress: body.account.email,
    organizationUuid: body.organization?.uuid,
    organizationName: body.organization?.name,
  }
}

/**
 * The reading after a failed lookup. A 429 keeps the previous reading as it
 * was, only marked stale: the next lookup recovers by itself, so it is no
 * message the person must read. Any other failure is said in words.
 */
export function failedReading(previous: UsageView | undefined, error: unknown, now: number, m: Messages): UsageView {
  const kept = isLookedUp(previous) ? previous : undefined
  // The spend kept is the last lookup's too, as the limits are.
  const spend = kept?.spend ? { spend: kept.spend } : {}
  if (error instanceof AnthropicError && error.status === 429) {
    return { limits: kept?.limits ?? [], fetchedAt: kept?.fetchedAt ?? now, isStale: true, source: 'lookup', ...spend }
  }

  // The limits kept are the last lookup's, and so is the time they were looked up.
  return { limits: kept?.limits ?? [], fetchedAt: kept?.fetchedAt ?? now, error: describeFailure(error, m), source: 'lookup', ...spend }
}

/**
 * The reading of an inactive account whose token Orca keeps and this mod does
 * not refresh: the last lookup's figures and time stay, marked held, and no
 * error is said, as nothing failed.
 */
export function heldReading(previous: UsageView | undefined, now: number): UsageView {
  const kept = isLookedUp(previous) ? previous : undefined

  return { limits: kept?.limits ?? [], fetchedAt: kept?.fetchedAt ?? now, isHeld: true, source: 'lookup', ...(kept?.spend ? { spend: kept.spend } : {}) }
}

/** Whether a reading came from its own account's lookup, the one source trusted for its figures. */
export function isLookedUp(reading: UsageView | undefined): reading is UsageView {
  return reading?.source === 'lookup'
}

/** The readings that came from lookups; whatever else a store or a session held is dropped. */
export function lookedUpOnly(readings: unknown): Record<string, UsageView> {
  if (!readings || typeof readings !== 'object') return {}

  return Object.fromEntries(Object.entries(readings as Record<string, UsageView>).filter(([, reading]) => isLookedUp(reading)))
}

/** One window as Claude Code's own response reported it. */
export type MeasuredWindow = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The reading after Claude Code's own response reported its windows: the
 * five-hour and weekly figures replaced, every other window (a model's
 * weekly limit, which responses do not carry) kept from the last lookup.
 * Only for a response the account in question answered.
 */
export function withMeasured(previous: UsageView | undefined, windows: MeasuredWindow[], now: number): UsageView {
  const measured: LimitView[] = windows.flatMap(window => {
    if (window.kind === 'five_hour') return [{ label: '5h', percent: window.percentUsed, resetsAt: window.resetsAt }]
    if (window.kind === 'seven_day') return [{ label: 'wk', percent: window.percentUsed, resetsAt: window.resetsAt }]

    return []
  })
  const labels = new Set(measured.map(limit => limit.label))
  const kept = (isLookedUp(previous) ? previous.limits : []).filter(limit => !labels.has(limit.label))

  // A measured window says nothing of spending: the last lookup's spend stays.
  const spend = isLookedUp(previous) && previous.spend ? { spend: previous.spend } : {}

  return { limits: [...measured, ...kept], fetchedAt: now, source: 'lookup', ...spend }
}

/** A failure as the pane shows it. */
export function describeFailure(error: unknown, m: Messages): string {
  if (error instanceof AnthropicError && (error.status === 400 || error.status === 401)) return m.authExpired
  if (error instanceof AnthropicError && error.status !== undefined) return m.serverError(error.status)

  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the configured account's saved login may be put back in place of a
 * rejected one: there is one, it is not the token rejected, it works without a
 * refresh (several sessions refreshing it at once would spend it), and this
 * session did not put one back within `gapMs`.
 */
export function mayHeal(saved: Credential | null, rejected: Credential, now: number, healedAt: number, gapMs: number): saved is Credential {
  if (saved === null || now - healedAt < gapMs) return false

  return saved.claudeAiOauth.accessToken !== rejected.claudeAiOauth.accessToken && !needsRefresh(saved, now)
}
