/** The workspace pane's tabs. */
export type Tab = 'agents' | 'checkpoints' | 'notes' | 'diff' | 'memory'

/** A subagent or teammate as the Agents tab lists it. */
export type AgentRow = {
  id: string
  /**
   * What TaskStop is asked to stop it by, the surest first: its id, which no
   * other agent holds, then its name and its teammate address, which TaskStop
   * also takes and two agents may share.
   */
  stopIds: string[]
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
  /** A name the person gave it; shown in place of `label`. */
  name?: string
  /** Kept past the newest 50: never deleted to make room. */
  isPinned?: boolean
  /** Changes since it, against the working tree now; absent until counted. */
  since?: { files: number; added: number; removed: number }
}

export type Note = {
  id: string
  text: string
  isDone: boolean
  at: number
  /** The note's number, `N<seq>` in the prompt it is sent with; absent on a note made before numbering. */
  seq?: number
  /** Claude's answer said it finished this note (`[done N<seq>]`); the person confirms. */
  isSuggestedDone?: boolean
}

export type DiffFile = {
  path: string
  /** The old path of a rename. */
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Null for a binary file. */
  added: number | null
  removed: number | null
}

/** A checkpoint one end of the Diff tab's comparison is taken at. */
export type DiffPoint = { commit: string; label: string; at: number; isSessionStart: boolean }

/** What an agent did last, as the Agents tab shows under it. */
export type AgentActivity = {
  /** The tool it last called with what it called it on (`Bash: npm test`), or its last answer's first line. */
  text: string
  /** Whether `text` is its answer: the turn it ran ended. */
  isAnswer: boolean
  /** `$.clock.now()` milliseconds it happened. */
  at: number
}

/** An agent the engine no longer lists, kept for the session with its last activity and full answer. */
export type FinishedAgent = AgentRow & {
  /** `$.clock.now()` milliseconds the engine stopped listing it. */
  endedAt: number
  /** Its last answer in full, when its turn ended with one. */
  answer?: string
}

/** Where a memory file applies: on every project, or on this one. */
export type MemoryScope = 'global' | 'project'

/**
 * What a memory file is to Claude Code: the organisation's policy, the
 * user's CLAUDE.md or rules, the project's CLAUDE.md, local CLAUDE.md, rules,
 * a parent or subfolder's CLAUDE.md, AGENTS.md, a file another imports, or
 * auto memory (its index and its topic files).
 */
export type MemoryKind =
  | 'managed'
  | 'user'
  | 'userRule'
  | 'project'
  | 'local'
  | 'rule'
  | 'pathRule'
  | 'parent'
  | 'subfolder'
  | 'agents'
  | 'imported'
  | 'autoIndex'
  | 'auto'

/** One line of a memory file's outline: a heading, or an index entry. */
export type MemoryOutline = { line: number; text: string; level: number }

/** A memory file as the Memory tab lists it. */
export type MemoryFile = {
  path: string
  /** The path as the tab shows it: from the project, or from home with `~`. */
  display: string
  scope: MemoryScope
  kind: MemoryKind
  bytes: number
  lines: number
  outline: MemoryOutline[]
  /** An auto-memory topic's description, or the file that imports this one. */
  note?: string
}

/** What the Diff tab shows: the files changed since a checkpoint, and one file's diff. */
export type DiffView = {
  /** The checkpoint compared against. */
  base: DiffPoint
  /** The checkpoint compared up to; absent for the working tree as it is now. */
  target?: DiffPoint
  /** Another worktree whose changes are shown, since it parted from the main branch; absent for this one. */
  worktree?: { path: string; branch: string }
  files: DiffFile[]
  selected?: { path: string; text: string; omitted: number }
  /** `$.clock.now()` milliseconds of the comparison. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    /** What this plugin reads of the accounts mod's and the toolbox's state. */
    'sc-accounts': {
      paneOpen: boolean
    }
    'sc-toolbox': {
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
      /** What the dialog asks: a confirmation, or one end of the Diff tab's comparison; null with no dialog open. */
      dialog: { kind: 'restore' | 'note' | 'stop' | 'worktree' | 'base' | 'target' | 'file' | 'name' | 'memoryScope' | 'memoryRead' | 'diff'; ref: string } | null
      /** What each agent did last, by agent id. */
      activity: Record<string, AgentActivity>
      /** Each agent's last answer in full, by agent id. */
      answers: Record<string, string>
      /** The memory files Claude Code reads here, global and project; null before they are read. */
      memory: MemoryFile[] | null
      /** What the Memory tab searches for; empty to list the files. */
      memoryQuery: string
      /** Which memory files the tab lists. */
      memoryScope: 'all' | MemoryScope
      /** The path of the memory file whose outline is open, or null. */
      memoryOpen: string | null
      /** The page of the open file's diff the diff dialog shows, from 0. */
      diffPage: number
      /** The page of the memory file the reader shows, from 0. */
      memoryPage: number
      /** Agents the engine no longer lists, newest first. */
      finished: FinishedAgent[]
      /** The finished agent whose answer is shown in full, or null. */
      expandedAgent: string | null
      /** The key of the element holding the keyboard in the pane, or null. */
      focused: string | null
      /** Whether this plugin's pane is open, for the accounts mod to read: with both open, the engine draws tabs. */
      paneOpen: boolean
    }
  }
}
