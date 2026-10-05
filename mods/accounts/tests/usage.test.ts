import { describe, expect, test } from 'claude-code/testing'

import { moneyText, parseSpend } from '../hooks/anthropic'
import { addRecords, IDS_PER_FILE, indexToStore, cacheReuse, compactCount, emptyIndex, localDay, parseScan, projectOf, scannedBytes, sessionOf, summarize, totalOf } from '../hooks/usage'
import type { ScanRecord } from '../hooks/usage'

const record = (id: string, at: string, model = 'claude-opus-5-5', cwd = '/Users/u/Workspace/app'): ScanRecord => ({
  at,
  cwd,
  model,
  id,
  input: 2,
  cacheWrite: 100,
  cacheRead: 1000,
  output: 50,
})

describe('the transcript scan', () => {
  test('reads each response line, and how many bytes its complete lines took', async () => {
    const stdout = ['2026-10-04T22:49:11.957Z\t/Users/u/app\tclaude-opus-5-5\tmsg_1\t2\t46877\t25252\t255', 'no tabs here', '#\t4096', ''].join('\n')
    expect(parseScan(stdout)).toEqual([
      { at: '2026-10-04T22:49:11.957Z', cwd: '/Users/u/app', model: 'claude-opus-5-5', id: 'msg_1', input: 2, cacheWrite: 46877, cacheRead: 25252, output: 255 },
    ])
    expect(scannedBytes(stdout)).toBe(4096)
    expect(scannedBytes('')).toBe(0)
  })

  test('a Windows path keeps one backslash between folders', async () => {
    expect(parseScan('2026-10-04T00:00:00Z\tC:\\\\work\\\\app\tm\tmsg_1\t1\t1\t1\t1')[0]?.cwd).toBe('C:\\work\\app')
    expect(projectOf('C:\\work\\app')).toBe('app')
    expect(projectOf('/Users/u/Workspace/app/')).toBe('app')
  })
})

describe('the count', () => {
  test('a response written once per content block is counted once, across scans too', async () => {
    const seen = new Set<string>()
    let index = addRecords(emptyIndex(), seen, '/t/a.jsonl', 'a', [record('msg_1', '2026-10-04T10:00:00Z'), record('msg_1', '2026-10-04T10:00:00Z')], 100, 0)
    index = addRecords(index, seen, '/t/a.jsonl', 'a', [record('msg_1', '2026-10-04T10:00:00Z'), record('msg_2', '2026-10-04T11:00:00Z')], 200, 0)
    const all = summarize(index, null, '2026-10-04')
    expect(all.totals).toEqual({ input: 4, output: 100, cacheRead: 2000, cacheWrite: 200, responses: 2 })
    expect(index.files['/t/a.jsonl']?.offset).toBe(200)
  })

  test('a day is the local date of the response', async () => {
    // 23:30 UTC is the next morning nine hours east.
    expect(localDay('2026-10-04T23:30:00Z', -540)).toBe('2026-10-05')
    expect(localDay('2026-10-04T23:30:00Z', 0)).toBe('2026-10-04')
  })

  test('a period sums its days, fills the empty ones, and ranks models and projects with their sessions', async () => {
    const seen = new Set<string>()
    let index = addRecords(emptyIndex(), seen, '/t/a.jsonl', 'a', [record('msg_1', '2026-10-01T10:00:00Z'), record('msg_2', '2026-10-04T10:00:00Z', 'claude-sonnet-5-5')], 1, 0)
    index = addRecords(index, seen, '/t/b.jsonl', 'b', [record('msg_3', '2026-09-01T10:00:00Z', 'claude-opus-5-5', '/w/old')], 1, 0)
    const week = summarize(index, 7, '2026-10-04')
    expect(week.daily.map(day => day.day)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(week.daily.filter(day => day.tokens.responses > 0).map(day => day.day)).toEqual(['2026-10-01', '2026-10-04'])
    expect(week.totals.responses).toBe(2)
    expect(week.sessions).toBe(1)
    expect(week.models.map(row => [row.name, row.sessions])).toEqual([
      ['claude-opus-5-5', 1],
      ['claude-sonnet-5-5', 1],
    ])
    expect(week.projects.map(row => row.name)).toEqual(['app'])
    const all = summarize(index, null, '2026-10-04')
    expect(all.totals.responses).toBe(3)
    expect(all.daily[0]?.day).toBe('2026-09-01')
    expect(all.projects.map(row => row.name).sort()).toEqual(['app', 'old'])
  })

  test('figures read short, and cache reuse is reads over input plus reads', async () => {
    expect(compactCount(873)).toBe('873')
    expect(compactCount(873_000)).toBe('873.0k')
    expect(compactCount(221_600_000)).toBe('221.6M')
    expect(compactCount(114_300_000_000)).toBe('114.3B')
    expect(cacheReuse({ input: 1, output: 0, cacheRead: 99, cacheWrite: 0, responses: 1 })).toBe(0.99)
    expect(cacheReuse({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, responses: 1 })).toBeNull()
    expect(totalOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, responses: 1 })).toBe(10)
  })
})

describe('spend past the plan', () => {
  test('is shown only as the endpoint reports it: on, or something spent, every part given', async () => {
    const used = { amount_minor: 1234, currency: 'USD', exponent: 2 }
    expect(parseSpend({ spend: { used, limit: { amount_minor: 5000, currency: 'USD', exponent: 2 }, enabled: true } })).toEqual({
      used: { minor: 1234, currency: 'USD', exponent: 2 },
      limit: { minor: 5000, currency: 'USD', exponent: 2 },
    })
    expect(parseSpend({ spend: { used: { ...used, amount_minor: 0 }, limit: null, enabled: false } })).toBeUndefined()
    expect(parseSpend({ spend: { used: { amount_minor: 10, currency: 'USD' }, enabled: true } })).toBeUndefined()
    expect(parseSpend({})).toBeUndefined()
    expect(moneyText({ minor: 1234, currency: 'USD', exponent: 2 })).toBe('12.34 USD')
    expect(moneyText({ minor: 500, currency: 'JPY', exponent: 0 })).toBe('500 JPY')
  })
})

test('a subagent\'s transcript counts toward the session that started it', async () => {
  const seen = new Set<string>()
  expect(sessionOf('-Users-u-app/9f1c.jsonl')).toBe('9f1c')
  expect(sessionOf('-Users-u-app/9f1c/subagents/agent-a1.jsonl')).toBe('9f1c')
  let index = addRecords(emptyIndex(), seen, '/p/app/9f1c.jsonl', '9f1c', [record('msg_1', '2026-10-04T10:00:00Z')], 1, 0)
  index = addRecords(index, seen, '/p/app/9f1c/subagents/agent-a1.jsonl', '9f1c', [record('msg_2', '2026-10-04T10:05:00Z', 'claude-sonnet-5-5', '/w/other')], 1, 0)
  const day = summarize(index, 1, '2026-10-04')
  expect(day.sessions).toBe(1)
  expect(day.totals.responses).toBe(2)
  // A session that moved between projects counts once in each.
  expect(day.projects.map(row => [row.name, row.sessions]).sort()).toEqual([
    ['app', 1],
    ['other', 1],
  ])
})

test('a response a resumed session copied into its own transcript is counted once', async () => {
  const seen = new Set<string>()
  let index = addRecords(emptyIndex(), seen, '/p/app/old.jsonl', 'old', [record('msg_1', '2026-10-04T10:00:00Z')], 1, 0)
  index = addRecords(index, seen, '/p/app/resumed.jsonl', 'resumed', [record('msg_1', '2026-10-04T10:00:00Z'), record('msg_2', '2026-10-04T11:00:00Z')], 1, 0)
  expect(summarize(index, null, '2026-10-04').totals.responses).toBe(2)
  expect([...seen].sort()).toEqual(['msg_1', 'msg_2'])
})

test('the ids are written in files of their own, each well under the engine\'s 4 MiB, and the index names how many', async () => {
  const ids = Array.from({ length: IDS_PER_FILE * 2 + 5 }, (_, n) => `msg_01${String(n).padStart(24, '0')}`)
  const stored = indexToStore(emptyIndex(), ids)
  expect(stored.index.idFiles).toBe(3)
  expect(stored.index.ids).toEqual([])
  expect(stored.idFiles.flat()).toEqual(ids)
  for (const part of stored.idFiles) expect(JSON.stringify(part).length).toBeLessThan(4 * 1024 * 1024 * 0.8)
})
