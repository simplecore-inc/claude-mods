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
  /** Orca keeps this inactive account's login, so its token is not refreshed here: the limits shown are the last lookup's. */
  isHeld?: boolean
  /** `lookup` when the figures came from this account's own usage lookup; anything else is discarded. */
  source?: 'lookup'
  /** What the account spent past its plan, as the usage endpoint reports it; absent when it reports none. */
  spend?: SpendView
}

/** An amount of money as the usage endpoint gives it: an integer in the currency's minor unit. */
export type Money = { minor: number; currency: string; exponent: number }

/** Spending past the plan, exactly as reported: what was used, and the limit set, if any. */
export type SpendView = { used: Money; limit?: Money }

/** Tokens of one kind of use, and how many responses they came from. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; responses: number }

/** One row of a ranking: a model or a project, its tokens, and the sessions it was used in. */
export type RankRow = { name: string; tokens: Tokens; sessions: number }

/** What the Usage tab shows for a period, counted from this machine's transcripts. */
export type UsageSummary = {
  totals: Tokens
  /** Every day of the period, oldest first, with its tokens (zero for a day with none). */
  daily: { day: string; tokens: Tokens }[]
  models: RankRow[]
  projects: RankRow[]
  sessions: number
}

/** The accounts pane's tabs. */
export type AccountsTabKey = 'accounts' | 'usage' | 'storage'

/** A project folder of transcripts as the Storage tab lists it. */
export type StorageProject = {
  folder: string
  /** The project's name from the directory its sessions worked in, when the usage count knows it; else the folder's. */
  name: string
  bytes: number
  sessions: number
  lastActive: number
}

/** What the Storage tab shows: the transcripts by kind and by project, and the other folders beside them. */
export type StorageView = {
  bytes: number
  transcripts: { count: number; bytes: number }
  subagents: { count: number; bytes: number }
  other: { count: number; bytes: number }
  sessions: number
  projects: StorageProject[]
  /** The other folders under the config directory and their sizes; empty where they cannot be measured. */
  folders: { name: string; bytes: number }[]
  /** Claude Code's own `cleanupPeriodDays`, and whether that is its default. */
  autoDays: number
  isAutoDefault: boolean
  /** The config directory, as the tab names it. */
  root: string
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

/** A session's effort: a level, or null for a model that takes none. */
export type SessionEffort = { level: string | null }

/** One run of text in a band cell, in its own colours. */
export type BandSpan = {
  text: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
}

/** What a band cell's label toggles: the accounts pane, the workspace, or the toolbox's quick tiles. */
export type BandTarget = 'accounts' | 'workspace' | 'toolbox'

/** One webhook send, test or feed: when, the HTTP status or why none came, and the start of what the receiver answered. */
export type WebhookSend = { at: number; status: number | null; error: string | null; reply: string | null }

declare module 'claude-code' {
  interface PluginState {
    /** What this plugin reads of the workspace's state. */
    'sc-workspace': {
      paneOpen: boolean
    }
    /** What this plugin reads of the toolbox's state: what runs, waits and failed unseen, for the band's cell. */
    'sc-toolbox': {
      summary: { running: number; waiting: number; failed: number }
      paneOpen: boolean
    }
    'sc-accounts': {
      accounts: AccountView[]
      usage: Record<string, UsageView>
      /** accountUuid of the login Claude Code currently uses, or null. */
      live: string | null
      /** What the dialog shows: the account the remove dialog asks about, the webhook settings, or the Usage tab's period; null with none open. */
      dialog: { kind: 'remove'; uuid: string } | { kind: 'switch'; uuid: string } | { kind: 'webhook' } | { kind: 'period' } | { kind: 'cleanupDays' } | { kind: 'cleanup' } | null
      /**
       * The webhook settings being edited in the dialog, or null: `token` is a
       * new token typed (empty keeps the one kept), `hasToken` whether one is
       * kept, `clearToken` whether saving removes it.
       */
      webhookDraft: { enabled: boolean; url: string; method: 'POST' | 'GET'; token: string; hasToken: boolean; clearToken: boolean } | null
      /** The last webhook send, test or feed, or null before any. */
      webhookLast: WebhookSend | null
      /** The key of the element holding the keyboard in the pane, or null. */
      focused: string | null
      isRefreshing: boolean
      /** Whether the pane shows how to add an account. */
      isGuideOpen: boolean
      /** Whether this plugin's pane is open, for the workspace to read: with both open, the engine draws tabs. */
      paneOpen: boolean
      /** The session's latest status, or null before the first read. */
      status: StatusInfo | null
      /** The effort this session runs at, kept here so a reload keeps it; null before the session is taken up. */
      sessionEffort: SessionEffort | null
      /** `$.clock.now()` of the pane's last tick, so the ages it shows move on while it is open. */
      tick: number
      /** The pane's tab on screen. */
      tab: AccountsTabKey
      /** The Usage tab's period in days; 0 for everything counted. */
      usagePeriod: number
      /** The Usage tab's figures for its period, or null before the first count. */
      usageSummary: UsageSummary | null
      /** How far a count of the transcripts has got: files done of all to read; null when none is running. */
      usageScan: { done: number; total: number } | null
      /** Why the transcripts cannot be counted here, or null. */
      usageError: string | null
      /** The Storage tab's figures, or null while they are measured. */
      storage: StorageView | null
      /** The age in days past which a cleanup deletes a session. */
      cleanupDays: number
    }
  }
}
