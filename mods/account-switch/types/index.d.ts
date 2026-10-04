/** One rate-limit window of an account, as the usage endpoint reports it. */
export type LimitView = {
  /** Short label: `5h`, `wk`, or a scoped model's name such as `Fable`. */
  label: string
  /** 0 to 100. */
  percent: number
  /** ISO 8601 reset time, when the endpoint gives one. */
  resetsAt?: string
}

/** The last usage reading of one account. */
export type UsageView = {
  limits: LimitView[]
  /** `$.clock.now()` milliseconds of the reading. */
  fetchedAt: number
  /** Why the last attempt failed; the previous limits stay shown. */
  error?: string
  /** The last attempt was rate limited: the limits shown are the previous reading's. */
  isStale?: boolean
  /** `lookup` when the figures came from this account's own usage lookup; anything else is discarded. */
  source?: 'lookup'
}

/** A saved account, without its credential (that stays in the keychain). */
export type AccountView = {
  uuid: string
  email: string
  organizationName?: string
  subscriptionType?: string
  /** `$.clock.now()` milliseconds of the first capture. */
  savedAt: number
}

/** What the status line command forwards for this session (`~/.claude/cache/statusline/<session>.json`). */
export type StatusInfo = {
  updatedAt: number
  model: string
  effort: string | null
  ultracode: boolean
  fast: boolean
  /** Context used, as a percentage of the whole window; null before the first response. */
  contextUsed: number | null
  task: string
  dir: string
  branch: string
  pr: { number: number; reviewState: string | null } | null
  linesAdded: number
  linesRemoved: number
}

declare module 'claude-code' {
  interface PluginState {
    sc: {
      accounts: AccountView[]
      usage: Record<string, UsageView>
      /** accountUuid of the login Claude Code currently uses, or null. */
      live: string | null
      /** uuid whose Remove button awaits its confirming press. */
      pendingRemove: string | null
      isRefreshing: boolean
      /** Whether the pane shows how to add an account. */
      isGuideOpen: boolean
      /** The status line command's latest forward for this session, or null. */
      status: StatusInfo | null
    }
  }
}
