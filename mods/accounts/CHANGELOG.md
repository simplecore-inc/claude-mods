# Changelog

The release date shown at the top of the accounts pane is read from this file: the heading whose version matches `version` in `plugin.json`, written as `## <version> (<YYYY-MM-DD>)`.

## 0.2.0 (2026-10-04)

- Shares one look with the workspace: the pane is drawn from the same header, cards, gauges and footer, and the footer is one row tall with each label centred on one line.
- The plugin is named `sc-accounts`; the bundle plugin `sc` declares `/sc:accounts` and installs this plugin with it. The status band setting is `sc-accounts.showStatusBand`.
- Saving an account applies the change to the list every session shares, and reading the list puts back any account whose details and credential are still kept, so no session, an older build's included, can drop a saved account.

## 0.1.0 (2026-10-04)

- Switches between saved Claude logins the moment one is chosen. The credential is written to the keychain and to `~/.claude/.credentials.json`, so running sessions use the new account from their next request.
- Shows every saved account's five-hour, weekly and per-model usage with reset times in the accounts pane, the prompt footer and `/sc:accounts list`.
- Looks usage up automatically once every five minutes across the machine and shares the result between sessions. A 429 pauses automatic lookups; Refresh always looks up at once.
- Runs on macOS, Linux, WSL and Windows: the keychain holds saved logins on macOS, owner-only files under `~/.claude/account-switch/` hold them elsewhere.
- Shows English by default and Korean where Claude Code's language is Korean.
