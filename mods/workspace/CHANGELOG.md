# Changelog

The release date shown at the top of the workspace pane is read from this file: the heading whose version matches `version` in `plugin.json`, written as `## <version> (<YYYY-MM-DD>)`.

## 0.1.0 (2026-10-04)

- A workspace pane, opened with `/sc:workspace`, with four tabs: Agents, Checkpoints, Notes and Diff.
- Agents lists the session's subagents and stops a running one; it lists the repository's worktrees and removes a clean, merged one.
- Checkpoints snapshots the working tree before every prompt, shows what changed since each checkpoint, and restores one after a confirmation dialog; a restore can itself be undone.
- Notes keeps notes per project, puts one in the prompt, and can hand the open ones to the model with every prompt.
- Diff shows the files changed since the session started or since any checkpoint, and one file's diff.
