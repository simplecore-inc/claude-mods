---
name: toolbox
description: Write or change a project's SimpleCORE Toolbox file, `.toolbox/toolbox.json`, the list of shell commands, Claude slash commands and prompts the Toolbox pane runs and stops. Use when asked to add, edit, remove or organise toolbox tools, to register build tasks (npm, pnpm, yarn, Vite, Maven, Gradle, Cargo, make, just, docker compose, go, Python) as tools, to give a tool parameters that are fixed or asked at each run, or to decide what of `.toolbox/` is shared through git. Triggers - toolbox, 툴박스, 도구 등록, 명령 등록, 빌드 명령, 스크립트 실행 버튼, sc:toolbox.
---

# Toolbox file

The Toolbox pane (`/sc:toolbox`, or the band's toolbox cell) runs what `.toolbox/toolbox.json` in the project's root lists. The pane reads the file each time it opens, so an edit shows the next time it is opened; nothing else needs restarting.

## The folder

```
.toolbox/
  toolbox.json   the tools (this skill's subject)
  .gitignore     written once by the pane: `logs/` and `state.json`
  logs/<id>.log  each shell tool's last run, kept by the pane
  state.json     the values each tool was last run with, kept by the pane
```

Whether the tools are shared is the person's choice, made in `.toolbox/.gitignore` or the project's `.gitignore`. Do not change those files unless asked; when asked to share the tools, make sure `toolbox.json` is not ignored, and leave `logs/` and `state.json` ignored.

## The format

```json
{
  "version": 1,
  "tools": [
    {
      "id": "dev",
      "name": "dev server",
      "kind": "shell",
      "run": "pnpm run dev",
      "cwd": "apps/web",
      "group": "npm"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Unique within the file, lowercase words joined by `-`. Generated from `name` when absent. It names the tool's log file, so keep it once set. |
| `name` | yes | What the pane's row and tile show. Short: a tile is one line. |
| `kind` | yes | `shell` (a command run in the background, with a live log and a stop button), `claude` (a slash command, run when Claude is idle), or `prompt` (text for Claude). |
| `run` | yes | The command, the slash command with its arguments (`/compact keep the API notes`), or the prompt. `{{name}}` marks a parameter. |
| `cwd` | no | `shell` only: the folder to run in, relative to the project's root. Never absolute, never `..`. |
| `params` | no | Settings for the `{{name}}`s in `run` (below). A name with no entry is asked at each run, as free text. |
| `submit` | no | `prompt` only: `true` sends the prompt at once; absent or `false` puts it in the prompt box for the person to send. Default to absent. |
| `confirm` | no | `true` asks "Run <name>?" before each run. Set it on commands that cannot be taken back: `/clear`, `/reload-plugins`, a deploy, a database reset. A tool that asks for values already asks, so it needs no `confirm`. |
| `group` | no | Where it came from (`npm`, `gradle`, `claude`, `custom`): informational. |

A tool missing `name`, `kind` or `run` is left out and the pane names it as a problem; keep the file valid JSON. The pane changes only the entry it saves or removes, so other entries, broken ones and fields it does not know stay as written; two entries given one `id` are run as `<id>` and `<id>-2`, so give each its own.

## Parameters

```json
"params": {
  "module": { "type": "choice", "mode": "ask", "choices": ["api", "web"], "value": "api" },
  "spec": { "type": "path", "mode": "ask", "pathKind": "file", "glob": "*.test.ts", "remember": true },
  "profile": { "type": "text", "mode": "fixed", "value": "dev" }
}
```

| Field | Meaning |
| --- | --- |
| `type` | `text`, `path` (typed with suggestions from the project's folders), or `choice` (picked from `choices`). |
| `mode` | `ask`: asked in a dialog at each run. `fixed`: always `value`. |
| `value` | The fixed value, or for `ask` the value offered first. |
| `choices` | `choice` only: the values to pick from. |
| `pathKind`, `glob` | `path` only: `file`, `dir` or `any`, and a name filter such as `*.ts`. |
| `remember` | `ask` only: offer the value given at the last run first (on unless `false`). |

In a `shell` command each value is quoted as one shell word, so a path with spaces stays one argument. Write `{{name|raw}}` only when the value must be split or read by the shell (several flags in one value), and say so to the person, since such a value runs as written. In `claude` and `prompt` tools values go in as written.

## Choosing what to register

Read the project's build files and register what the person runs by hand, under the runner the project uses:

| Project has | Run with |
| --- | --- |
| `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, else `package-lock.json` | `pnpm run <script>`, `yarn run <script>`, `bun run <script>`, `npm run <script>` |
| `vite.config.*` with no script running Vite | `npx vite`, `npx vite build`, `npx vite preview` (or the runner's exec) |
| `pom.xml` (`mvnw` if present) | `./mvnw <goal>`; one module: `./mvnw -pl {{module}} -am {{goal}}` with `module` a `choice` of the `<module>`s |
| `build.gradle(.kts)` (`gradlew` if present) | `./gradlew <task>`; one subproject: `./gradlew {{project}}:{{task}}` with `project` a `choice` of `settings.gradle`'s includes (`:api`) |
| `Cargo.toml` | `cargo build`, `cargo test`, `cargo run --bin <name>`; one member: `cargo {{command}} -p {{package}}` |
| `Makefile`, `justfile` | `make <target>`, `just <recipe> {{arg}}` |
| `compose.yaml` | `docker compose up`, `docker compose logs -f {{service}}` |
| `go.mod`, `pyproject.toml` | `go test ./...`; a `[project.scripts]` entry, under `uv run` or `poetry run` when the lockfile is there |

A long-running command (a dev server, `docker compose up`, a watcher) is a good `shell` tool: the pane shows it running and stops it, its children included. A command that waits for keyboard input cannot be answered from the pane; do not register one.

Useful `claude` tools: `/clear`, `/compact {{instructions}}`, `/reload-plugins`, `/reload-skills`, `/review`, `/cost`. Running `/reload-plugins` reloads the Toolbox too, which stops its running shell tools.

## Checking

After writing the file, parse it (`node -e "JSON.parse(require('fs').readFileSync('.toolbox/toolbox.json','utf8'))"` or `python3 -m json.tool .toolbox/toolbox.json`), check every `id` is unique and every `{{name}}` in `run` is spelled as in `params`, and tell the person to open `/sc:toolbox` to see the tools.
