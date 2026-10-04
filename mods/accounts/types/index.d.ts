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

/** The session's status as the band draws it, read by the mod every two seconds. */
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

/** One run of text in a band cell, in its own colours. */
export type BandSpan = {
  text: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
}

/** What a band cell's label toggles: the accounts pane, or the workspace. */
export type BandTarget = 'accounts' | 'workspace'

declare module 'claude-code' {
  interface PluginState {
    /** What this plugin reads of the workspace's state. */
    'sc-workspace': {
      paneOpen: boolean
    }
    'sc-accounts': {
      accounts: AccountView[]
      usage: Record<string, UsageView>
      /** accountUuid of the login Claude Code currently uses, or null. */
      live: string | null
      /** What the dialog shows: the account the remove dialog asks about, or the webhook settings; null with none open. */
      dialog: { kind: 'remove'; uuid: string } | { kind: 'webhook' } | null
      /**
       * The webhook settings being edited in the dialog, or null: `token` is a
       * new token typed (empty keeps the one kept), `hasToken` whether one is
       * kept, `clearToken` whether saving removes it.
       */
      webhookDraft: { enabled: boolean; url: string; method: 'POST' | 'GET'; token: string; hasToken: boolean; clearToken: boolean } | null
      /** The last webhook send, test or feed, or null before any. */
      webhookLast: { at: number; status: number | null; error: string | null } | null
      /** The key of the element holding the keyboard in the pane, or null. */
      focused: string | null
      isRefreshing: boolean
      /** Whether the pane shows how to add an account. */
      isGuideOpen: boolean
      /** Whether this plugin's pane is open, for the workspace to read: with both open, the engine draws tabs. */
      paneOpen: boolean
      /** The session's latest status, or null before the first read. */
      status: StatusInfo | null
      /** `$.clock.now()` of the pane's last tick, so the ages it shows move on while it is open. */
      tick: number
    }
  }
}
