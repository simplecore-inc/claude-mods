import type { AccountView, UsageView } from '../types'
import { PROFILE_URL, mayHeal, parseProfile, usageInit } from './anthropic'
import {
  claudeDirectory,
  keepCredentialFileInStep,
  liveCredentialPath,
  liveOauthAccount,
  platformOf,
  readLiveCredential,
  readVault,
  writeLiveFile,
  writeLiveKeychain,
  writeVault,
} from './credentials'
import type { OauthAccount } from './credentials'
import type { Messages } from './i18n'
import type { Cell, Io } from './io'
import { message, within } from './io'
import { isOlderGrant } from './keychain'
import type { Credential } from './keychain'
import { withLock } from './lock'
import { pendingStep, planFollow } from './orca'
import type { OrcaClaude } from './orca'
import { isOrcaCheckDue, orcaClaude, orcaSelect, returnPending, takePending } from './orcaClient'
import { serialQueue } from './queue'
import { isOwnSwitch, parseChanges, withChange } from './switchlog'
import type { LoginChange } from './switchlog'
import { writeAtomic } from './writes'

/**
 * The saved accounts and the login Claude Code uses: reading the live login
 * and filing it, putting a rejected login back, and saying who changed the
 * login, Orca included; switching and removing are in `switching.ts`. What the
 * session's state holds
 * is reached through the context the hooks module builds.
 */

/** What the account work reads and writes beyond the machine: the session's state, its toasts and its words. */
export type AccountsContext = {
  io: Io
  accounts: Cell<AccountView[]>
  live: Cell<string | null>
  usage: { get: () => Promise<Record<string, UsageView>>; update: (change: (map: Record<string, UsageView>) => Record<string, UsageView>) => Promise<void> }
  isRefreshing: Cell<boolean>
  toast: (text: string) => void
  messages: () => Messages
  session: { id: () => string; cwd: () => Promise<string>; version: () => string }
}

export const USAGE_KEY = 'usage'
const INDEX_KEY = 'accounts'
export const oauthAccountKey = (uuid: string) => `oauthAccount:${uuid}`
/** The `$.store` key of the session selecting in Orca a login changed outside it, so the others leave it to that one. */
const ORCA_FOLLOW_KEY = 'orcaFollow'
const ORCA_FOLLOW_CLAIM_MS = 60 * 1000
/** How long a change of the login stands before it is explained: Orca writes a login in steps over a few seconds, passing through another. */
const SETTLE_MS = 10_000
/** How long the profile endpoint may take to say whose a token is. */
const PROFILE_TIMEOUT_MS = 15_000
/** How long after putting a login back this session leaves a login rejected again alone, so two writers never loop. */
const HEAL_GAP_MS = 60 * 1000
/** How long Claude Code keeps a keychain login cached when no credentials file tells it of a change. */
const KEYCHAIN_CACHE_MS = 35 * 1000
/** This mod's lock over the change record, which every session writes. */
const CHANGES_LOCK = { staleMs: 10_000, tries: 12 }

/**
 * A switch and each account's token work run one at a time in this session:
 * a lookup refreshing an account's token while a switch makes it the live
 * login would refresh it twice with one refresh token.
 */
export const exclusive = serialQueue()

/** When this session last saw the live account change, by a switch or a login. */
let liveChangedAt = 0
/** Whose the live token is, as the last read found: a lookup of the live account checks the token it sends is still this one. */
let liveOwner: { accessToken: string; uuid: string } | null = null
/** The live account this session last said or took up: a change that settles back to it was a passing write, said to nobody. */
let announcedLive: string | null = null
/** The changes of the login this session has found, counted, so only the latest one's settling is explained. */
let changeCount = 0
let healedAt = 0
/** The read of the live login in progress, which every caller meanwhile shares: two at once would file one token twice. */
let syncing: Promise<string | null> | null = null

/** Takes up a login this session wrote itself: a later change away from it, Orca's included, is one to explain. */
export function noteInstalled(uuid: string, accessToken: string, at: number): void {
  liveChangedAt = at
  liveOwner = { accessToken, uuid }
  announcedLive = uuid
}

export function lastLiveChange(): number {
  return liveChangedAt
}

/**
 * The account a host signed this session in with, when it did: the desktop
 * app runs its Claude Code sessions on the app's own login and names it in
 * `CLAUDE_CODE_ACCOUNT_UUID`, whatever Claude Code's login on this machine
 * (the live account) is. Null where Claude Code signs itself in.
 */
export async function hostAccount(io: Io): Promise<{ uuid: string; email: string | null } | null> {
  const uuid = (await io.env('CLAUDE_CODE_ACCOUNT_UUID'))?.trim() ?? ''
  if (uuid === '') return null
  const email = (await io.env('CLAUDE_CODE_USER_EMAIL'))?.trim() ?? ''

  return { uuid, email: email === '' ? null : email }
}

/** The account this session's requests go out under: the host's, else the live account. */
export async function sessionAccount(ctx: AccountsContext): Promise<string | null> {
  return (await hostAccount(ctx.io))?.uuid ?? ctx.live.get()
}

/** Whether the live login is still the token the last read filed under `uuid`. */
export function isLiveTokenOf(credential: Credential, uuid: string): boolean {
  return liveOwner?.uuid === uuid && liveOwner.accessToken === credential.claudeAiOauth.accessToken
}

/** The organization of a login's details, as Orca matches accounts by it too; null when the details name none. */
export function organizationOf(account: OauthAccount | undefined): string | null {
  return typeof account?.organizationUuid === 'string' && account.organizationUuid !== '' ? account.organizationUuid : null
}

/**
 * The saved accounts: the list the store holds, with every account it lost
 * put back. An account is saved when both its details (`oauthAccount:<id>`)
 * and its credential are kept, so a session running an older build that wrote
 * back a shorter list cannot drop one; removing an account deletes both.
 */
async function storedIndex(ctx: AccountsContext): Promise<AccountView[]> {
  const { io } = ctx
  const stored = await io.store.get(INDEX_KEY)
  const list = Array.isArray(stored) ? (stored as AccountView[]) : []
  const listed = new Set(list.map(one => one.uuid))
  const lost: AccountView[] = []
  for (const key of await io.store.keys()) {
    if (!key.startsWith('oauthAccount:')) continue
    const uuid = key.slice('oauthAccount:'.length)
    if (listed.has(uuid)) continue
    const account = (await io.store.get(key)) as OauthAccount | undefined
    const credential = account ? await readVault(io, uuid).catch(() => null) : null
    if (!account || !credential) continue
    lost.push({ uuid, email: account.emailAddress, organizationName: account.organizationName, subscriptionType: credential.claudeAiOauth.subscriptionType, savedAt: 0 })
  }

  return [...list, ...lost.sort((a, b) => a.email.localeCompare(b.email))]
}

/**
 * Changes the saved accounts. The change is applied to the list the store
 * holds now, never to this session's copy: a session that has not loaded the
 * list yet, or holds an older one, would otherwise write back only the
 * accounts it knows and drop the rest.
 */
export async function changeIndex(ctx: AccountsContext, change: (list: AccountView[]) => AccountView[]): Promise<AccountView[]> {
  const list = change(await storedIndex(ctx))
  await ctx.io.store.set(INDEX_KEY, list)
  await ctx.accounts.set(list)

  return list
}

export async function loadIndex(ctx: AccountsContext): Promise<void> {
  await ctx.accounts.set(await storedIndex(ctx))
}

/** The ids of the accounts saved now, as the list every session shares holds them: one another session removed is not among them, whatever this session still shows. */
export async function savedIds(ctx: AccountsContext): Promise<Set<string>> {
  return new Set((await storedIndex(ctx)).map(one => one.uuid))
}

/**
 * Whose login a token is, as the profile endpoint answers: the account;
 * `rejected` when the token is empty or the endpoint refuses it (401, 403),
 * so it can never work again; `unknown` when no answer came (offline, 5xx,
 * no answer within its time).
 */
async function tokenCheck(ctx: AccountsContext, credential: Credential): Promise<OauthAccount | 'rejected' | 'unknown'> {
  if (credential.claudeAiOauth.accessToken === '') return 'rejected'
  try {
    const response = await within(ctx.io, ctx.io.fetch(PROFILE_URL, usageInit({ token: credential.claudeAiOauth.accessToken })), PROFILE_TIMEOUT_MS, ctx.messages().profileNoAnswer(PROFILE_TIMEOUT_MS / 1000))
    if (response.status === 401 || response.status === 403) return 'rejected'
    if (!response.ok) return 'unknown'

    return parseProfile(response.text)
  } catch (error) {
    ctx.io.log(message(error))

    return 'unknown'
  }
}

/**
 * Reads the login Claude Code uses now and files it in the vault: a new
 * account is added, a known one gets the credential Claude Code last
 * refreshed. A copy older than the one saved for its account (another grant
 * that expires sooner) is used but never filed over the newer one.
 *
 * @returns the live account's uuid, or null with no Claude login
 */
export async function syncLive(ctx: AccountsContext): Promise<string | null> {
  syncing ??= syncLiveOnce(ctx).finally(() => {
    syncing = null
  })

  return syncing
}

async function syncLiveOnce(ctx: AccountsContext): Promise<string | null> {
  const { io } = ctx
  const [configured, credential] = await Promise.all([liveOauthAccount(io), readLiveCredential(io)])
  if (configured === null || credential === null) {
    liveOwner = null
    await ctx.live.set(null)

    return null
  }
  await keepCredentialFileInStep(io, credential)

  let account = configured
  const stored = await readVault(io, configured.accountUuid)
  if (JSON.stringify(stored) !== JSON.stringify(credential)) {
    // The token changed: ask whose it is. During a login the config and the
    // keychain can name different accounts for a moment, and filing a token
    // under the wrong account would show one account's usage as another's.
    const check = await tokenCheck(ctx, credential)
    // Rejected: a login written into Claude Code that can never work again, its refresh token spent elsewhere.
    if (check === 'rejected') return healLogin(ctx, configured, credential)
    if (check === 'unknown') return ctx.live.get()
    account = check.accountUuid === configured.accountUuid ? configured : (((await io.store.get(oauthAccountKey(check.accountUuid))) as OauthAccount | undefined) ?? check)
    const saved = account.accountUuid === configured.accountUuid ? stored : await readVault(io, account.accountUuid)
    if (!isOlderGrant(credential, saved)) await writeVault(io, account.accountUuid, credential)
  }
  liveOwner = { accessToken: credential.claudeAiOauth.accessToken, uuid: account.accountUuid }
  const previous = await ctx.live.get()
  if (previous !== account.accountUuid) {
    liveChangedAt = await io.now()
    if (previous !== null) await noteChange(ctx, previous, account)
    else announcedLive ??= account.accountUuid
  }
  await ctx.live.set(account.accountUuid)
  await io.store.set(oauthAccountKey(account.accountUuid), account)

  const now = await io.now()
  let isNew = false
  await changeIndex(ctx, list => {
    const known = list.find(one => one.uuid === account.accountUuid)
    const view: AccountView = {
      uuid: account.accountUuid,
      email: account.emailAddress,
      organizationName: account.organizationName,
      subscriptionType: credential.claudeAiOauth.subscriptionType,
      savedAt: known?.savedAt ?? now,
    }
    isNew = known === undefined

    return known ? list.map(one => (one.uuid === view.uuid ? view : one)) : [...list, view]
  })
  if (isNew) ctx.toast(ctx.messages().saved(account.emailAddress))

  return account.accountUuid
}

/**
 * Puts the configured account's saved login back when the one Claude Code
 * holds was rejected: a login written into Claude Code whose refresh token was
 * already spent elsewhere. Only a saved login that works as it is: one that
 * needs refreshing is left to /login, as several sessions refreshing it at
 * once would spend it too.
 *
 * @returns the live account's uuid, or the one shown when nothing was put back
 */
async function healLogin(ctx: AccountsContext, configured: OauthAccount, rejected: Credential): Promise<string | null> {
  const { io } = ctx
  const now = await io.now()
  const saved = await readVault(io, configured.accountUuid)
  if (!mayHeal(saved, rejected, now, healedAt, HEAL_GAP_MS)) return ctx.live.get()
  const check = await tokenCheck(ctx, saved)
  if (typeof check === 'string' || check.accountUuid !== configured.accountUuid) return ctx.live.get()
  healedAt = now
  await recordChange(ctx, { kind: 'heal', from: null, to: configured.emailAddress })
  await writeLiveKeychain(io, saved)
  await writeLiveFile(io, saved)
  liveChangedAt = now
  liveOwner = { accessToken: saved.claudeAiOauth.accessToken, uuid: configured.accountUuid }
  await ctx.live.set(configured.accountUuid)
  ctx.toast(ctx.messages().loginHealed(configured.emailAddress))

  return configured.accountUuid
}

/** The file that records every change of the live login, this mod's switches and the ones from outside it. */
async function changesPath(io: Io): Promise<string> {
  return `${await claudeDirectory(io)}/sc-accounts/login-changes.jsonl`
}

async function readChanges(io: Io): Promise<string> {
  const path = await changesPath(io)

  return (await io.exists(path)) ? io.read(path) : ''
}

/**
 * Adds a change to the record. Every session writes it, so the record is read
 * and written whole under a lock of its own, and replaced at once: a line
 * written by another session at the same moment is never lost. A record that
 * cannot be written never stops a switch.
 */
export async function recordChange(ctx: AccountsContext, change: Omit<LoginChange, 'at' | 'session' | 'cwd' | 'version'>): Promise<void> {
  const { io } = ctx
  try {
    const full: LoginChange = { at: await io.now(), session: ctx.session.id(), cwd: await ctx.session.cwd(), version: ctx.session.version(), ...change }
    const path = await changesPath(io)
    const { isWindows } = await platformOf(io)
    await withLock(io, `${path}.lock`, { ...CHANGES_LOCK, isWindows }, async () => {
      await writeAtomic(io, path, withChange(await readChanges(io), full), { isPrivate: false, isWindows })
    })
  } catch (error) {
    io.log(message(error))
  }
}

/**
 * A change of the live login this session found. A switch, heal or Orca
 * selection of this mod's, in any session, says nothing; any other change is
 * explained once the login has stood still for `SETTLE_MS`, so writes that pass
 * through another login on their way back say nothing either.
 */
async function noteChange(ctx: AccountsContext, previousUuid: string, account: OauthAccount): Promise<void> {
  announcedLive ??= previousUuid
  if (isOwnSwitch(parseChanges(await readChanges(ctx.io)), account.emailAddress, await ctx.io.now())) {
    announcedLive = account.accountUuid

    return
  }
  changeCount += 1
  const count = changeCount
  ctx.io.after(SETTLE_MS, () => {
    if (count === changeCount) void settleChange(ctx).catch((error: unknown) => ctx.io.log(message(error)))
  })
}

/** Explains a change of the login once it has stood still: who made it, and what Orca does about it. */
async function settleChange(ctx: AccountsContext): Promise<void> {
  const count = changeCount
  const liveUuid = await syncLive(ctx)
  // Another change came meanwhile, and its own settling explains both; or the login is back where it was.
  if (count !== changeCount || liveUuid === null || liveUuid === announcedLive) return
  const from = (await ctx.accounts.get()).find(one => one.uuid === announcedLive)?.email ?? null
  announcedLive = liveUuid
  const account = (await ctx.io.store.get(oauthAccountKey(liveUuid))) as OauthAccount | undefined
  if (!account || isOwnSwitch(parseChanges(await readChanges(ctx.io)), account.emailAddress, await ctx.io.now())) return
  await explainChange(ctx, from, account)
}

/** Records and says who changed the login, and has Orca keep a login changed outside it rather than put its own back. */
async function explainChange(ctx: AccountsContext, from: string | null, to: OauthAccount): Promise<void> {
  const m = ctx.messages()
  const reach = await orcaClaude(ctx.io, m)
  const claude = reach.kind === 'ok' ? reach.claude : null
  // Orca has just started and put back the login it wrote before, over the one a switch chose while it was closed.
  if (claude && (await applyPendingOrca(ctx, claude))) return
  const plan = planFollow(claude, to.emailAddress, organizationOf(to))
  if (plan.kind === 'orca') {
    await recordChange(ctx, { kind: 'orca', from, to: to.emailAddress })
    ctx.toast(m.loginChangedByOrca(from ?? '?', to.emailAddress))

    return
  }
  if (plan.kind === 'follow') {
    // Another session found the same change a moment ago and is selecting it in Orca.
    if (!(await claimFollow(ctx.io, to.emailAddress))) return
    await recordChange(ctx, { kind: 'follow', from, to: to.emailAddress })
    try {
      await orcaSelect(ctx.io, m, plan.account.id)
      ctx.toast(m.orcaFollowed(to.emailAddress))
    } catch (error) {
      ctx.toast(m.orcaFollowFailed(to.emailAddress, message(error)))
    }

    return
  }
  await recordChange(ctx, { kind: 'outside', from, to: to.emailAddress })
  ctx.toast(plan.kind === 'revert' ? m.orcaWillRevert(to.emailAddress, plan.activeEmail ?? '?') : m.loginChangedOutside(from ?? '?', to.emailAddress))
}

/** Takes, for this session, selecting a login in Orca, unless another session took the same one within a minute. */
async function claimFollow(io: Io, email: string): Promise<boolean> {
  const now = await io.now()
  const claim = (await io.store.get(ORCA_FOLLOW_KEY)) as { email?: unknown; at?: unknown } | undefined
  if (claim?.email === email && typeof claim.at === 'number' && now - claim.at < ORCA_FOLLOW_CLAIM_MS) return false
  await io.store.set(ORCA_FOLLOW_KEY, { email, at: now })

  return true
}

/** Selects in Orca the account a switch chose while Orca was not running; true when it was asked to. */
async function applyPendingOrca(ctx: AccountsContext, claude: OrcaClaude): Promise<boolean> {
  const { io } = ctx
  const pending = await takePending(io)
  if (!pending || pendingStep(pending, claude, await io.now()) !== 'apply') return false
  await recordChange(ctx, { kind: 'follow', from: claude.accounts.find(account => account.id === claude.activeId)?.email ?? null, to: pending.email })
  try {
    await orcaSelect(io, ctx.messages(), pending.accountId)
    ctx.toast(ctx.messages().orcaAppliedPending(pending.email))
  } catch (error) {
    await returnPending(io, pending)
    io.log(message(error))
  }

  return true
}

/**
 * Keeps what Orca says current, machine-wide every few minutes, and makes a
 * selection that waits for Orca once it answers.
 *
 * @returns what Orca said, when it was asked now and answered; null otherwise
 */
export async function tickOrca(ctx: AccountsContext): Promise<OrcaClaude | null> {
  if (!(await isOrcaCheckDue(ctx.io))) return null
  const reach = await orcaClaude(ctx.io, ctx.messages())
  if (reach.kind !== 'ok') return null
  await applyPendingOrca(ctx, reach.claude)

  return reach.claude
}

/**
 * From when a response's figures are the live account's: the moment it last
 * changed, and on macOS without a credentials file, the keychain cache after
 * it, during which a running session may still ask with the previous login.
 */
export async function figuresTrustedFrom(io: Io): Promise<number> {
  const cached = (await platformOf(io)).backend === 'keychain' && !(await io.exists(await liveCredentialPath(io)))

  return liveChangedAt + (cached ? KEYCHAIN_CACHE_MS : 0)
}
