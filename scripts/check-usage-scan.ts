// Checks the transcript scan against a full JSON parse of the same files, outside the test kit:
// the scan runs in `sh`, which the kit does not. Copy the transcripts aside first, since a live
// session keeps writing its own and the two counts would read different bytes.
//
//   bun scripts/check-usage-scan.ts <transcript.jsonl>...
//
// Each file is read in two scans split at its middle, so a line cut by the end of a scan is
// counted once, by the next. Exits 1 when the totals differ.

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

import { addRecords, emptyIndex, parseScan, scannedBytes, SCAN_SCRIPT, summarize } from '../mods/accounts/hooks/usage'

const files = process.argv.slice(2)
let index = emptyIndex()
const counted = new Set<string>()
for (const file of files) {
  const size = statSync(file).size
  let offset = 0
  for (const to of [Math.floor(size / 2), size]) {
    const out = execFileSync('sh', ['-c', SCAN_SCRIPT, 'sh', file, String(to), String(offset + 1), String(to - offset)], { maxBuffer: 1 << 30 }).toString()
    const next = offset + scannedBytes(out)
    index = addRecords(index, counted, file, file, parseScan(out), next)
    offset = next
  }
}
const scanned = summarize(index, null, '9999-12-31').totals

const parsed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 }
// A message id is counted once across every file, as a resumed session repeats earlier responses.
const seen = new Set<string>()
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"type":"assistant"')) continue
    let record: { message?: { id?: string; usage?: Record<string, number> } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const id = record.message?.id
    const usage = record.message?.usage
    if (!usage || !id?.startsWith('msg_') || seen.has(id)) continue
    seen.add(id)
    parsed.input += usage.input_tokens ?? 0
    parsed.output += usage.output_tokens ?? 0
    parsed.cacheRead += usage.cache_read_input_tokens ?? 0
    parsed.cacheWrite += usage.cache_creation_input_tokens ?? 0
    parsed.responses += 1
  }
}

const same = JSON.stringify(scanned) === JSON.stringify(parsed)
console.log(`scan   ${JSON.stringify(scanned)}\nparsed ${JSON.stringify(parsed)}\n${same ? 'same' : 'DIFFERENT'}`)
process.exit(same ? 0 : 1)
