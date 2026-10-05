# Changelog

Every plugin in this repository shares one version, kept in `VERSION`. `scripts/sync.mjs` writes it into each plugin's manifest and copies this file into each plugin, where the pane header reads the release date from the heading of its version: `## <version> (<YYYY-MM-DD>)`.

## 0.4.0 (2026-10-05)

### All plugins

- Glyph buttons sit on a dark ground of their meaning (red to delete or stop, yellow to restore or pin, cyan to compare or open, green to finish), so they read at rest.
- Every screen is drawn from the shared kit: text inputs, select fields, dialogs that ask for text, figures, bar charts, rankings and outlines look the same in both panes.

### Accounts (`sc-accounts`)

- The pane has tabs: Accounts, Usage and Storage.
- An account shows what it spent past its plan, exactly as Claude's usage lookup reports it, when spending is on or something was spent.
- Usage counts the tokens used on this machine from Claude Code's transcripts, subagents' included: input, output, cache read and write, cache reuse, sessions and responses, tokens by day, and the top models and projects, for the last 7 or 30 days or everything. Only what the transcripts gained is read after the first count.
- Storage shows what `~/.claude` holds: transcripts, subagent transcripts and tool output by size, each project's sessions and last activity, the other folders, and Claude Code's own `cleanupPeriodDays`. Clean up deletes the sessions idle longer than an age picked, never the one running, after `delete` is typed in its dialog; their tokens stay counted.
- `/sc:accounts usage` and `/sc:accounts storage` open those tabs.

### Workspace (`sc-workspace`)

- Memory: the memory files Claude Code reads here, global and project apart, each with what it is to Claude Code (instructions, rules, local, imported, auto memory). A file opens to read as Markdown, a page at a time; `▸` shows its outline, `↵` puts `@path` in the prompt, and a search finds every line holding the words, opening the file at that line.
- Diff: `↺` puts one file back as it was at the base, after a dialog; the changes can be compared up to a later checkpoint instead of the working tree; **Draft commit message** puts a request for one in the prompt.
- Diff: pressing another worktree's branch on the Agents tab shows its changes since it parted from the main branch, untracked files included.
- Checkpoints: `±` opens what one turn changed; `✎` names a checkpoint and pins it, `☆` pins it, and a pinned checkpoint is kept past the newest 50. `/sc:workspace name <text>` names the newest.
- Checkpoints are named by the first line written in their prompt, without the blocks Claude Code adds; their counts of what changed are kept, so they show at once in a new session.
- Agents: each agent shows what it did last; a finished agent stays in a Finished group with its whole answer; an agent's row no longer shows `running` beside its answer.
- Notes are numbered (`N3`); when Claude's answer writes `[done N3]`, the note offers a **Done** button.
- A checkpoint another session of the project saved is kept when this one saves its own, and this session's start, the Diff tab's default base, is never deleted to make room.
- A file's diff and its restore take its name literally: a name holding `*`, `[` or a leading `:` is that file and no other.

## 0.3.4 (2026-10-05)

### Workspace (`sc-workspace`)

- The base dialog keeps every choice on one line: a long label is cut to what the change counts leave, and a label of several lines is joined into one.
- The base dialog counts what changed since each checkpoint when it opens, the session start included, instead of showing `…` until the Checkpoints tab is opened.
- On a narrow pane the tabs move to a new row instead of wrapping inside, and an unselected tab has a light background.
- The Diff tab's base reads as a select, on a light background.

## 0.3.3 (2026-10-04)

### Accounts (`sc-accounts`)

- Refreshing (the pane's Refresh button or `/sc:accounts refresh`) reads the status band's model and effort again too.
- An effort changed with `/effort` shows on the band at the next status read, instead of waiting for the next request.

## 0.3.2 (2026-10-04)

### All plugins

- A duration shows its second unit in two digits, with a space between the units: `2h 05m`, `5d 04h`. A duration under an hour stays one unit, such as `7m`.

### Accounts (`sc-accounts`)

- The pane's gauges are six cells wide, as the status band's are, so more windows fit on one row.
- A reset line puts the time left right after the time, without a space: `↻ 17:00(3h 05m)` today, `↻ 10/7(수) 11:00(2d 20h)` or `↻ Wed 10/7 11:00(2d 20h)` on another day.

## 0.3.1 (2026-10-04)

### All plugins

- With both panes open, Claude Code's tabs read `SC-Accounts` and `SC-Workspace`, and each pane keeps its header, `SimpleCORE Mods: Accounts` or `SimpleCORE Mods: Workspace`, a row below the tabs.

### Accounts (`sc-accounts`)

- After a switch made in another session, a response's usage figures are no longer filed under the account the switch replaced. Each session checks the login Claude Code is configured with before filing them, and looks the account up again when it differs.
- Switching in one terminal reaches the others within about two seconds, each showing the new account with its own figures: every session watches Claude Code's config, and on a new login reads the live account again and shows the figures the switching session looked up. On macOS without `~/.claude/.credentials.json`, where Claude Code may keep the previous login for up to 30 seconds, a response's figures are not filed for 35 seconds after a switch.
- An account another session has just switched to cannot be removed, and a removed account's figures leave the readings every session shares.
- Reading the live login runs once at a time, however many callers ask, and a slow status read is never overlapped by the next.
- A tool missing on the machine (git, gh, a shell) empties its part of the status instead of stopping every status read; the task and ULTRACODE are read from Claude Code's config directory, so `CLAUDE_CONFIG_DIR` is followed.
- The status band's gauges are six cells wide, two fewer than the pane's, so the band keeps to one line on narrower terminals.
- The status band leads with the live account, followed by the model and effort.
- A lookup of the live account files nothing when the login changed between reading whose it is and asking for its usage.
- The live account's five-hour and weekly figures follow the session's latest response, which needs no lookup and meets no rate limit; a figure filed wrongly is put right by the next response.
- On Linux and WSL, writing a saved credential, the live login or the webhook token over a file that already exists narrows it to owner-only (mode 600) first; before, such a file kept the mode it had.
- On Windows, a removed account's saved credential is deleted by PowerShell's `Remove-Item -LiteralPath`, with the path inside an encoded script, so a path holding `%`, quotes or spaces is deleted as it is.
- ULTRACODE is read from the session's transcript wherever Claude Code put it: a project folder name over 200 characters is cut and hashed as Claude Code does, and a transcript not in the folder named after the directory (such as one Claude Code named after a path it resolved through a link) is found by searching the project folders. A transcript scan stopped by the time limit is tried again; only a shell that cannot be started stops the reading for good.

### Workspace (`sc-workspace`)

- A reload no longer takes a new "Session start" checkpoint: the session's own start stays the Diff tab's base.
- On Windows, restoring a checkpoint deletes the files made since it, and the session's snapshot index is deleted when it ends, by PowerShell's `Remove-Item -LiteralPath` with the paths inside an encoded script; worktree paths under the profile directory are shortened to `~`.
- Pressing a file on the Diff tab no longer leaves the pane blank when its diff is long or has a very long line, such as a changed SVG: each line is cut at 400 characters and the diff at 9,500, under the 10,000 Claude Code draws in one block.

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
