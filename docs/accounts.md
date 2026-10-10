# Accounts

Plugin `sc-accounts`, folder `mods/accounts`. [Back to the overview](../README.md)

> [!IMPORTANT]
> Clicks reach this plugin only in Claude Code's fullscreen mode (`/tui fullscreen`). In the default mode, use the keyboard: `ctrl+x` `Tab`, then `Tab` and `Enter`. See [Clicking and the keyboard](../README.md#clicking-and-the-keyboard).

Keeps several Claude logins on this machine and switches every running session to any of them in one step. It shows each account's five-hour, weekly and per-model usage, and puts the session's status in a band above the prompt.

![The accounts pane: a card per account with usage bars and reset times](images/accounts-pane.svg)

## Commands

| Command | What it does |
| --- | --- |
| `/sc:accounts`, `/sc:accounts accounts` | Opens the pane on its Accounts tab |
| `/sc:accounts list` | Prints every account with its limits and reset times |
| `/sc:accounts use <n\|email>` | Switches to an account by its number in the list, its email, or a prefix only one email starts with |
| `/sc:accounts remove <email>` | Removes a saved account named whole, by its email in any case or its account id; the account in use cannot be removed |
| `/sc:accounts refresh` | Looks up every account's limits now, past the automatic schedule |
| `/sc:accounts add` | Explains how to add an account |
| `/sc:accounts band on\|off` | Shows or hides the status band |
| `/sc:accounts usage` | Opens the pane on its Usage tab |
| `/sc:accounts storage` | Opens the pane on its Storage tab |
| `/sc:accounts webhook` | Opens the webhook settings (optional, see [Webhook](#webhook)) |

## Adding and switching accounts

1. The account you are logged in with is saved when the mod starts.
2. Log in to another account with `/login`. Within a minute the mod saves it as well.
3. Press **Switch** on its card and confirm in the dialog, or run `/sc:accounts use`. Every running Claude Code session on the machine uses it from its next request; nothing is restarted and no login is repeated. The dialog, like the one that removes an account, holds the keyboard on **Cancel** first, so an Enter meant for the prompt never switches the login.

   Every change of the login is recorded, one JSON line each, in `~/.claude/sc-accounts/login-changes.jsonl`: each switch (`switch`) with the time, the session's folder, the version, whether the dialog or the command asked for it and what it did about Orca; each change Orca made (`orca`); each Orca selection sc-accounts asked for (`follow`); and each change made by neither (`outside`). A change is explained once the login has stood still for ten seconds, in a toast as well, so a login that changed by itself is noticed at once, and a write that passes through another login on its way back says nothing.

   A window opened before the switch takes it up too: Claude Code reads the stored login again before it refreshes a token, so that window refreshes the new login instead of writing back the old one. When the login Claude Code holds is rejected outright, as a token already spent elsewhere is (the profile endpoint answers 401 or 403, or the token is empty), and the account `~/.claude.json` names has a saved login that works without a refresh, sc-accounts puts that saved login back, records it as `heal` and says so in a toast. A saved login that needs refreshing first is left to `/login`, as several sessions refreshing it at once would spend it too.

### With Orca

[Orca](https://www.onorca.dev) can keep Claude logins of its own. While one is selected there, Orca writes it into Claude Code's login each time it launches Claude, fetches the rate limits or starts, which puts back any login changed elsewhere. sc-accounts works with it, and without it:

| Orca | A switch | A login changed elsewhere |
| --- | --- | --- |
| Not installed | is made here | is taken up and said |
| Running, leaving Claude's login alone (no account selected) | is made here | is taken up and said |
| Running, with an account selected | is made here and the account selected in Orca too; an account Orca holds no login for is refused, with how to add it, as Orca would put its own back | made in Orca: said as Orca's. Made outside both (a `/login` in another terminal) to an account Orca keeps: selected in Orca too, so Orca keeps it; to one it does not keep: said, with the account Orca will put back |
| Installed, not running | is made here, and the account selected in Orca once it answers again, so the login Orca writes on starting is replaced within a minute | is taken up and said |

The switch dialog says when Orca is switched too. sc-accounts reaches Orca where its running app says in `orca-runtime.json` (in `~/Library/Application Support/orca` on macOS, `$XDG_CONFIG_HOME/orca` or `~/.config/orca` on Linux, `%APPDATA%\orca` on Windows, or `ORCA_USER_DATA_PATH`), as Orca's own CLI does: its Unix socket through `perl`, which macOS and Linux carry, and its named pipe on Windows through PowerShell.

Orca writes the copy of the account selected in it as it is while a Claude terminal runs in Orca, even when the copy has expired; every running session then refreshes the same refresh token at once, and all but the first are signed out. So sc-accounts refreshes each copy Orca keeps (on macOS a keychain item, elsewhere `.credentials.json` in the account's folder under `claude-accounts` in Orca's data folder, or under `~/.local/share/orca` for an account Orca keeps in WSL) within an hour of its expiry, checking every few minutes, and writes the new login to Orca's copy and to its own; a lookup of such an account refreshes both the same way. Where the two copies hold different refresh tokens (one rotated and the other left on the spent token, or two logins made apart), the one that expires later is refreshed first, the other when the server refuses it, and the one that refreshes is written to both. The live account and the one selected in Orca are left to Claude Code and Orca. A login the server refuses in both copies is said once, with the account to sign in to again before selecting it in Orca. A folder counts only where Orca's own marker in it (`.orca-managed-claude-auth`) names the account. Where no copy can be reached, the account is not refreshed here and its card keeps the last figures until it is next in use.

A switch, here or in Orca, changes the account's token and keeps the MCP connectors' and plugins' authorizations (`mcpOAuth`, `mcpOAuthClientConfig`, `mcpXaaIdp`, `mcpXaaIdpConfig`, `pluginSecrets`) as the live login holds them, so a connector authorized after an account was saved stays authorized.

Removing an account (`✕`) asks in a dialog first. Remove (or Enter) deletes its saved credential: the keychain item on macOS, the vault file elsewhere. Using it again takes a new `/login`. Esc or Cancel closes the dialog.

## The accounts pane

The pane has the tabs **Accounts**, **Usage** and **Storage**; a digit switches them.

### Accounts

- One card per account. The account this session's requests go out under is outlined, with a filled dot: Claude Code's login on this machine, marked **active**. Where the Claude desktop app runs the session on its own login (it names that account in `CLAUDE_CODE_ACCOUNT_UUID`), that account's card is the outlined one, marked **this session**, with a note that a switch changes the machine's login and not this session's; the machine's login keeps its **active** mark. `/sc:accounts list` marks it `[this session]`.
- A usage bar for each window, and under it the reset time in local time with the time left, such as `↻ 17:00(3h 05m)` today, or `↻ Wed 10/7 11:00(2d 20h)` on another day. Windows that reset together, such as the weekly limit and a model's weekly limit, share one cell and one reset line. In a weekly window's last three days its labels and reset line turn yellow, then orange the day before, then red on the day it resets, counted in local calendar days; the five-hour window stays as it is.
- Beside each email, how long ago its figures were looked up, to the minute, such as `(updated 12m ago)`. Under a minute it shows nothing.
- `◷` beside an account: its last lookup was rate limited, so the figures are the previous reading's. It clears on the next successful lookup.
- `Spent past the plan: 12.34 USD of 50.00 USD`: what the account spent beyond its plan, exactly as Claude's usage lookup reports it for that account. It shows only when spending past the plan is on or something was spent; nothing is estimated.
- Under the Claude cards, where the Codex CLI runs, a **Codex** card: the Codex login this session's Codex uses (its email and plan, an API key, or that no one is logged in), its windows on the same gauges, and its credits, such as `Credits 62,500`. It is read from `codex app-server` (`account/read` and `account/rateLimits/read`) in the environment the session started in, so where `CODEX_HOME` is set (Orca sets it per account) it is that folder's login. It is looked up while the pane is open, at most every five minutes, and at once on **Refresh**; a lookup that takes over 15 seconds is given up, and the figures before stay with the reason. `/sc:accounts list` prints it as a last line. The card shows the login and does not switch it.
- The footer: **Refresh**, **Add account** and **Webhook**. **✕ Close** is at the right of the header, the first row of the pane.

### Usage

![The Usage tab: tokens on this machine by day, model and project](images/accounts-usage.svg)

Tokens used on this machine, every account together, counted from Claude Code's session transcripts, subagents' included:

- The period: the last 7 or 30 days, or everything counted.
- Input, output, cache read and cache write tokens, the cache reuse (cache reads over input plus cache reads), and the sessions and responses.
- Tokens by day, as bars, and the top models and projects with their sessions.

The first count reads every transcript and takes a few minutes for gigabytes of them; the tab says how far it has got, and a count stopped by closing the tab goes on where it stopped. After that only what the transcripts gained is read. The counts are kept in `~/.claude/sc-accounts/usage-index.json`. Counting needs a POSIX shell (`sh`, `head`, `tail`, `awk`); on Windows only Git Bash or WSL has one.

### Storage

![The Storage tab: session records by kind and project, and the cleanup](images/accounts-storage.svg)

What Claude Code keeps under `~/.claude`:

- Session transcripts, subagent transcripts, and tool output and images, with their sizes.
- Each project folder: its sessions, size and last activity.
- The other folders under `~/.claude` of a megabyte or more.
- Claude Code's own cleanup: it deletes sessions idle longer than `cleanupPeriodDays` (30 days unless set in `~/.claude/settings.json`).

**Clean up** deletes every session idle longer than the age picked (7, 14, 30 or 90 days): its transcript, its subagents' transcripts and its tool output. The dialog names how many sessions and how much space and deletes only when `delete` is typed in it; what it deletes then is the sessions it named that are still idle. The session running here is never deleted, nor one a running Claude Code process names with `--resume`, `-r` or `--session-id`, however long it has been idle. Every transcript is counted for the Usage tab first, so the usage figures keep their tokens. A deleted session can no longer be resumed.

### The header

- The header names the pane, `[SC] Accounts`, and shows the version and release date. With the workspace pane open too, Claude Code shows the two as tabs, `Accounts` and `Workspace`, and the header stays, a row below the tabs.

## The status band

![The status band above the prompt](images/status-band.svg)

A band above the prompt, under a dim rule. It stays on one line and wraps only when the terminal is too narrow:

- the account this session's requests go out under: the desktop app's own where the app runs the session on its own login (by the email the app passes when sc-accounts has not saved it), else the live account
- the model, effort (or ULTRACODE) and fast mode
- the current task
- the session's context gauge, and five-hour and weekly usage; the weekly label and its reset turn yellow three days before the reset, orange the day before and red on the day
- the directory, branch and PR
- the lines added and removed, on a filled block

Some cells open a pane when pressed, and pressing again closes it:

| Cell | Opens |
| --- | --- |
| The account's name | the accounts pane |
| The directory and branch, or the lines changed | the workspace, on its Diff tab |
| ⚒ Toolbox | the [toolbox](toolbox.md) buttons, when `sc-toolbox` is installed; the cell says what its tools are doing (`· 1 running`, `· 1 failed`) |

A pane opened this way shows at any terminal width. A pressed cell keeps its colours under the pointer.

### Where the status comes from

The mod reads the status itself, so no status line command is needed, and the row Claude Code keeps under the prompt for one is not drawn.

| Field | Read from |
| --- | --- |
| Model | the session's model |
| Effort | this session's own: the level its `/effort` names, as it runs, and the effort of each main-loop request (a subagent's are left out). When the session starts, the level its settings give the model, as Claude Code settles it from each settings file; `/effort` picked from its list shows once it saves the level, or at the next request. A level another window saves is a default for new sessions and changes no other session's band. A reload and `/clear` keep it |
| Fast mode | the `fastMode` setting |
| ULTRACODE | the session's transcript, where each switch is recorded; only what was appended since the last read is scanned. It needs a POSIX shell (`sh`, `head`, `tail`, `grep`, `awk`), which Windows has only with Git Bash or WSL; without one, ULTRACODE is not shown |
| Task | the in-progress item of the session's newest todo list (`todos/` under Claude Code's config directory) |
| Directory and branch | the session's working directory and `git branch --show-current` |
| PR | `gh pr view` for the branch, at most every three minutes; nothing without `gh` |
| Context | the session's context reading |
| Lines added and removed | each Edit, MultiEdit, Write and NotebookEdit call: the file before and after, compared line by line |

## Subagent models in the agent list

Claude Code's agent list shows a subagent's task but not what it runs on. sc-accounts adds the model and effort after the task:

```
Review auth · Opus 5.5 (high)
Check label.ts · Sonnet 5.5 (medium)
Say ok · Haiku
```

| The agent | Its label |
| --- | --- |
| `general-purpose`, a fork, an agent file's `model: inherit` | the parent's model and effort |
| an agent file with `model:` (and `effort:`) | that model, and that effort |
| the Agent tool's `model` option | that model; the parent's effort only when it is the same model |
| Explore, Plan and the other built-in agents | none: the engine chooses their model |
| a plugin's agent (`codex:read`) | none: the plugin labels its own |

Where the model cannot be known before the agent starts, the row is left as it was.

- The label is added by an `agent.spawn` hook before the subagent starts, to the description the agent list shows.
- Agent files are read from the project's `.claude/agents/` and then from `agents/` in Claude Code's config directory (`~/.claude/agents/`, or `$CLAUDE_CONFIG_DIR/agents/`), matched by their `name`. An agent file in a subfolder, an agent defined in settings, a flag or policy, and an agent file with no `model:` line go unlabelled.
- The effort is the agent file's `effort`, else that of the parent's latest request when the agent runs on the parent's model; another model may take no effort at all.
- An alias of the parent's family is the parent's model (`opus` under Opus 5.5 reads `Opus 5.5 (high)`); any other alias reads as its name without a version: `haiku` is `Haiku`. An agent file's `effort` is shown even when the Agent tool's `model` option replaces its model.

Adapted from the `agent-models` plugin of [alex2481kobe/claude-mods](https://github.com/alex2481kobe/claude-mods) (Apache License 2.0).

## Codex as a subagent

Where the [Codex CLI](https://github.com/openai/codex) is installed, Claude can start OpenAI Codex with the Agent tool as it starts any other subagent. No Claude model runs inside the agent: sc-accounts drives `codex app-server` in its place.

- The agent list shows it with its model and effort (`· Sol 6.1 (xhigh)`), its running time and its token count. The count is Codex's current context plus what it wrote, as Claude Code counts a Claude subagent.
- Its activity line follows Codex's work, and Enter opens its view, where Codex's steps appear as they happen.
- It runs in the background, and its report comes back to Claude.
- A message sent to it resumes the same Codex session. A message Claude sends while Codex works joins Codex's running turn; one typed in the agent's view waits for the turn to end.
- When Codex asks for an approval or an answer, the agent reports the question, and its next message answers it in the same paused turn.
- Stopping the agent stops Codex, and so does Claude Code exiting or crashing.

| Agent type | Shown as | Sandbox and approvals | Use it for |
| --- | --- | --- | --- |
| `sc-accounts:codex-read` | `Codex read-only` | `read-only`, approvals off | second opinions, review, research, scoping |
| `sc-accounts:codex-write` | `Codex workspace-write` | `workspace-write`, approvals off | bounded implementation in the working directory |
| `sc-accounts:codex-run` | `Codex` | your Codex config, changed by flags | anything else Codex can be set up to do |

### Requirements

- macOS or Linux: the agent talks to Codex through a named pipe. On Windows the agent types are not offered.
- The Codex CLI with `codex app-server` (tested on 0.159 and 0.160), installed and logged in, on the `PATH` Claude Code starts with:

  ```sh
  npm install -g @openai/codex
  codex login
  ```

  The agent types are offered when a session starts and `codex` is found; install it, then run `/reload-plugins`.

### Use

Ask Claude for it by name:

> Have sc-accounts:codex-read review the changes in src/auth and report anything risky.

Codex cannot see the conversation with Claude, so Claude gives it a self-contained prompt. Codex uses your own Codex login, model and config.

The Agent tool's `model` option names Claude models, so Codex is set up in the prompt. The prompt may open with Codex CLI flags, one per line, spelled as `codex exec --help` spells them (`model: gpt-6-astra`, `--sandbox workspace-write`, or a flag alone on its line). They are passed to Codex and removed from the task. `Model:` and `Effort:` may be written in any case:

```
model: gpt-6-astra
effort: high
Review app.js for bugs and report back.
```

The agent types' descriptions list the models your Codex knows (from `models_cache.json` in `CODEX_HOME`, else `~/.codex`), so Claude can be asked in plain words.

Only an exact option line is an option: a flag's name with one plain value (a path, or a config `key=value`, may hold spaces), or a flag that takes no value alone on its line. The first line that is not one starts the task, so a prompt that opens with prose such as `search: every call to fetch` is passed to Codex whole.

`codex-read` and `codex-write` take `model`, `effort` and the flags that leave their sandbox alone; `sandbox`, approvals, `add-dir` and `cd` are refused there. `codex-run` takes every flag that applies to a session sc-accounts drives:

| Flag | What Codex gets |
| --- | --- |
| `model`, `effort` | `model`, `model_reasoning_effort` |
| `sandbox` (`s`) | `sandbox_mode` |
| `ask-for-approval` (`a`) | `approval_policy` |
| `approve-for-me` | the automatic reviewer, in `workspace-write` |
| `dangerously-bypass-approvals-and-sandbox` | `danger-full-access` with approvals off |
| `add-dir` | an extra writable root, beside your config's |
| `search`, `local-provider`, `cd` (`C`), `image` (`i`) | live web search, the model provider, the folder, images |
| `config` (`c`), `enable`, `disable`, `strict-config` | passed as given |
| `ephemeral`, `output-schema` | an unsaved session, a JSON Schema for the answer |

Everything left out comes from your Codex config. An option line for a flag `codex app-server` has no use for (`profile: fast`, `worktree`, `json` and the like) stops the run with the reason rather than being dropped.

### Answering Codex

When Codex asks for something, the agent hands the question back:

```
Codex asks to run:
  printf 'hi' > note.txt
in /path/to/project
Reason: requires approval by policy
Reply "approve", "approve for session", "decline", or "cancel" (decline and stop the turn).
```

Claude answers it or asks you, then sends the reply to the agent as a message, and Codex carries on in the same turn. Questions for the user and MCP servers' forms work the same way. A question lives as long as the Codex that asked it: once that Codex is gone (it exited, the session was resumed, or the plugin reloaded), a reply such as "approve" is not sent as a new task, and the agent says the question has expired.

Who Codex asks is set by its config. With `approvals_reviewer` set to Codex's automatic reviewer, Codex never asks. To be asked, for one agent:

```
ask-for-approval: on-request
config: approvals_reviewer="user"
Create note.txt containing hi.
```

### Commands in the agent's view

Open a codex agent's view (select it in the agent list, press Enter) and run a command. The reply shows above the prompt in that view, and neither Codex nor Claude is sent it:

| Command | What it does |
| --- | --- |
| `/codex-model <id>` | the Codex model, from the agent's next Codex turn |
| `/codex-effort <level>` | the reasoning effort, from the next turn |
| `/codex-sandbox <read-only\|workspace-write\|danger-full-access>` | the sandbox, from the next turn |
| `/codex-approvals <on-request\|never>` | when Codex asks for approval, from the next turn |
| `/codex-status` | what Codex said the session ran with at its last turn, what changes next turn, the Codex session and its running token total |
| `/codex-help` | the list |

A setting is kept for that agent and goes with each of its later Codex turns. `codex-read` and `codex-write` refuse `/codex-sandbox` and `/codex-approvals`. While a codex agent's view is open, the footer and the `/` menu list these commands alone: Claude Code's own commands act on the main session, not on the agent, so they are hidden there (typed in full, they still run). Elsewhere the `/codex-` commands are hidden. The commands' replies are in English, as Claude reads them too when it sends a command with SendMessage.

### How Codex runs

- When a codex agent's loop asks its model for a response, a `turn.step` hook answers instead: it starts `codex app-server` with the agent's flags as config overrides, starts or resumes the Codex session in the session's working directory, shows Codex's messages and commands in the agent's view as they happen, and reports Codex's token usage on the agent's row.
- A plugin's child process takes its input once, so sc-accounts writes to `codex app-server` through a named pipe in a private temporary folder, which goes when the process does.
- Codex runs in a process group of its own under a small shell. Stopping the agent ends the shell and Codex with it; if Claude Code exits without stopping it, the shell sees its parent gone within a second or two and ends Codex and the folder.
- Codex's final message, or its question, goes back as the agent's report: through the `SubagentHandback` tool in an interactive session, or as the final text where that tool does not exist (headless, SDK). A report that never reached the caller is given again the next time the agent's loop runs, once.
- A step interrupted before Codex finished stops Codex, and the agent hands back only `codex: stopped before Codex finished.` The next message resumes the same Codex session with that message alone.
- Every message sent to the agent is passed to Codex once, in the sender's words: as the answer to a waiting question, added to Codex's running turn (`turn/steer`), or as a new turn of the same Codex session.

### Codex caveats

- The Agent tool's `model` and `cwd` options are ignored: Codex uses your Codex config, in the session's working directory.
- What Codex may do is decided by its sandbox, approvals and requirements, not by Claude Code's permission prompts. `codex-run` takes every flag Codex accepts, `dangerously-bypass-approvals-and-sandbox` included; Codex's own requirements (`allowed_sandbox_modes`, `allowed_approval_policies`) are the place to forbid one.
- `codex app-server` takes no profiles: set those values with `config:` lines.
- Codex's `workspace-write` sandbox keeps `.git` read-only, so `codex-write` cannot stage or commit.
- A question left unanswered keeps that Codex waiting until it is answered or the session ends.
- An agent started with `ephemeral` cannot take follow-ups.
- A message typed in an agent's view reaches the plugin only once the agent's turn has ended, so it cannot join Codex's running turn; it runs as the next turn.
- A command's reply shows above the prompt only while that view stays open.
- Claude Code may run the agent's loop again for a copy of a message it places later; Codex is not asked again, and Claude gets the one line `codex: nothing new to send to Codex.`
- Claude Code's task list (`/tasks`) names the stand-in's model, Haiku, for a codex agent. The agent keeps a Claude model so that a run the plugin does not answer (the plugin not loaded, or the session resumed without it) reaches the stand-in, which reports that Codex did not run.
- `app-server`'s protocol is Codex's own and may change between Codex releases.

Adapted from the `codex` plugin of [alex2481kobe/claude-mods](https://github.com/alex2481kobe/claude-mods) (Apache License 2.0).

## Settings

| Setting | Default | Where |
| --- | --- | --- |
| `showStatusBand` | on | `/config`, or `/sc:accounts band on\|off` |

With `showStatusBand` off, Claude Code draws the band area as it does without the mod. Everything else keeps working.

## Webhook

The webhook connects the mod to an external system, such as a team dashboard or a monitoring service, by sending the session's status to a URL you choose. **It is optional and off by default: if you have nothing to send the status to, leave it off and ignore this section.** Nothing is sent while it is off.

### When it sends

While it is on, the status is sent when it changes (the model, effort, context, usage, branch, lines changed and the rest), and every 30 seconds while nothing changes. It is never sent twice within two seconds.

### Setting it up

Press **Webhook** in the accounts pane, or run `/sc:accounts webhook`.

![The webhook settings dialog](images/accounts-webhook.svg)

The dialog has:

- **Send the status**: on or off.
- **Method**: POST sends the filled template as a JSON body. GET sends its top-level fields as query parameters, an object or array as JSON text.
- **URL**: an absolute `http` or `https` URL.
- **Bearer token** (optional): sent as `Authorization: Bearer <token>`. It is kept in the keychain (service `sc-webhook`) on macOS and in an owner-only file elsewhere, and is never shown.
- **Template**: the path of the template file, the variables it may use (the times grouped by format, each format with an example), and what it would send now.
- **Send a test**: sends once and shows the HTTP status, with the start of what the receiver answered under it. **Save** keeps the settings for every session on the machine.

The dialog's last line is the last send, test or feed: its HTTP status, or why it failed, and under it the start of the receiver's answer, as a receiver can answer HTTP 200 and still say it stored nothing. A receiver that does not answer within 10 seconds is said not to have answered. The feed sends one request at a time and lets an unanswered one go after five minutes; the status keeps updating meanwhile.

### The template

What is sent comes from the file `~/.claude/sc-accounts/webhook.json` (under `CLAUDE_CONFIG_DIR` when set). The dialog writes it from the default when it is missing. Edit it in any editor; each send reads it again and never writes it. A file still holding, byte for byte, a default an earlier release wrote is replaced with the current default when a session starts or the dialog opens; a file you edited is left as it is.

The template is JSON. A string that is one placeholder alone, such as `"{{context}}"`, becomes that value as JSON: a number stays a number, and a missing value is `null`. A placeholder inside a longer string, such as `"{{account}} on {{hostname}}"`, is put in as text.

```json
{
  "session": "{{session}}",
  "model": "{{model}}",
  "context": "{{context}}",
  "where": "{{dir}} on {{hostname}}"
}
```

| Variable | Value |
| --- | --- |
| `session` | the session id |
| `hostname`, `version` | the machine's name and Claude Code's version |
| `cwd`, `dir`, `branch` | the working directory, its last segment and the branch |
| `model`, `modelId` | the model as shown and its id |
| `effort`, `fast`, `ultracode` | the effort level, fast mode and ULTRACODE |
| `context`, `cost` | context used in percent, and the session's cost in USD |
| `linesAdded`, `linesRemoved` | lines changed by file-editing tools this session |
| `task`, `pr`, `prReview` | the in-progress task, the PR number and its review decision |
| `account` | the live account's email |
| `fiveHour`, `weekly` | the live account's five-hour and weekly usage in percent |

Each time comes in every format below. `time…` is now; `fiveHourResetsAt…` and `weeklyResetsAt…` are when the live account's five-hour and weekly windows reset, and `null` in every format when there is no such window. The dialog lists them the same way, each format with the time now as its example.

| Variables | Format | Example |
| --- | --- | --- |
| `time`, `fiveHourResetsAt`, `weeklyResetsAt` | ISO 8601 text in UTC | `"2026-10-06T09:20:00.000Z"` |
| `timeEpoch`, `fiveHourResetsAtEpoch`, `weeklyResetsAtEpoch` | Unix time in seconds, a number, as Claude Code's status line input gives reset times | `1791278400` |
| `timeEpochMs`, `fiveHourResetsAtEpochMs`, `weeklyResetsAtEpochMs` | Unix time in milliseconds, a number; `timestamp` is the same as `timeEpochMs` | `1791278400000` |
| `timeLocal`, `fiveHourResetsAtLocal`, `weeklyResetsAtLocal` | this computer's local time with its offset from UTC, text (RFC 3339) | `"2026-10-06T18:20:00+09:00"` |

The default template takes the shape of Claude Code's status line input (`session_id`, `model`, `context_window`, `cost`, `rate_limits` and the rest), its `resets_at` in Unix seconds as that input has them, so a receiver written for that input keeps working.

## How it works

- **Storage.** On macOS each saved account's OAuth credential is one keychain item under the service `account-switch`, keyed by account id; the secret travels to `security` on stdin as hex, never in a command line. On Linux, WSL and Windows, where Claude Code keeps its own login in `~/.claude/.credentials.json`, each saved credential is `~/.claude/account-switch/<account id>.json` (`CLAUDE_CONFIG_DIR` replaces `~/.claude`). On Linux and WSL it is written owner-only (mode 600) through stdin, and a file already there is narrowed to 600 before the write; on Windows it inherits the profile directory's access list. Only the account details that hold no secret (the `oauthAccount` value of `~/.claude.json`) are kept in the plugin store.
- **Switching.** On macOS the chosen credential is written to the keychain item Claude Code reads, named as Claude Code names it (`Claude Code-credentials`, with `-` and eight hex digits of a SHA-256 of the folder when `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set, under the user's name as its account), and to `.credentials.json` when that file exists; elsewhere it is written to `.credentials.json`. `oauthAccount` in `~/.claude.json` is set to the account's details. Each write takes Claude Code's own lock first (`.storage-write.lock` beside `.credentials.json` for the login, `~/.claude.json.lock` for the config), and each file is replaced whole through a temporary file beside it, so Claude Code never reads half a write; `~/.claude.json` is read again under its lock and only `oauthAccount` changes. A switch whose write fails puts back the login that was there, and the record marks it `failed`. Claude Code compares the modification time of `.credentials.json` before it uses a token, so a running session picks up the new login from its next request. Where the file does not exist, the change lands once Claude Code's keychain cache expires (30 seconds).
- **Telling accounts apart.** When the login changes, the mod asks the profile endpoint whose token it is before filing it, so a token is never saved under the wrong account. A login older than the one saved for its account (another refresh token that expires sooner) is used but never filed over it, so a window writing back an old login never replaces a newer one. Each account's usage is looked up with that account's own token.
- **Usage lookups.** The automatic lookup runs once every five minutes across the machine, and every running session shares its result. A 429 pauses automatic lookups for `Retry-After`, or without it for five minutes doubling up to an hour. **Refresh** and `/sc:accounts refresh` always look up at once. The usage and profile lookups wait at most 15 seconds; past that the card says which did not answer.
- **The live account.** Its figures are updated from every response Claude Code receives, and looked up every two minutes when there is none. A response to a turn that began before the account changed belongs to the previous account, so it prompts a lookup instead of being applied. Where the desktop app runs the session on its own login, every response's figures are that account's, from the session's first turn.
- **Token refresh.** When an inactive account's access token nears expiry, the mod refreshes it and saves the rotated refresh token, under a lock of that account's (`~/.claude/sc-accounts/locks/refresh-<account id>.lock`) and after reading the saved login again, so two sessions never spend one refresh token. A refresh that answers after its 30 seconds is still saved. The grant Claude Code holds (the same refresh token) is Claude Code's to refresh and is never refreshed here, even while the config names another account, nor is an account Orca keeps a login for, whose copies are refreshed together instead (see [With Orca](#with-orca)). An account whose refresh is refused asks for a new login.

## Caveats

- The usage lookup (`/api/oauth/usage`), the profile lookup and the token refresh use endpoints with no public documentation, which may change without notice.
- One login is active per machine: switching moves every running Claude Code session to the chosen account.
- Orca's runtime endpoint, its `accounts.list` and `accounts.selectClaude` requests and where it keeps each account's copy (the keychain item `Orca Claude Code Managed Credentials`, the `claude-accounts` folders and their marker) are Orca's own, with no public documentation, and may change. Reaching it needs `perl` on macOS and Linux and PowerShell on Windows; the Windows path, through Orca's named pipe, is untested.
