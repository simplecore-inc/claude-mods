# SimpleCORE Claude Mods

Mods for [Claude Code](https://code.claude.com): plugins of function hooks that add panes, a status band and slash commands to the terminal. The repository is a local plugin marketplace, `simplecore-mods`, and every mod in it is a self-contained plugin under `mods/<name>/`.

| Mod | Plugin | What it does |
| --- | --- | --- |
| [account-switch](#account-switch) | `sc` | Keeps several Claude logins, switches between them in one step, and shows every account's usage limits and the session status above the prompt |

## Install

```bash
claude plugin marketplace add simplecore-inc/claude-mods
claude plugin install sc@simplecore-mods
```

The plugin is installed for the user, so it runs in every session wherever Claude Code is started. Run `claude plugin update sc@simplecore-mods` and then `/reload-plugins` to take a new version.

### From a local clone

```bash
git clone https://github.com/simplecore-inc/claude-mods.git
claude plugin marketplace add ./claude-mods
claude plugin install sc@simplecore-mods
```

A plugin installed from a folder marketplace is read from that folder: after editing a mod, run `/reload-plugins` in a session to pick the change up, with no reinstall. To try a mod in one session without installing it, start Claude Code with `claude --plugin-dir ./claude-mods/mods/<name>`.

## account-switch

Keeps several Claude logins on this machine, switches the running sessions to any of them the moment one is chosen, and keeps every account's five-hour, weekly and per-model usage in view. macOS only: credentials are kept in the macOS keychain.

![The accounts pane: a card per account with usage bars and reset times](docs/accounts-pane.svg)

![The status band above the prompt](docs/status-band.svg)

### Commands

| Command | What it does |
| --- | --- |
| `/sc:accounts` | Opens the accounts pane: one card per account, with switch, remove and refresh |
| `/sc:accounts list` | Prints every account with its limits and reset times |
| `/sc:accounts use <n\|email>` | Switches to an account by its number in the list, its email, or a prefix only one email starts with |
| `/sc:accounts remove <n\|email>` | Removes a saved account; the account in use cannot be removed |
| `/sc:accounts refresh` | Looks up every account's limits now, past the automatic schedule |
| `/sc:accounts add` | Explains how to add an account |
| `/sc:accounts band on\|off` | Shows or hides the status band above the prompt |

### Adding and switching accounts

1. The account you are logged in with is saved when the mod starts.
2. Log in to another account with `/login`. Within a minute the mod saves it as well.
3. Choose an account in the pane (`⇄`) or with `/sc:accounts use`. Every running Claude Code session on the machine uses it from its next request; nothing is restarted and no login is repeated.

Removing an account (`✕`, then `✕?` to confirm) deletes its saved credential from the keychain. Using it again takes a new `/login`.

### What you see

- **The accounts pane** (`/sc:accounts`): a card per account with its usage bars. Under each bar is its reset time in local time and the time left, such as `↻ 10/7(Wed) 11:00 (2d 20h)`. Windows that reset together, such as the weekly limit and a model's weekly limit, share one card cell and one reset line. The pane header shows the mod's version and release date, as `v0.1.0 (2026-10-04)`.
- **The status band** above the prompt, on one line that wraps only when the terminal is too narrow: model and effort (or ULTRACODE) and fast mode, the current task, the live account, the session's context gauge, five-hour and weekly usage, the directory, branch and PR, and the lines added and removed.
- **`◷`** beside an account: its last lookup was rate limited, so the figures shown are the previous reading's. It clears on the next successful lookup.

### Settings

| Setting | Default | Where |
| --- | --- | --- |
| `showStatusBand` | on | `/config`, or `/sc:accounts band on\|off` |

With `showStatusBand` off, the band above the prompt is drawn by Claude Code as it is without the mod. Everything else keeps working.

The mod shows English, and Korean where Claude Code's `language` setting is Korean; any other language falls back to English. Without that setting, `LC_ALL`, `LC_MESSAGES` and `LANG` decide, in that order.

### The status line command

Some of what the band shows reaches only a status line command: fast mode, the PR, the lines changed, the effort level. To show them, configure a `statusLine` command that prints nothing and writes these fields of its input to `~/.claude/cache/statusline/<session_id>.json`. The mod reads that file every two seconds.

```json
{
  "updatedAt": 1791094518590,
  "model": "Opus 5.5",
  "effort": "low",
  "ultracode": false,
  "fast": false,
  "contextUsed": 28,
  "task": "",
  "dir": "claude-mods",
  "branch": "main",
  "pr": { "number": 12, "reviewState": "approved" },
  "linesAdded": 12,
  "linesRemoved": 3
}
```

Write it to a temporary name and rename it into place, so the mod never reads half a file. Without the file, the band shows the context, the account and its usage alone. The same command is the place for anything else that needs the status payload, such as a dashboard feed.

### How it works

- **Storage.** Each saved account's OAuth credential is one keychain item under the service `account-switch`, keyed by account id. The secret travels to `security` on stdin as hex, never in a command line. Only the account details that hold no secret (the `oauthAccount` value of `~/.claude.json`) are kept in the plugin store.
- **Switching.** The chosen credential is written to the keychain item Claude Code reads (`Claude Code-credentials`) and to `~/.claude/.credentials.json` when that file exists, and `oauthAccount` in `~/.claude.json` is set to the account's details. Claude Code compares the modification time of `.credentials.json` before it uses a token, so a running session drops its cached login and uses the new one from its next request. Where the file does not exist, the change lands once Claude Code's keychain cache expires (30 seconds).
- **Telling accounts apart.** When the login changes, the mod asks the profile endpoint whose token it is before filing it, so a token is never saved under the wrong account. Each account's usage is looked up with that account's own token.
- **Usage lookups.** The automatic lookup runs once every five minutes across the machine, and every running session shares its result. A 429 pauses automatic lookups for `Retry-After`, or without it for five minutes doubling up to an hour; Refresh in the pane and `/sc:accounts refresh` always look up at once.
- **The live account.** Its figures are updated from every response Claude Code receives and looked up every two minutes when there is none. A response to a turn that began before the account changed belongs to the previous account, so it prompts a lookup instead of being applied.
- **Token refresh.** When an inactive account's access token nears expiry, the mod refreshes it and saves the rotated refresh token. The live account's token is Claude Code's to refresh and is never touched. An account whose refresh is refused asks for a new login.

### Caveats

- The usage lookup (`/api/oauth/usage`), the profile lookup and the token refresh use endpoints with no public documentation, which may change without notice.
- One login is active per machine: switching moves every running Claude Code session to the chosen account.

## Developing a mod

### Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per mod
mods/<name>/
  .claude-plugin/plugin.json      the manifest: name, version, userConfig
  CHANGELOG.md                    one "## <version> (<YYYY-MM-DD>)" heading per release
  commands/<command>.md           slash commands, answered by a command.run hook
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              every hook, and every call on $
  hooks/*.ts                      pure functions that never touch $
  types/index.d.ts                the $.state contract
  tests/*.test.ts(x)              run by `claude plugin test`
```

### Rules the engine enforces

- **Commands.** A command is declared as `commands/<command>.md` and answered by a `command.run` hook. Claude Code registers it as `/<plugin>:<command>`, so `commands/accounts.md` in the plugin `sc` is `/sc:accounts`. A name given to `$.command.register` cannot hold a `:`.
- **`$` stays in one file.** `$`, the engine interface, cannot be passed to a function imported from another file; `claude plugin validate` refuses it. Code that calls `$` lives in `register.tsx`, and only parsing, request building and formatting move to other files, where they are tested directly.
- **Reserved names.** A plugin name cannot start with `claude-`, `anthropic-` or `cc-plugin-`.
- **Plugin store.** `$.store` is kept per plugin name, so renaming a plugin starts it with an empty store.

### Checks

```bash
claude plugin validate mods/<name>
claude plugin test mods/<name>
npx -p typescript tsc -p mods/<name>
```

`tsc` reads the `tsconfig.json` the engine writes into the mod folder at every load.

### Adding a mod

1. Create `mods/<name>/` with the layout above.
2. Add an entry to `.claude-plugin/marketplace.json`.
3. Install it with `claude plugin install <plugin>@simplecore-mods`; the marketplace is already registered.
