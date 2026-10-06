import type { UsageView } from '../types'
import { USAGE_KEY, changeIndex, exclusive, noteInstalled, oauthAccountKey, organizationOf, recordChange, syncLive } from './accounts'
import type { AccountsContext } from './accounts'
import { lookedUpOnly } from './anthropic'
import { REFRESH_TIMEOUT_MS, deleteVault, ensureFresh, liveOauthAccount, readLiveCredential, readVault, writeLiveFile, writeLiveKeychain, writeLiveOauthAccount } from './credentials'
import type { OauthAccount } from './credentials'
import type { Io } from './io'
import { message } from './io'
import type { Credential } from './keychain'
import { planSwitch } from './orca'
import type { OrcaPlan } from './orca'
import { dropPending, keepPending, orcaClaude, orcaSelect, rememberedOrca } from './orcaClient'

/**
 * Changing the saved accounts on purpose: switching the login Claude Code
 * uses, Orca's with it, and removing an account.
 */

/** Makes a saved account the one Claude Code logs in with, and Orca's too when Orca keeps the Claude logins here. */
export async function switchTo(ctx: AccountsContext, uuid: string, via: 'dialog' | 'command'): Promise<string> {
  const { io } = ctx
  const m = ctx.messages()
  const target = (await ctx.accounts.get()).find(one => one.uuid === uuid)
  if (!target) throw new Error('no saved account with that id')
  const details = (await io.store.get(oauthAccountKey(uuid))) as OauthAccount | undefined
  const plan = planSwitch(await orcaClaude(io, m), await rememberedOrca(io), target.email, organizationOf(details))
  // Orca writes another login and keeps none for this account: it would put its own back at its next write.
  if (plan.kind === 'refuse') throw new Error(m.orcaLacksAccount(target.email, plan.activeEmail ?? '?'))
  const fromUuid = await ctx.live.get()
  const change = { kind: 'switch' as const, via, orca: plan.kind, from: (await ctx.accounts.get()).find(one => one.uuid === fromUuid)?.email ?? null, to: target.email }
  // Recorded first, so every session that finds the login changed knows this switch made it.
  await recordChange(ctx, change)
  try {
    // Written here first, even where Orca writes it next: Orca takes the fresher of its copy and this one.
    await exclusive(() => installLogin(ctx, uuid, target.email))
  } catch (error) {
    // Said in the record too, so no session takes a change to this account for this switch's.
    await recordChange(ctx, { ...change, failed: true })
    throw error
  }
  return bringOrca(ctx, plan, target.email)
}

/**
 * Files the outgoing login and writes the saved one in its place: the
 * keychain item, then the config's account, then the credentials file. A write
 * that fails puts back what was there, so Claude Code never holds one
 * account's token under another's name.
 */
async function installLogin(ctx: AccountsContext, uuid: string, email: string): Promise<void> {
  const { io } = ctx
  // File the outgoing login first: Claude Code may have rotated its tokens.
  await syncLive(ctx)
  const credential = await readVault(io, uuid)
  const account = (await io.store.get(oauthAccountKey(uuid))) as OauthAccount | undefined
  if (credential === null || !account) throw new Error(`${email}: ${ctx.messages().noStoredLogin}`)
  const before = { credential: await readLiveCredential(io), account: await liveOauthAccount(io).catch(() => null) }
  const fresh = await ensureFresh(io, uuid, credential, before.credential, ctx.messages().refreshNoAnswer(REFRESH_TIMEOUT_MS / 1000))
  try {
    await writeLiveKeychain(io, fresh)
    await writeLiveOauthAccount(io, account)
    // Last, so a session that notices the change finds everything already in place.
    await writeLiveFile(io, fresh)
  } catch (error) {
    await putBack(io, before).catch((putBackError: unknown) => io.log(`a failed switch could not put the login back: ${message(putBackError)}`))
    throw error
  }
  noteInstalled(uuid, fresh.claudeAiOauth.accessToken, await io.now())
  await ctx.live.set(uuid)
}

/** Writes back the login that stood before a switch that failed half way. */
async function putBack(io: Io, before: { credential: Credential | null; account: OauthAccount | null }): Promise<void> {
  if (before.credential) {
    await writeLiveKeychain(io, before.credential)
    await writeLiveFile(io, before.credential)
  }
  await writeLiveOauthAccount(io, before.account)
}

/** Brings Orca to the account just switched to, as the plan says, and words what came of it. */
async function bringOrca(ctx: AccountsContext, plan: OrcaPlan, email: string): Promise<string> {
  const { io } = ctx
  const m = ctx.messages()
  if (plan.kind === 'select') {
    try {
      await orcaSelect(io, m, plan.account.id)
      await dropPending(io)

      return m.switchedWithOrca(email)
    } catch (error) {
      // Tried again at each tick, and when Orca next writes another login.
      await keepPending(io, plan.account, plan.activeId)

      return m.switchedOrcaFailed(email, message(error))
    }
  }
  if (plan.kind === 'pending') {
    await keepPending(io, plan.account, plan.activeId)

    return m.switchedOrcaPending(email)
  }
  // Nothing waits for Orca now: it leaves the login alone, or keeps no copy of this one.
  await dropPending(io)

  return plan.kind === 'warn' ? m.switchedOrcaWillRevert(email, plan.activeEmail ?? '?') : m.switched(email)
}

/** Removes a saved account: its saved login and details, and its figures from every session's readings. */
export async function remove(ctx: AccountsContext, uuid: string): Promise<string> {
  const { io } = ctx
  const m = ctx.messages()
  const target = (await ctx.accounts.get()).find(one => one.uuid === uuid)
  // The login Claude Code uses now, as well as this session's: another session may have just switched to it.
  if ((await ctx.live.get()) === uuid || (await liveOauthAccount(io).catch(() => null))?.accountUuid === uuid) throw new Error(m.cannotRemoveLive)
  await deleteVault(io, uuid)
  await io.store.delete(oauthAccountKey(uuid))
  await changeIndex(ctx, list => list.filter(one => one.uuid !== uuid))
  const drop = (map: Record<string, UsageView>) => {
    const { [uuid]: _dropped, ...rest } = map

    return rest
  }
  await ctx.usage.update(drop)
  // And from the readings every session shares, or another session would show it again.
  await io.store.set(USAGE_KEY, drop(lookedUpOnly(await io.store.get(USAGE_KEY))))

  return m.removed(target?.email ?? uuid)
}
