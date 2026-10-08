<!-- Copied from the repository's CHANGELOG.md by scripts/sync.mjs; edit that file and run the script. -->

# Changelog

Every plugin in this repository shares one version, kept in `VERSION`. `scripts/sync.mjs` writes it into each plugin's manifest and copies this file into each plugin, where the pane header reads the release date from the heading of its version: `## <version> (<YYYY-MM-DD>)`.

## 0.6.3 (2026-10-08)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window.

### Accounts (`sc-accounts`)

- Selecting an account in Orca no longer signs the running sessions out. Orca writes the selected account's saved login as it is while a Claude terminal runs in it, even when it has expired, and every session then refreshed the same token at once. On macOS, sc-accounts now refreshes the login Orca keeps for each account within an hour of its expiry and writes it to Orca's copy and its own, while both hold the same grant; the live account and the one selected in Orca are left alone.
- A saved login of Orca's that the server refuses to refresh is said once, with the account to sign in to again before selecting it in Orca.

## 0.6.2 (2026-10-06)

### Accounts (`sc-accounts`)

- The status band shows each session's own effort. A level another window saves with `/effort` is a default for new sessions and no longer changes, or flickers on, the band of a session already running.
- `/effort <level>` shows on the band at once, before the next request; a level picked from `/effort`'s list shows once it is saved, or at the next request.
- A session starts at the effort Claude Code settles from each settings file, the highest first, so a project's level outranks a per-model level in the user's settings as it does in Claude Code.
- A reload and `/clear` keep the session's effort.

## 0.6.1 (2026-10-06)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window. Workspace notes and checkpoint lists move from the plugin store into each repository's git folder, `.git/sc-workspace/`, the first time a session starts there.

### Workspace (`sc-workspace`)

- A file with Korean letters, a quote or a control character in its name is listed, opened and restored as it is; restoring a checkpoint removes such files made since it.
- A diff longer than a page is drawn as a diff on every page, coloured, its line numbers carried on.
- Text holding an escape sequence or a control character (a diff, an agent's answer, a prompt) no longer leaves the pane blank, and opening the pane drops a dialog such a draw left.
- Notes and checkpoints are kept in the repository and every change is made to the file as it stands, so two presses before a redraw, or another session's note, are never written over.
- Stopping an agent names it by its id first and says why a stop was refused or failed.
- The Memory tab is read when it opens and on Refresh, not every five seconds; the Checkpoints tab counts again only when something changed.
- Draft commit message puts its request at the cursor; replies of `notes`, `name` and `toggle` carry the click hint; snapshot indexes made in other worktrees are deleted with the session.

### Toolbox (`sc-toolbox`)

- A run's log keeps text alone: colours, cursor moves, bells and backspaces are left out, and a progress line rewritten in place shows as it now stands.
- Saving or removing a tool changes that tool alone in `toolbox.json` as it stands; two tools given one id are told apart.
- A run goes on through `/clear` and stays shown and stoppable.
- The log file keeps its newest 3 MB in bytes, so Korean output never passes the write limit.
- Enter in a value field runs with what was typed; a Claude command waiting is not queued twice; a prompt tool puts its text at the cursor.
- pnpm workspaces are read, a broken `package.json` is named instead of failing every build file, and just recipes with default or variadic parameters are offered.

## 0.6.0 (2026-10-06)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window. Two things change for what you may have written against them: `/sc:accounts remove` takes an account's whole email or its id, never a number or a prefix; and the default webhook template sends `resets_at` in Unix seconds, as Claude Code's status line input does. A template file still holding the earlier default is brought to the new one; a template you edited is left as it is.

### Accounts (`sc-accounts`)

- With [Orca](https://www.onorca.dev) writing the Claude login, a switch selects the account in Orca too, so Orca keeps it instead of putting its own back. A switch to an account Orca holds no login for is refused with how to add it there; with Orca closed, the account is selected in Orca once it answers again. A login changed outside both to an account Orca keeps is selected in Orca as well. The record names changes Orca made `orca` and selections sc-accounts asked for `follow`. On Windows, Orca is reached on its named pipe through PowerShell.
- An inactive account Orca keeps a login for is never refreshed here, and its card says why its figures age.
- Writes to Claude Code's login and `~/.claude.json` take Claude Code's own locks and replace each file whole; `~/.claude.json` is read again under its lock. A switch whose write fails puts the previous login back and is recorded as `failed`.
- The login Claude Code holds is never refreshed here, even while the config names another account, and an older copy of an account's login is never filed over a newer one saved. A saved account is refreshed under that account's lock across sessions, after reading its saved login again, and an answer that comes after its 30 seconds is still saved.
- The switch dialog no longer asks to restart the other windows: Claude Code reads the stored login again before it refreshes a token.
- A change of the login is explained once the login has stood still for ten seconds, so a write that passes through another login on its way back says nothing.
- The usage and profile lookups give up after 15 seconds. A timeout and a server's error status are said in the pane's language.
- `/sc:accounts remove` takes the whole email, in any case, or the account id.
- **Clean up** deletes only the sessions its dialog named that are still idle, and never a session a running Claude Code process resumed.
- Usage is counted by one session at a time across the machine, the lines changed are kept per session, and a lookup never writes back the figures of an account another session removed.
- A hook of sc-accounts that fails leaves the tool call, the focus or the close to Claude Code instead of stopping it.
- Webhook: each time is offered as ISO 8601 text in UTC, Unix seconds, Unix milliseconds, and local time with its offset from UTC (`timeEpoch`, `fiveHourResetsAtEpoch`, `weeklyResetsAtLocal` and the rest), and the dialog lists the times by format, each with the time now as its example.
- Webhook: under the last send the dialog shows the start of what the receiver answered, as a receiver can answer HTTP 200 and still store nothing. A receiver silent for 10 seconds is said not to have answered, and its send is let go after five minutes. Sends never write the template file.

## 0.5.4 (2026-10-06)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window, and restart a window that has been open since before the last account switch (`/exit`, then `claude --resume`): such a window can keep the previous login in memory and write it back when it refreshes or exits, which signs every window out with "Login expired".

### Accounts (`sc-accounts`)

- When the login Claude Code holds is rejected (the profile endpoint answers 401 or 403, or the token is empty) and the account `~/.claude.json` names has a saved login that works without a refresh, that saved login is put back, recorded as `heal` and said in a toast. A saved login that needs refreshing first is left to `/login`.
- On macOS, `~/.claude/.credentials.json` is brought up to the keychain's login whenever Claude Code refreshed into the keychain alone, so the other sessions drop the token that refresh spent instead of failing with it.
- The switch dialog says that windows opened before the switch should be restarted.

## 0.5.3 (2026-10-06)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window. A window keeps the plugins it loaded until then, so an earlier version keeps running there: one with a one-press **Switch** that an `Enter` can trigger, and one that records no login change.

### Accounts (`sc-accounts`)

- Every change of the login is recorded in `~/.claude/sc-accounts/login-changes.jsonl`: each switch with its time, session folder, version and whether the dialog or the command asked for it, and each change no switch of sc-accounts made.
- A login that changed with no switch of sc-accounts, in any session, is said in a toast once.

## 0.5.2 (2026-10-06)

> [!IMPORTANT]
> After updating, run `/reload-plugins` in every open Claude Code window. A window keeps the plugins it loaded until then, so an earlier version keeps running there, with a one-press **Switch** that an `Enter` can trigger.

### All plugins

- Clicks reach the panes only in Claude Code's fullscreen mode (`/tui fullscreen`). The README and each plugin's page say so up front, with the keyboard way around it, and the first pane a command opens outside fullscreen mode says so in its reply.
- A pane opened by a command, a button or the band takes the keyboard: `Tab` and the arrows move, `Enter` presses, a digit picks a tab and `Esc` closes it, with no mouse.

### Accounts (`sc-accounts`)

- **Switch** asks first in a dialog that holds the keyboard on **Cancel**, as removing an account does, so an `Enter` meant for the prompt never changes every session's login.
- A switch and a lookup refreshing a saved account's token run one at a time, and a lookup reads which login Claude Code uses before each account: an account that became live meanwhile is never refreshed with the same refresh token twice.
- A weekly window's label and reset turn yellow three local days before it resets, orange the day before and red on the day, on the band and on every card.
- The account in use reads in its Active badge's colour.

## 0.5.1 (2026-10-05)

### Workspace (`sc-workspace`)

- Diff: pressing a file opens its diff in a dialog, a page of 24 lines at a time, however long the list of files; **◂ Previous file** and **Next file ▸** move along the list without closing it, and **↺ Restore** puts the file back from there.
- Diff: a binary file's row stays one line when every count is shorter than the word `binary`.

## 0.5.0 (2026-10-05)

### All panes

- Every pane is headed `[SC] Accounts`, `[SC] Workspace` or `[SC] Toolbox`, and Claude Code's tabs for them read `Accounts`, `Workspace` and `Toolbox`.
- **✕ Close** sits at the right of each pane's header, its first row, and in a dialog **← Back** does what Cancel does, so the way out shows however short the terminal. The footers keep only the tab's own actions.
- The header, the tabs and the body follow one another with no blank row or rule between, so a short terminal shows more of the body; the release shows only where the header has room.
- The header keeps its row under Claude Code's tabs whichever two of the three panes are open.

### Toolbox (`sc-toolbox`)

- New plugin: a project's commands as buttons, kept in `.toolbox/toolbox.json`. Shell commands run and stop with everything they started, and their log is followed live in a dialog; Claude commands run once Claude is idle; prompts fill the prompt box or are sent.
- Values in a command are fixed or asked at each run, as text, a choice or a path completed as you type.
- The Add tab finds the tasks of npm, Vite, Maven, Gradle, Cargo, make, just, Compose, Go and Python projects, and lists Claude Code's commands.
- The buttons are tiles of two lines, two to a row, in a box of their own. Each says how its tool stands in words and colour: running (green, with its time and its share done, read from the output and drawn as a filling circle), waiting for Claude (yellow, blinking), done, stopped or failed; a running tool has stop and log buttons on its tile.
- A line above the tiles sums up what runs, waits and failed. A shell tool that has run opens its log when pressed, so looking at a result never runs it again; `▶` on its tile or **▶ Run again** in its log runs it. A toast says when a shell tool finishes or fails, with the toolbox open or not.
- Times say how long a run took and how long ago it ended (`done · took 3s · 2m 0s ago`), the same in the tiles and the list.
- The dialog that asks for values shows the command as it will run, filled with what is typed, and names each value plainly.
- **Before each run: Ask first** (`"confirm": true`) asks before a tool runs; `/clear`, `/reload-plugins`, `/exit`, `/logout` and `/rewind` are added with it set.
- The `toolbox` skill tells Claude how to write `toolbox.json`.

### Accounts (`sc-accounts`)

- `/sc:accounts` opens the Accounts tab, as `/sc:accounts accounts` does, rather than the tab last shown.
- The status band has a **⚒ Toolbox** cell that shows the toolbox's buttons and says what its tools are doing: running on green, waiting on yellow, failed on red until the toolbox is next opened.

### All plugins

- `sc` installs `sc-toolbox` too.

## 0.4.1 (2026-10-05)

### Accounts (`sc-accounts`)

- Every card's gauges stand in the same columns: a lone gauge takes the same width whether a reset line shows under it or not, and gauges that reset together, such as the weekly limit and a model's, stand side by side as one block.

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
