/** The keychain item Claude Code reads its login from. */
export const LIVE_SERVICE = 'Claude Code-credentials'
/** The keychain service this mod keeps one item per saved account under. */
export const VAULT_SERVICE = 'account-switch'
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

/** argv printing one item's attributes, its `acct` among them, without the secret. */
export function attributesArgv(service: string): string[] {
  return ['security', 'find-generic-password', '-s', service]
}

export function parseAccountName(attributes: string): string | undefined {
  return /"acct"<blob>="([^"]*)"/.exec(attributes)?.[1]
}

/**
 * The `security -i` line that creates or replaces an item. The secret travels
 * on stdin as hex, never in argv, the way Claude Code writes its own item.
 */
export function addLine(service: string, account: string, text: string): string {
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${toHex(text)}"\n`
}

export function deleteArgv(service: string, account: string): string[] {
  return ['security', 'delete-generic-password', '-s', service, '-a', account]
}
