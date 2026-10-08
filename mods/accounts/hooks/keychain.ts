/** The keychain item Claude Code reads its login from, with its default config directory. */
export const LIVE_SERVICE = 'Claude Code-credentials'

/** The environment variables that decide where Claude Code keeps its login. */
export type StorageVariables = { configDir?: string; secureStorageDir?: string }

/**
 * The keychain service Claude Code keeps its login under, named as it names
 * it: `Claude Code-credentials`, then `-` and the first eight hex digits of
 * the SHA-256 of a folder when `CLAUDE_SECURESTORAGE_CONFIG_DIR` names one,
 * or else when `CLAUDE_CONFIG_DIR` is set (that folder, as given, NFC). An
 * empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` keeps the plain name.
 */
export async function liveServiceName(variables: StorageVariables, defaultConfigDir: string): Promise<string> {
  const { secureStorageDir, configDir } = variables
  const isPlain = secureStorageDir !== undefined ? secureStorageDir === '' : !configDir
  if (isPlain) return LIVE_SERVICE
  const folder = (secureStorageDir ?? configDir ?? defaultConfigDir).normalize('NFC')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(folder))
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

  return `${LIVE_SERVICE}-${hex.slice(0, 8)}`
}

/** The folder Claude Code keeps `.credentials.json` in: `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set (empty means the default), else its config directory. */
export function credentialsDirectory(variables: StorageVariables, defaultConfigDir: string): string {
  if (variables.secureStorageDir !== undefined) return (variables.secureStorageDir || defaultConfigDir).normalize('NFC')

  return (variables.configDir || defaultConfigDir).normalize('NFC')
}

/** The keychain account Claude Code reads its login with: the user's name, or `claude-code-user` when that holds other characters. */
export function keychainAccountName(user: string | undefined): string {
  return user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}
/** The keychain service this mod keeps one item per saved account under. */
export const VAULT_SERVICE = 'account-switch'
/** The keychain service Orca keeps each Claude account's login under, the account named by Orca's account id. */
export const ORCA_COPY_SERVICE = 'Orca Claude Code Managed Credentials'
/** `security`'s exit code for an item that is not there. */
export const ITEM_NOT_FOUND = 44

/** The OAuth credential document Claude Code stores, kept whole. */
export type Credential = {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string
    rateLimitTier?: string
    [field: string]: unknown
  }
  [field: string]: unknown
}

export class KeychainError extends Error {}

/**
 * Whether an account id is one this mod files a login under: letters, digits,
 * `-` and `_`, as a UUID is. It names a keychain item and a vault file, and
 * travels inside a `security -i` line, so nothing else may reach those.
 */
export function isAccountId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parseCredential(text: string): Credential {
  const parsed: unknown = JSON.parse(text.trim())
  const oauth = (parsed as Credential | null)?.claudeAiOauth
  if (typeof oauth?.accessToken !== 'string' || typeof oauth.refreshToken !== 'string') {
    throw new KeychainError('keychain item holds no Claude OAuth credential')
  }

  return parsed as Credential
}

/** argv printing one item's secret. */
export function findArgv(service: string, account?: string): string[] {
  return ['security', 'find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
}

/**
 * The `security -i` line that creates or replaces an item. The secret travels
 * on stdin as hex, never in argv, the way Claude Code writes its own item.
 */
export function addLine(service: string, account: string, text: string): string {
  // `security -i` reads the line as a command line of its own: a quote, a backslash or a line break would end it.
  for (const value of [service, account]) {
    if (/["\\\n\r]/.test(value)) throw new KeychainError(`refused a keychain name with a quote, backslash or line break: ${JSON.stringify(value)}`)
  }

  return `add-generic-password -U -a "${account}" -s "${service}" -X "${toHex(text)}"\n`
}

export function deleteArgv(service: string, account: string): string[] {
  return ['security', 'delete-generic-password', '-s', service, '-a', account]
}

/**
 * Whether a login is an older copy than the one saved for its account: another
 * grant (refresh token) that expires sooner. Filing it would replace a newer
 * grant with one whose refresh token may already be spent.
 */
export function isOlderGrant(candidate: Credential, saved: Credential | null): boolean {
  if (saved === null) return false

  return candidate.claudeAiOauth.refreshToken !== saved.claudeAiOauth.refreshToken && candidate.claudeAiOauth.expiresAt < saved.claudeAiOauth.expiresAt
}

/** Whether two logins are one grant: the same refresh token, whatever access token each holds now. */
export function isSameGrant(a: Credential | null, b: Credential | null): boolean {
  return a !== null && b !== null && a.claudeAiOauth.refreshToken === b.claudeAiOauth.refreshToken
}

/**
 * Whether `.credentials.json` holds an older login than the keychain: another
 * token there, expiring no later. Claude Code refreshes into the keychain
 * alone, while a session with that file drops its cached login only when the
 * file changes, so a file left behind keeps every other session on a token
 * whose refresh token is already spent, and it expires with "Login expired".
 */
export function fileLagsKeychain(file: Credential | null, keychain: Credential): boolean {
  if (file === null) return false

  return file.claudeAiOauth.accessToken !== keychain.claudeAiOauth.accessToken && file.claudeAiOauth.expiresAt <= keychain.claudeAiOauth.expiresAt
}
