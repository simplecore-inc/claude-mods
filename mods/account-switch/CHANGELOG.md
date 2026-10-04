# Changelog

The release date shown at the top of the accounts pane is read from this file: the heading whose version matches `version` in `plugin.json`, written as `## <version> (<YYYY-MM-DD>)`.

## 0.1.0 (2026-10-04)

- Switches between saved Claude logins the moment one is chosen. The credential is written to the keychain and to `~/.claude/.credentials.json`, so running sessions use the new account from their next request.
- Shows every saved account's five-hour, weekly and per-model usage with reset times in the accounts pane, the prompt footer and `/sc:accounts list`.
- Looks usage up automatically once every five minutes across the machine and shares the result between sessions. A 429 pauses automatic lookups; Refresh always looks up at once.
- Shows English by default and Korean where Claude Code's language is Korean.
