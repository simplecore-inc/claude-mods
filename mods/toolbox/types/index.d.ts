/** The toolbox pane's tabs. */
export type Tab = 'tools' | 'add'

/** What a tool runs: a shell command, a Claude slash command, or a prompt. */
export type ToolKind = 'shell' | 'claude' | 'prompt'

/** How a parameter's value is had: fixed when the tool is set up, or asked at every run. */
export type ParamMode = 'fixed' | 'ask'

/** A `{{name}}` in a tool's command, and how its value is had. */
export type ToolParam = {
  type: 'text' | 'path' | 'choice'
  mode: ParamMode
  /** The value when fixed, or the one offered first when asked. */
  value?: string
  /** For `choice`: the values to pick from. */
  choices?: string[]
  /** For `path`: `file`, `dir`, or either; and a glob the names must match, such as `*.ts`. */
  pathKind?: 'file' | 'dir' | 'any'
  glob?: string
  /** Offer the value given at the last run first. */
  remember?: boolean
}

/** A tool as `.toolbox/toolbox.json` keeps it. */
export type Tool = {
  id: string
  name: string
  kind: ToolKind
  /** The command, slash command or prompt, with `{{name}}` for each parameter. */
  run: string
  /** Where a shell command runs, from the project's root; the root when absent. */
  cwd?: string
  params?: Record<string, ToolParam>
  /** For a prompt: send it at once, rather than put it in the prompt box to send. */
  submit?: boolean
  /** Ask before each run, for a command that cannot be taken back (`/clear`). */
  confirm?: boolean
  /** Where the tool came from, shown as its group: `npm`, `gradle`, `claude`, `custom`. */
  group?: string
}

/** What the band says of the toolbox: tools running, waiting for Claude, and failed unseen. */
export type ToolboxSummary = { running: number; waiting: number; failed: number }

/** How a tool's last or current run stands. */
export type RunStatus = {
  state: 'running' | 'done' | 'failed' | 'stopped' | 'queued'
  /** `$.clock.now()` milliseconds it started, and ended. */
  startedAt: number
  endedAt?: number
  /** The exit code, or the signal, once it ended. */
  code?: number | null
  signal?: string | null
  /** The command as it ran, its parameters filled. */
  command: string
}

/** A task found in the project's build files, offered to add as a tool. */
export type DetectedTask = {
  /** The ecosystem it came from: `npm`, `vite`, `maven`, `gradle`, `cargo`, `make`, `just`, `compose`, `go`, `python`. */
  source: string
  name: string
  run: string
  cwd?: string
  description?: string
  params?: Record<string, ToolParam>
}

declare module 'claude-code' {
  interface PluginState {
    /** What this plugin reads of the other mods' state: whether their panes are open. */
    'sc-accounts': {
      paneOpen: boolean
    }
    'sc-workspace': {
      paneOpen: boolean
    }
    'sc-toolbox': {
      tab: Tab
      /** The project's tools as `.toolbox/toolbox.json` holds them. */
      tools: Tool[]
      /** Why the tools could not be read, or null. */
      toolsError: string | null
      /** Each tool's last or current run, by tool id. */
      runs: Record<string, RunStatus>
      /** Bumped as output arrives, at most a few times a second: the log dialog redraws on it. */
      logTick: number
      /** The tasks found in the project's build files, or null before they are read. */
      detected: DetectedTask[] | null
      /** Claude Code's slash commands, as the typeahead lists them; null before they are read. */
      commands: { name: string; description: string; source: string }[] | null
      /** What the Add tab filters by. */
      addQuery: string
      /** The dialog open: a tool's parameters to ask, its log, a tool to add or edit, one to remove or restart, or a run to confirm; null with none. */
      dialog:
        | { kind: 'ask'; id: string }
        | { kind: 'log'; id: string }
        | { kind: 'edit'; id: string }
        | { kind: 'remove'; id: string }
        | { kind: 'restart'; id: string }
        | { kind: 'confirm'; id: string }
        | null
      /** How many tools run, wait for Claude, or failed since the toolbox was last looked at: the band shows it. */
      summary: ToolboxSummary
      /** When the toolbox was last opened: failures before it count as seen. */
      seenAt: number
      /** Whether this plugin's pane is open, for the other mods to read: with two open, the engine draws tabs. */
      paneOpen: boolean
      /** The values typed in the open dialog, by field. */
      draft: Record<string, string>
      /** The field the path suggestions are for, and the suggestions. */
      suggest: { field: string; items: string[] } | null
      /** Whether the log dialog follows the newest output. */
      follow: boolean
      /** The key of the element holding the keyboard in the pane, or null. */
      focused: string | null
    }
  }
}
