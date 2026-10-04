#!/usr/bin/env node
// Copies shared/ into every mod's hooks/shared/.
//
// A plugin may import only files inside its own folder, so code the mods share
// is kept once in shared/ and copied into each of them. The copies are never
// edited by hand: edit shared/, then run this script.
//
//   node scripts/sync-shared.mjs          write the copies
//   node scripts/sync-shared.mjs --check  exit 1 when a copy differs from shared/

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'shared')
const banner = '// Copied from shared/ by scripts/sync-shared.mjs; edit shared/ and run the script.\n'
const isCheck = process.argv.includes('--check')

const files = readdirSync(source).filter(name => /\.(ts|tsx)$/.test(name)).sort()
const mods = readdirSync(join(root, 'mods'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, 'mods', entry.name, 'hooks')))
  .map(entry => entry.name)

let stale = 0
for (const mod of mods) {
  const target = join(root, 'mods', mod, 'hooks', 'shared')
  const expected = new Map(files.map(name => [name, banner + readFileSync(join(source, name), 'utf8')]))
  const present = existsSync(target) ? readdirSync(target) : []
  for (const [name, text] of expected) {
    const path = join(target, name)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    if (current === text) continue
    stale += 1
    if (isCheck) console.error(`stale: mods/${mod}/hooks/shared/${name}`)
    else {
      mkdirSync(target, { recursive: true })
      writeFileSync(path, text)
      console.log(`wrote mods/${mod}/hooks/shared/${name}`)
    }
  }
  for (const name of present.filter(name => !expected.has(name))) {
    stale += 1
    if (isCheck) console.error(`extra: mods/${mod}/hooks/shared/${name}`)
    else {
      rmSync(join(target, name))
      console.log(`removed mods/${mod}/hooks/shared/${name}`)
    }
  }
}

if (isCheck && stale > 0) {
  console.error(`${stale} shared file(s) out of date; run node scripts/sync-shared.mjs`)
  process.exit(1)
}
if (isCheck) console.log(`shared/ matches every mod (${files.length} files, ${mods.length} mods)`)
