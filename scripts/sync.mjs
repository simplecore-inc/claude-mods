#!/usr/bin/env node
// Keeps every mod in step with the repository's single sources.
//
//   shared/          code the mods share  -> mods/<mod>/hooks/shared/
//   VERSION          the one version       -> "version" in mods/<mod>/.claude-plugin/plugin.json
//   CHANGELOG.md     the one changelog     -> mods/<mod>/CHANGELOG.md
//
// A plugin reads only files inside its own folder, so each source is copied
// in. The copies are never edited by hand: edit the source, then run this.
//
//   node scripts/sync.mjs          write the copies
//   node scripts/sync.mjs --check  exit 1 when a copy differs from its source

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isCheck = process.argv.includes('--check')
const codeBanner = '// Copied from shared/ by scripts/sync.mjs; edit shared/ and run the script.\n'
const changelogBanner = '<!-- Copied from the repository\'s CHANGELOG.md by scripts/sync.mjs; edit that file and run the script. -->\n\n'

const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`VERSION holds "${version}", not a version such as 1.2.3`)
  process.exit(1)
}
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)`, 'm').test(changelog)) {
  console.error(`CHANGELOG.md has no "## ${version} (YYYY-MM-DD)" heading for the version in VERSION`)
  process.exit(1)
}
const sharedFiles = readdirSync(join(root, 'shared')).filter(name => /\.(ts|tsx)$/.test(name)).sort()
const mods = readdirSync(join(root, 'mods'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, 'mods', entry.name, '.claude-plugin', 'plugin.json')))
  .map(entry => entry.name)

let stale = 0
/** Writes `text` to `path` unless it already holds it; in check mode only reports. */
function put(path, text) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (current === text) return
  stale += 1
  const shown = path.slice(root.length + 1)
  if (isCheck) {
    console.error(`stale: ${shown}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  console.log(`wrote ${shown}`)
}

for (const mod of mods) {
  const dir = join(root, 'mods', mod)
  // The version, in the manifest the engine reads it from.
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  put(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  // The changelog, where the pane header looks for the release date.
  put(join(dir, 'CHANGELOG.md'), changelogBanner + changelog)
  // Shared code, for mods that have hooks.
  if (!existsSync(join(dir, 'hooks'))) continue
  const target = join(dir, 'hooks', 'shared')
  for (const name of sharedFiles) put(join(target, name), codeBanner + readFileSync(join(root, 'shared', name), 'utf8'))
  for (const name of existsSync(target) ? readdirSync(target) : []) {
    if (sharedFiles.includes(name)) continue
    stale += 1
    if (isCheck) console.error(`extra: mods/${mod}/hooks/shared/${name}`)
    else {
      rmSync(join(target, name))
      console.log(`removed mods/${mod}/hooks/shared/${name}`)
    }
  }
}

if (isCheck && stale > 0) {
  console.error(`${stale} file(s) out of step; run node scripts/sync.mjs`)
  process.exit(1)
}
if (isCheck) console.log(`every mod matches: version ${version}, the changelog, ${sharedFiles.length} shared files (${mods.length} mods)`)
