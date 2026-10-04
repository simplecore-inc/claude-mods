/** The workspace pane's tabs. */
export type Tab = 'agents' | 'checkpoints' | 'notes' | 'diff'

/** A subagent or teammate as the Agents tab lists it. */
export type AgentRow = {
  id: string
  /** What TaskStop takes for it: its name, its teammate address, or its id. */
  stopId: string
  label: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  /** `$.clock.now()` milliseconds this session first saw it. */
  firstSeen: number
}

/** A git worktree of the session's repository. */
export type WorktreeRow = {
  path: string
  branch?: string
  isMain: boolean
  isLocked: boolean
  /** Changed or untracked paths in it. */
  changed: number
  /** Commits on its branch that the main branch lacks; undefined when unknown. */
  ahead?: number
  behind?: number
}

/** A snapshot of the working tree, kept as a commit under refs/sc/checkpoints. */
export type CheckpointRow = {
  ref: string
  commit: string
  tree: string
  /** `$.clock.now()` milliseconds it was taken. */
  at: number
  /** The prompt it was taken before, or what took it. */
  label: string
  kind: 'turn' | 'session' | 'manual' | 'restore'
  /** Changes since it, against the working tree now; absent until counted. */
  since?: { files: number; added: number; removed: number }
}

export type Note = { id: string; text: string; isDone: boolean; at: number }

export type DiffFile = {
  path: string
  /** The old path of a rename. */
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Null for a binary file. */
  added: number | null
  removed: number | null
}

/** What the Diff tab shows: the files changed since a checkpoint, and one file's diff. */
export type DiffView = {
  /** The checkpoint compared against. */
  base: { commit: string; label: string; at: number; isSessionStart: boolean }
  files: DiffFile[]
  selected?: { path: string; text: string; omitted: number }
  /** `$.clock.now()` milliseconds of the comparison. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    /** What this plugin reads of the accounts mod's state. */
    'sc-accounts': {
      paneOpen: boolean
    }
    'sc-workspace': {
      tab: Tab
      agents: AgentRow[]
      worktrees: WorktreeRow[]
      /** Why the repository's worktrees and checkpoints cannot be read, or null. */
      repoError: string | null
      checkpoints: CheckpointRow[]
      notes: Note[]
      diff: DiffView | null
      /** What the pane is busy with, as a short key, or null. */
      busy: string | null
      /** `$.clock.now()` of the last agents check while one is active: redraws their elapsed times. */
      clock: number
      /** What the dialog asks: a confirmation, or the Diff tab's base; null with no dialog open. */
      dialog: { kind: 'restore' | 'note' | 'stop' | 'worktree' | 'base'; ref: string } | null
      /** The key of the element holding the keyboard in the pane, or null. */
      focused: string | null
      /** Whether this plugin's pane is open, for the accounts mod to read: with both open, the engine draws tabs. */
      paneOpen: boolean
    }
  }
}
