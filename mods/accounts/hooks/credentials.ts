import type { HttpResponse } from 'claude-code'

import { AnthropicError, TOKEN_URL, applyRefresh, needsRefresh, refreshInit } from './anthropic'
import type { Io } from './io'
import { message, within } from './io'
import {
  ITEM_NOT_FOUND,
  KeychainError,
  ORCA_COPY_SERVICE,
  VAULT_SERVICE,
  addLine,
  credentialsDirectory,
  deleteArgv,
  fileLagsKeychain,
  findArgv,
  isAccountId,
  isSameGrant,
  keychainAccountName,
  liveServiceName,
  parseCredential,
} from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { withLock } from './lock'
import { deleteFileArgv, detectPlatform, vaultFilePath } from './platform'
import type { Platform } from './platform'
import { writeAtomic } from './writes'

/**
 * Where the logins live: the one Claude Code uses (its keychain item on macOS,
 * `.credentials.json` elsewhere, and `oauthAccount` in its global config), the
 * saved ones (the vault: keychain items, or owner-only files), and the
 * webhook's token. Every write to a file or item Claude Code also writes takes
 * Claude Code's own lock for it first, and every file is replaced whole.
 */

/** The `oauthAccount` object Claude Code keeps in its global config, kept whole. */
export type OauthAccount = {
  accountUuid: string
  emailAddress: string
  organizationName?: string
  [field: string]: unknown
}

/** Directory under Claude Code's config directory holding saved logins on the file backend. */
const VAULT_DIRECTORY = 'account-switch'
/** Where the webhook's bearer token is kept: its own keychain service, or an owner-only file. */
const WEBHOOK_SERVICE = 'sc-webhook'
const WEBHOOK_TOKEN_ACCOUNT = 'token'
/** Claude Code's lock over its login store (`.storage-write`), stale as its own is after 15 s. */
const STORAGE_LOCK = { staleMs: 15_000, tries: 12 }
/** Claude Code's lock over its global config (`.claude.json.lock`), stale as proper-lockfile's default after 10 s. */
const CONFIG_LOCK = { staleMs: 10_000, tries: 12 }
/** This mod's lock over one saved account's refresh, held across sessions. */
const REFRESH_LOCK = { staleMs: 60_000, tries: 20 }
/** How long a token refresh may take, as Claude Code allows its own. */
export const REFRESH_TIMEOUT_MS = 30_000

let platformCache: Platform | undefined

export async function platformOf(io: Io): Promise<Platform> {
  if (platformCache) return platformCache
  const osVariable = await io.env('OS')
  let kernelName: string | undefined
  if (osVariable !== 'Windows_NT') {
    try {
      const uname = await io.run(['uname', '-s'], { timeoutMs: 5000 })
      kernelName = uname.exitCode === 0 ? uname.stdout : undefined
    } catch (error) {
      io.log(`uname: ${message(error)}`)
    }
  }
  platformCache = detectPlatform(osVariable, kernelName)

  return platformCache
}

/** `HOME`, or `USERPROFILE` on Windows. */
export async function homeDirectory(io: Io): Promise<string> {
  const home = (await io.env('HOME')) || (await io.env('USERPROFILE'))
  if (!home) throw new Error('neither HOME nor USERPROFILE is set')

  return home.replaceAll('\\', '/')
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export async function claudeDirectory(io: Io): Promise<string> {
  return (await io.env('CLAUDE_CONFIG_DIR')) || `${await homeDirectory(io)}/.claude`
}

export async function globalConfigPath(io: Io): Promise<string> {
  const configDir = await io.env('CLAUDE_CONFIG_DIR')

  return configDir ? `${configDir}/.claude.json` : `${await homeDirectory(io)}/.claude.json`
}

/** The environment variables that decide where Claude Code keeps its login. */
async function storageVariables(io: Io): Promise<StorageVariables> {
  return { configDir: await io.env('CLAUDE_CONFIG_DIR'), secureStorageDir: await io.env('CLAUDE_SECURESTORAGE_CONFIG_DIR') }
}

/** The folder Claude Code keeps `.credentials.json` and its login store's lock in. */
async function storageDirectory(io: Io): Promise<string> {
  return credentialsDirectory(await storageVariables(io), `${await homeDirectory(io)}/.claude`)
}

/** `.credentials.json`: Claude Code's login on the file backend, and its plaintext copy on macOS. */
export async function liveCredentialPath(io: Io): Promise<string> {
  return `${await storageDirectory(io)}/.credentials.json`
}

/** The keychain item Claude Code reads its login from, as it names it for this session's environment; read once. */
let liveItemCache: { service: string; account: string } | undefined

async function liveItem(io: Io): Promise<{ service: string; account: string }> {
  liveItemCache ??= {
    service: await liveServiceName(await storageVariables(io), `${await homeDirectory(io)}/.claude`),
    account: keychainAccountName(await io.env('USER')),
  }

  return liveItemCache
}

async function readIfPresent(io: Io, path: string): Promise<string | null> {
  return (await io.exists(path)) ? io.read(path) : null
}

async function findSecret(io: Io, service: string, account?: string): Promise<string | null> {
  const { exitCode, stdout, stderr } = await io.run(findArgv(service, account), { timeoutMs: 5000 })
  if (exitCode === ITEM_NOT_FOUND) return null
  if (exitCode !== 0) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)

  return stdout
}

async function storeSecret(io: Io, service: string, account: string, text: string): Promise<void> {
  const { exitCode, stderr } = await io.run(['security', '-i'], { stdin: addLine(service, account, text), timeoutMs: 5000 })
  if (exitCode !== 0) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
}

/** Runs `work` holding Claude Code's own lock over its login store, as its writes do. */
async function underStorageLock<T>(io: Io, work: () => Promise<T>): Promise<T> {
  const { isWindows } = await platformOf(io)

  return withLock(io, `${await storageDirectory(io)}/.storage-write.lock`, { ...STORAGE_LOCK, isWindows }, work)
}

/** The login Claude Code uses now. */
export async function readLiveCredential(io: Io): Promise<Credential | null> {
  let text: string | null
  if ((await platformOf(io)).backend === 'keychain') {
    const item = await liveItem(io)
    text = await findSecret(io, item.service, item.account)
  } else {
    text = await readIfPresent(io, await liveCredentialPath(io))
  }

  return text === null ? null : parseCredential(text)
}

/** Writes Claude Code's keychain item on macOS; the file backend keeps its login in the file alone. */
export async function writeLiveKeychain(io: Io, credential: Credential): Promise<void> {
  if ((await platformOf(io)).backend === 'file') return
  const item = await liveItem(io)
  await underStorageLock(io, () => storeSecret(io, item.service, item.account, JSON.stringify(credential)))
}

/**
 * Writes `.credentials.json`: the login itself on the file backend, and on
 * macOS the plaintext copy, only when that file exists. Claude Code compares
 * the file's modification time before each token check, so the write is what
 * makes a running session drop its cached login at once.
 */
export async function writeLiveFile(io: Io, credential: Credential): Promise<void> {
  const path = await liveCredentialPath(io)
  const { backend, isWindows } = await platformOf(io)
  if (backend === 'keychain' && !(await io.exists(path))) return
  await underStorageLock(io, () => writeAtomic(io, path, JSON.stringify(credential), { isPrivate: true, isWindows }))
}

/**
 * On macOS, brings `.credentials.json` up to the keychain's login when Claude
 * Code refreshed into the keychain alone: the file's change is what makes the
 * other sessions drop the token whose refresh token that refresh spent.
 */
export async function keepCredentialFileInStep(io: Io, keychain: Credential): Promise<void> {
  if ((await platformOf(io)).backend !== 'keychain') return
  const text = await readIfPresent(io, await liveCredentialPath(io))
  const file = text === null ? null : parseCredential(text)
  if (fileLagsKeychain(file, keychain)) await writeLiveFile(io, keychain)
}

async function vaultPath(io: Io, uuid: string): Promise<string> {
  return vaultFilePath(await claudeDirectory(io), VAULT_DIRECTORY, uuid)
}

function checkedId(uuid: string): string {
  if (!isAccountId(uuid)) throw new KeychainError(`refused an account id this mod cannot file: ${JSON.stringify(uuid)}`)

  return uuid
}

/** One saved account's login. */
export async function readVault(io: Io, uuid: string): Promise<Credential | null> {
  const text = (await platformOf(io)).backend === 'keychain' ? await findSecret(io, VAULT_SERVICE, checkedId(uuid)) : await readIfPresent(io, await vaultPath(io, uuid))

  return text === null ? null : parseCredential(text)
}

export async function writeVault(io: Io, uuid: string, credential: Credential): Promise<void> {
  const text = JSON.stringify(credential)
  const { backend, isWindows } = await platformOf(io)
  if (backend === 'keychain') await storeSecret(io, VAULT_SERVICE, checkedId(uuid), text)
  else await writeAtomic(io, await vaultPath(io, uuid), text, { isPrivate: true, isWindows })
}

export async function deleteVault(io: Io, uuid: string): Promise<void> {
  const platform = await platformOf(io)
  if (platform.backend === 'file') {
    const path = await vaultPath(io, uuid)
    const { exitCode, stderr } = await io.run(deleteFileArgv(path, platform.isWindows), { timeoutMs: 5000 })
    if (exitCode !== 0) throw new Error(`cannot delete ${path}: ${stderr.trim()}`)

    return
  }
  const { exitCode, stderr } = await io.run(deleteArgv(VAULT_SERVICE, checkedId(uuid)), { timeoutMs: 5000 })
  if (exitCode !== 0 && exitCode !== ITEM_NOT_FOUND) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
}

async function webhookTokenPath(io: Io): Promise<string> {
  return `${await claudeDirectory(io)}/sc-accounts/webhook-token`
}

/** The webhook's bearer token, or null when none is kept. */
export async function readWebhookToken(io: Io): Promise<string | null> {
  const token = (await platformOf(io)).backend === 'keychain' ? await findSecret(io, WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT) : await readIfPresent(io, await webhookTokenPath(io))

  return token === null || token.trim() === '' ? null : token.trim()
}

/** Keeps the webhook's bearer token, through stdin as every secret here; never in a command line. */
export async function writeWebhookToken(io: Io, token: string): Promise<void> {
  const { backend, isWindows } = await platformOf(io)
  if (backend === 'keychain') await storeSecret(io, WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT, token)
  else await writeAtomic(io, await webhookTokenPath(io), token, { isPrivate: true, isWindows })
}

export async function deleteWebhookToken(io: Io): Promise<void> {
  const platform = await platformOf(io)
  if (platform.backend === 'file') {
    const path = await webhookTokenPath(io)
    if (!(await io.exists(path))) return
    const { exitCode, stderr } = await io.run(deleteFileArgv(path, platform.isWindows), { timeoutMs: 5000 })
    if (exitCode !== 0) throw new Error(`cannot delete ${path}: ${stderr.trim()}`)

    return
  }
  const { exitCode, stderr } = await io.run(deleteArgv(WEBHOOK_SERVICE, WEBHOOK_TOKEN_ACCOUNT), { timeoutMs: 5000 })
  if (exitCode !== 0 && exitCode !== ITEM_NOT_FOUND) throw new KeychainError(`security exited ${exitCode}: ${stderr.trim()}`)
}

/** The account Claude Code's global config names, as last read, by the file's time and size: the file is read again only when it changed. */
let configCache: { mtimeMs: number; size: number; account: OauthAccount | null } | undefined

/** The login Claude Code's global config names, or null with none (or one whose id this mod cannot file). */
export async function liveOauthAccount(io: Io): Promise<OauthAccount | null> {
  const path = await globalConfigPath(io)
  // Without the file's time and size the file is read as it is, and nothing is kept.
  const stamp = await io.stat(path).catch(() => null)
  if (stamp !== null && configCache?.mtimeMs === stamp.mtimeMs && configCache.size === stamp.size) return configCache.account
  const config = JSON.parse(await io.read(path)) as { oauthAccount?: OauthAccount }
  const account = isAccountId(config.oauthAccount?.accountUuid) && typeof config.oauthAccount.emailAddress === 'string' ? config.oauthAccount : null
  configCache = stamp === null ? undefined : { mtimeMs: stamp.mtimeMs, size: stamp.size, account }

  return account
}

/**
 * Sets `oauthAccount` in Claude Code's global config, or takes it out with
 * null, under Claude Code's own lock over that file and reading it again
 * there, so a write of Claude Code's own between the read and the write is
 * never lost; the file is replaced whole, owner-only as Claude Code keeps it.
 */
export async function writeLiveOauthAccount(io: Io, account: OauthAccount | null): Promise<void> {
  const path = await globalConfigPath(io)
  const { isWindows } = await platformOf(io)
  await withLock(io, `${path}.lock`, { ...CONFIG_LOCK, isWindows }, async () => {
    const { oauthAccount: _was, ...rest } = JSON.parse(await io.read(path)) as Record<string, unknown>
    const next = account === null ? rest : { ...rest, oauthAccount: account }
    await writeAtomic(io, path, `${JSON.stringify(next, null, 2)}\n`, { isPrivate: true, isWindows })
  })
  configCache = undefined
}

/**
 * Where Orca keeps its copy of one account's login: on macOS a keychain item
 * named by Orca's account id, elsewhere `.credentials.json` in the account's
 * folder, which Orca marks as its own.
 */
export type OrcaCopyPlace = { kind: 'keychain'; orcaId: string } | { kind: 'file'; path: string }

async function readOrcaCopy(io: Io, place: OrcaCopyPlace): Promise<string | null> {
  return place.kind === 'keychain' ? findSecret(io, ORCA_COPY_SERVICE, place.orcaId) : readIfPresent(io, place.path)
}

async function writeOrcaCopy(io: Io, place: OrcaCopyPlace, text: string): Promise<void> {
  if (place.kind === 'keychain') await storeSecret(io, ORCA_COPY_SERVICE, place.orcaId, text)
  else await writeAtomic(io, place.path, text, { isPrivate: true, isWindows: (await platformOf(io)).isWindows })
}

/** What keeping Orca's copy of a saved login fresh came to: refreshed, fresh enough, or no copy to refresh. */
export type OrcaCopyStep = 'refreshed' | 'fresh' | 'absent'

/**
 * Refreshes a saved login Orca keeps a copy of once either copy expires within
 * `marginMs`, and writes the new grant to this mod's copy and to Orca's. Orca
 * applies its copy as it is while a Claude terminal runs in it, so an expired
 * or spent copy has every running session refresh a dead token at once, and
 * all of them are signed out.
 *
 * Two copies of different grants are usually one grant rotated in one place
 * and not the other, the older refresh token already spent; or two logins
 * made apart, both alive. So the grant that expires later is refreshed first,
 * the other only when the server refuses it, and whichever refreshes is
 * written to both. It runs under the account's refresh lock, the copies read
 * again inside it.
 */
export async function refreshOrcaCopy(io: Io, uuid: string, place: OrcaCopyPlace, marginMs: number, noAnswer: string): Promise<OrcaCopyStep> {
  const { isWindows } = await platformOf(io)
  const lockPath = `${await claudeDirectory(io)}/sc-accounts/locks/refresh-${checkedId(uuid)}.lock`

  return withLock(io, lockPath, { ...REFRESH_LOCK, isWindows }, async () => {
    const saved = await readVault(io, uuid)
    const text = await readOrcaCopy(io, place)
    if (saved === null || text === null) return 'absent'
    const copy = parseCredential(text)
    const now = await io.now()
    const isDue = needsRefresh(saved, now, marginMs) || needsRefresh(copy, now, marginMs)
    // Two fresh copies are left as they are, apart or not: the later grant reaches both once one is due.
    if (!isDue) return 'fresh'
    const candidates = isSameGrant(saved, copy) || saved.claudeAiOauth.expiresAt >= copy.claudeAiOauth.expiresAt ? [saved, copy] : [copy, saved]
    const save = async (from: Credential, response: HttpResponse): Promise<OrcaCopyStep> => {
      if (!response.ok) throw new AnthropicError(`token refresh answered ${response.status}`, response.status)
      const fresh = applyRefresh(from, response.text, now)
      const { accessToken, refreshToken, expiresAt } = fresh.claudeAiOauth
      await writeVault(io, uuid, { ...saved, claudeAiOauth: { ...saved.claudeAiOauth, accessToken, refreshToken, expiresAt } })
      await writeOrcaCopy(io, place, JSON.stringify({ ...copy, claudeAiOauth: { ...copy.claudeAiOauth, accessToken, refreshToken, expiresAt } }))

      return 'refreshed'
    }
    let refused: unknown
    for (const candidate of isSameGrant(saved, copy) ? [saved] : candidates) {
      const response = await within(io, io.fetch(TOKEN_URL, refreshInit(candidate)), REFRESH_TIMEOUT_MS, noAnswer, late => {
        void save(candidate, late).catch((error: unknown) => io.log(`a late token refresh could not be saved: ${message(error)}`))
      })
      try {
        return await save(candidate, response)
      } catch (error) {
        // Refused: this grant is spent or revoked, and the other copy's may still be alive.
        if (!(error instanceof AnthropicError) || error.status === undefined || error.status >= 500) throw error
        refused = error
      }
    }
    throw refused
  })
}

/**
 * A saved account's login, its access token refreshed first when it is near
 * expiry. The grant Claude Code holds (`live`) is never refreshed here: a
 * refresh rotates the refresh token under Claude Code, so it is handed back as
 * it is. The refresh runs under this account's lock across sessions, after
 * reading the saved login again, as another session may have refreshed it
 * meanwhile and refreshing one refresh token twice spends it. A refresh that
 * answers after its time has still rotated the token: its answer is saved
 * when it comes. `noAnswer` is what the person reads when it does not answer
 * in time.
 */
export async function ensureFresh(io: Io, uuid: string, credential: Credential, live: Credential | null, noAnswer: string): Promise<Credential> {
  if (!needsRefresh(credential, await io.now()) || isSameGrant(credential, live)) return credential
  const { isWindows } = await platformOf(io)
  const lockPath = `${await claudeDirectory(io)}/sc-accounts/locks/refresh-${checkedId(uuid)}.lock`

  return withLock(io, lockPath, { ...REFRESH_LOCK, isWindows }, async () => {
    const current = (await readVault(io, uuid)) ?? credential
    const now = await io.now()
    if (!needsRefresh(current, now) || isSameGrant(current, live)) return current
    const apply = async (response: HttpResponse): Promise<Credential> => {
      if (!response.ok) throw new AnthropicError(`token refresh answered ${response.status}`, response.status)
      const fresh = applyRefresh(current, response.text, now)
      await writeVault(io, uuid, fresh)

      return fresh
    }
    const response = await within(io, io.fetch(TOKEN_URL, refreshInit(current)), REFRESH_TIMEOUT_MS, noAnswer, late => {
      void apply(late).catch((error: unknown) => io.log(`a late token refresh could not be saved: ${message(error)}`))
    })

    return apply(response)
  })
}
