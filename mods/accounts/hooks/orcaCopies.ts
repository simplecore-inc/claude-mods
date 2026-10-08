import { oauthAccountKey, organizationOf } from './accounts'
import type { AccountsContext } from './accounts'
import { AnthropicError } from './anthropic'
import { REFRESH_TIMEOUT_MS, readVault, refreshOrcaCopy } from './credentials'
import type { OauthAccount } from './credentials'
import { message } from './io'
import { orcaAccountFor } from './orca'
import type { OrcaClaude } from './orca'

/**
 * Keeps Orca's copies of the saved logins from expiring. Orca writes the copy
 * of the account selected in it as it is while a Claude terminal runs there,
 * expired or not, and every running session then refreshes the same refresh
 * token at once: all but the first are signed out. So each copy is refreshed
 * here before it expires, this mod's copy with it.
 */

/** How long before it expires a copy Orca keeps is refreshed: more than the few minutes between two checks of Orca. */
export const ORCA_COPY_MARGIN_MS = 60 * 60 * 1000
/** The `$.store` key of the copies that could not be refreshed, by account: the expiry of the grant that failed. */
const FAILED_KEY = 'orcaCopyFailed'

/**
 * Refreshes Orca's copy of each saved account that expires soon. The live
 * login is Claude Code's to refresh and the one Orca has selected is Orca's,
 * so both are left alone. A copy the server refused is not tried again until
 * it changes, and is said once; a refresh that could not be asked is tried at
 * the next check.
 */
export async function keepOrcaCopiesFresh(ctx: AccountsContext, claude: OrcaClaude): Promise<void> {
  const { io } = ctx
  const m = ctx.messages()
  const liveUuid = await ctx.live.get()
  const failed = ((await io.store.get(FAILED_KEY)) ?? {}) as Record<string, number>
  for (const account of await ctx.accounts.get()) {
    if (account.uuid === liveUuid) continue
    const details = (await io.store.get(oauthAccountKey(account.uuid))) as OauthAccount | undefined
    const kept = orcaAccountFor(claude, account.email, organizationOf(details))
    if (!kept || kept.id === claude.activeId) continue
    const saved = await readVault(io, account.uuid).catch(() => null)
    if (saved === null || failed[account.uuid] === saved.claudeAiOauth.expiresAt) continue
    try {
      if ((await refreshOrcaCopy(io, account.uuid, kept.id, ORCA_COPY_MARGIN_MS, m.refreshNoAnswer(REFRESH_TIMEOUT_MS / 1000))) === 'refreshed') {
        io.log(`refreshed the login Orca keeps for ${account.email}`)
      }
    } catch (error) {
      io.log(`the login Orca keeps for ${account.email} could not be refreshed: ${message(error)}`)
      if (!(error instanceof AnthropicError) || error.status === undefined || error.status >= 500) continue
      await io.store.set(FAILED_KEY, { ...failed, [account.uuid]: saved.claudeAiOauth.expiresAt })
      ctx.toast(m.orcaCopyRefused(account.email))
    }
  }
}
