<!-- Copied from the repository's CHANGELOG.md by scripts/sync.mjs; edit that file and run the script. -->

# Changelog

Every plugin in this repository shares one version, kept in `VERSION`. `scripts/sync.mjs` writes it into each plugin's manifest and copies this file into each plugin, where the pane header reads the release date from the heading of its version: `## <version> (<YYYY-MM-DD>)`.

## 0.3.0 (2026-10-04)

### All plugins

- One version for every plugin, kept in `VERSION`, and one changelog, this file.
- Every action that cannot be taken back asks first in a dialog inside the pane, under the pane's header, and Esc or Cancel closes it. The buttons pressed twice to confirm are gone.
- The README is a short overview with install, update and uninstall steps; each mod is described on its own page under `docs/`, and developing a mod on `docs/developing.md`. The screens on those pages are captured from a running Claude Code.
- After `/clear`, which starts a new session in the same process, each mod takes the new session up at once; the band no longer waits a minute for the account and its usage.
- Each pane is named once, `SimpleCORE Mods: Accounts` or `SimpleCORE Mods: Workspace`: in its header, or on Claude Code's tab while both panes are open.
- Released under the MIT license.

### Accounts (`sc-accounts`)

- Removing an account asks in a dialog that names it.
- On the status band, pressing the account's name toggles the accounts pane, and pressing the directory and branch or the lines changed toggles the workspace on its Diff tab. A pane opened this way shows at any terminal width, and one hidden behind another pane's tab comes to the front instead of closing.
- Switching to an account is a filled **Switch** button.
- The mod reads the band's status itself (model, effort, fast mode, ULTRACODE, task, branch, PR, context, lines changed); no status line command is needed, and the row Claude Code keeps under the prompt for one goes away.
- The webhook dialog opens tall enough to show whole, and `/sc:accounts` always opens the account list.
- A receiver that does not answer holds one webhook send at a time and never delays the status.
- A webhook sends the session's status to a URL when it changes: POST as JSON or GET as query parameters, an optional bearer token kept in the keychain or an owner-only file, and a JSON template file with `{{variable}}` placeholders. It is set in a dialog (**Webhook**, or `/sc:accounts webhook`) and is off until turned on.
- The lines changed on the status band are one filled block, and a dim rule sets the band off from the conversation above it.
- Each account card says how long ago its figures were looked up, to the minute. A failed lookup keeps the time of the figures it keeps.
- The command's reply on opening names the accounts pane, not the workspace.

### Workspace (`sc-workspace`)

- The Checkpoints, Diff and Notes tabs update live: 1.5 seconds after file-changing tool calls settle, and every five seconds while the pane is open. Notes written by another session show too.
- Diff compares against any checkpoint picked in a dialog opened from the base named in the tab's header; each checkpoint shows what changed since it.
- `/sc:workspace toggle [tab]` closes the open pane or opens it.
- Deleting a note, stopping an agent and removing a worktree ask in a dialog, as restoring a checkpoint does.
- The note field is drawn wherever the surface has one.
- Each session snapshots in an index of its own, kept between snapshots: two sessions in one repository no longer collide on the index lock, which could drop a checkpoint, and a snapshot rehashes only the files that changed (2.2 s fell to 0.06 s on a repository of 2,000 files).

## 0.2.0 (2026-10-04)

### Bundle (`sc`)

- Installing `sc` installs `sc-accounts` and `sc-workspace` as dependencies.
- Declares `/sc:accounts` and `/sc:workspace`, which those plugins answer.

### Accounts (`sc-accounts`)

- Shares one look with the workspace: the pane is drawn from the same header, cards, gauges and footer, and the footer is one row tall with each label centred on one line.
- The plugin is named `sc-accounts`; the status band setting is `sc-accounts.showStatusBand`.
- Saving an account applies the change to the list every session shares, and reading the list puts back any account whose details and credential are still kept, so no session, an older build's included, can drop a saved account.

### Workspace (`sc-workspace`)

- A workspace pane, opened with `/sc:workspace`, with four tabs: Agents, Checkpoints, Notes and Diff.
- Agents lists the session's subagents and stops a running one; it lists the repository's worktrees and removes a clean, merged one.
- Checkpoints snapshots the working tree before every prompt, shows what changed since each checkpoint, and restores one after a confirmation dialog; a restore can itself be undone.
- Notes keeps notes per project, puts one in the prompt, and can hand the open ones to the model with every prompt.
- Diff shows the files changed since the session started or since a checkpoint, and one file's diff.

## 0.1.0 (2026-10-04)

### Accounts

- Switches between saved Claude logins the moment one is chosen. The credential is written to the keychain and to `~/.claude/.credentials.json`, so running sessions use the new account from their next request.
- Shows every saved account's five-hour, weekly and per-model usage with reset times in the accounts pane, the prompt footer and `/sc:accounts list`.
- Looks usage up automatically once every five minutes across the machine and shares the result between sessions. A 429 pauses automatic lookups; Refresh always looks up at once.
- Runs on macOS, Linux, WSL and Windows: the keychain holds saved logins on macOS, owner-only files under `~/.claude/account-switch/` hold them elsewhere.
- Shows English by default and Korean where Claude Code's language is Korean.
