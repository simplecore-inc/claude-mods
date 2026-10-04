# Developing a mod

[Back to the overview](../README.md)

Claude Code mods are plugins of function hooks. This repository is a local plugin marketplace, `simplecore-mods`, and every mod in it is a self-contained plugin under `mods/<name>/`. The mods share one look: the same header, cards, gauges, buttons and footer.

To try a change, run `/reload-plugins` in a session: a plugin installed from a folder marketplace is read from that folder, with no reinstall. To try a mod in one session without installing it, start Claude Code with `claude --plugin-dir ./mods/<name>`.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per mod
mods/sc/                          the bundle: the /sc: commands, and every mod as a dependency
shared/                           code every mod uses: UI pieces, layout, time, locale
VERSION                           the one version every plugin carries
CHANGELOG.md                      one "## <version> (<YYYY-MM-DD>)" heading per release, with a section per mod
scripts/sync.mjs                  writes VERSION and CHANGELOG.md into each plugin, copies shared/ into hooks/shared/
docs/                             the pages each mod is described on
docs/images/                      the screens they show, captured from a running Claude Code
LICENSE                           MIT
mods/<name>/
  .claude-plugin/plugin.json      the manifest: name, version, userConfig
  CHANGELOG.md                    a copy of the root CHANGELOG.md, written by the sync script
  commands/<command>.md           slash commands, answered by a command.run hook
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              every hook, and every call on $
  hooks/*.ts                      pure functions that never touch $
  hooks/views/*.tsx               what the pane draws, from the element table and plain data
  hooks/shared/                   copies of shared/, written by the sync script
  types/index.d.ts                the $.state contract
  tests/*.test.ts(x)              run by `claude plugin test`
```

## Rules the engine enforces

- **Commands.** A command is declared as `commands/<command>.md` and answered by a `command.run` hook. Claude Code registers it as `/<plugin>:<command>`, so `commands/accounts.md` in the plugin `sc` is `/sc:accounts`. A name given to `$.command.register` cannot hold a `:`.
- **`$` stays in one file.** `$`, the engine interface, cannot be passed to a function imported from another file; `claude plugin validate` refuses it. Code that calls `$` lives in `register.tsx`, and only parsing, request building and formatting move to other files, where they are tested directly.
- **One plugin, one command prefix.** A command's prefix is its plugin's name, and only one plugin can be named `sc`. So `sc` is a bundle with no hooks: it declares every `/sc:` command in `commands/*.md` and lists the mods' plugins under `dependencies`, which `claude plugin install sc` installs with it. Each mod answers its command from its own `command.run` hook; a hook may answer a command another plugin declares.
- **No imports from outside the plugin.** A plugin may import only files inside its folder, so shared code is copied in. Edit `shared/` and run `node scripts/sync.mjs`; never edit a `hooks/shared/` copy.
- **Views take the element table, not `$`.** A view is a function of `$.ui.resolve(e)` and plain data, and a helper that runs commands takes a runner function the hooks module builds over `$.process.run`; both may live in other files.
- **A pane opened by a press shows at any width.** Claude Code places a pane at any terminal width only when the person asked for it: a command they typed, or a Button, Input or Select they worked. Opened any other way (a timer, a message from a `Client` region), it waits undrawn below 144 columns. So whatever opens a pane is a Button, and the pane is opened inside the `ui.press` chain.
- **Reserved names.** A plugin name cannot start with `claude-`, `anthropic-` or `cc-plugin-`.
- **Plugin store.** `$.store` is kept per plugin name, so renaming a plugin starts it with an empty store.

## Checks

```bash
node scripts/sync.mjs --check
claude plugin validate mods/<name>
claude plugin test mods/<name>
npx -p typescript tsc -p mods/<name>
```

`tsc` reads the `tsconfig.json` the engine writes into the mod folder at every load. `sync.mjs --check` exits 1 when a manifest's version, a changelog copy or a shared copy differs from its source.

## Releasing

1. Set the new version in `VERSION`.
2. Add its heading to `CHANGELOG.md`, `## <version> (<YYYY-MM-DD>)`, with a section for each mod it changes.
3. Run `node scripts/sync.mjs`. It refuses a version that is not semver or has no heading, writes the version into every `plugin.json`, and copies the changelog into each plugin, where the pane header reads the release date from it.

## Adding a mod

1. Create `mods/<name>/` with the layout above.
2. Add an entry to `.claude-plugin/marketplace.json`.
3. Add its command to `mods/sc/commands/` and its plugin to the `dependencies` of `mods/sc/.claude-plugin/plugin.json`, so installing `sc` brings it too.
4. Describe it on its own page under `docs/` and link the page from the README.
5. Install it with `claude plugin install <plugin>@simplecore-mods`; the marketplace is already registered.
