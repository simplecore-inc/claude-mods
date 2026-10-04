import { describe, expect, test } from 'claude-code/testing'

import { padCells, truncate } from '../hooks/shared/layout'
import { AnthropicError, failedReading, lookedUpOnly, parseProfile, parseUsage, withMeasured } from '../hooks/anthropic'
import { messagesFor } from '../hooks/i18n'
import { updatedText } from '../hooks/views/accounts'
import { bar, barParts, displayWidth, releaseDateOf, isSameReset, packRows, pick, resetClock, resetText, untilReset } from '../hooks/format'

const NOW = Date.parse('2026-10-04T05:00:00Z')

describe('untilReset', () => {
  test('hours and minutes', async () => {
    expect(untilReset('2026-10-04T07:56:30Z', NOW)).toBe('2h 56m')
  })
  test('days and hours', async () => {
    expect(untilReset('2026-10-09T21:00:00Z', NOW)).toBe('5d 16h')
    expect(untilReset('2026-10-09T09:00:00Z', NOW)).toBe('5d 04h')
    expect(untilReset('2026-10-04T07:05:00Z', NOW)).toBe('2h 05m')
    expect(untilReset('2026-10-04T05:07:00Z', NOW)).toBe('7m')
  })
  test('past reset', async () => {
    expect(untilReset('2026-10-04T04:00:00Z', NOW)).toBe('now')
  })
})

describe('parseUsage', () => {
  test('reads the limits list with a scoped model', async () => {
    const limits = parseUsage({
      limits: [
        { kind: 'session', percent: 27, resets_at: '2026-10-04T08:00:00Z' },
        { kind: 'weekly_all', percent: 45, resets_at: '2026-10-07T02:00:00Z' },
        { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
      ],
    })
    expect(limits.map(limit => `${limit.label}:${limit.percent}`)).toEqual(['5h:27', 'wk:45', 'Fable:0'])
  })
  test('falls back to the five_hour and seven_day windows', async () => {
    const limits = parseUsage({ five_hour: { utilization: 12, resets_at: null }, seven_day: null })
    expect(limits).toEqual([{ label: '5h', percent: 12, resetsAt: undefined }])
  })
})

test('bar', async () => {
  expect(bar(50, 6)).toBe('━━━━━━')
  expect(barParts(50, 6)).toEqual({ filled: '━━━', rest: '━━━' })
  expect(barParts(130, 4)).toEqual({ filled: '━━━━', rest: '' })
  expect(barParts(-5, 4)).toEqual({ filled: '', rest: '━━━━' })
})

test('pick by position, email and unique prefix', async () => {
  const list = [
    { uuid: 'u1', email: 'mia@example.org', savedAt: 0 },
    { uuid: 'u2', email: 'sora@example.net', savedAt: 0 },
    { uuid: 'u3', email: 'mina@example.com', savedAt: 0 },
  ]
  expect(pick(list, '2')?.uuid).toBe('u2')
  expect(pick(list, 'mina@example.com')?.uuid).toBe('u3')
  expect(pick(list, 'so')?.uuid).toBe('u2')
  // Two emails start with "mi": no guess.
  expect(pick(list, 'mi')).toBeUndefined()
  expect(pick(list, '')).toBeUndefined()
})

describe('resetClock', () => {
  const KST = -540
  test('today shows the time alone', async () => {
    expect(resetClock('2026-10-04T08:00:00Z', NOW, 'ko', KST)).toBe('17:00')
  })
  test('another day shows the date and weekday', async () => {
    expect(resetClock('2026-10-07T02:00:00Z', NOW, 'ko', KST)).toBe('10/7(수) 11:00')
    expect(resetClock('2026-10-07T02:00:00Z', NOW, 'en', KST)).toBe('Wed 10/7 11:00')
  })
  test('the local date, not the UTC date, decides today', async () => {
    // 16:30 UTC on the 4th is 01:30 on the 5th in Seoul.
    expect(resetClock('2026-10-04T16:30:00Z', NOW, 'en', KST)).toBe('Mon 10/5 01:30')
  })
})

describe('resetText', () => {
  const KST = -540
  test('today the time alone, the countdown right after it', async () => {
    expect(resetText('2026-10-04T08:00:00Z', NOW, 'ko', 'now', KST)).toBe('17:00(3h 00m)')
  })
  test('another day keeps the date and weekday', async () => {
    // 15:49 UTC on the 4th is 00:49 on the 5th in Seoul.
    expect(resetText('2026-10-04T15:49:00Z', NOW, 'ko', 'now', KST)).toBe('10/5(월) 00:49(10h 49m)')
    expect(resetText('2026-10-07T02:00:00Z', NOW, 'ko', 'now', KST)).toBe('10/7(수) 11:00(2d 21h)')
    expect(resetText('2026-10-07T02:00:00Z', NOW, 'en', 'now', KST)).toBe('Wed 10/7 11:00(2d 21h)')
  })
  test('a passed reset shows the now label', async () => {
    expect(resetText('2026-10-04T04:00:00Z', NOW, 'ko', '지금', KST)).toBe('13:00(지금)')
  })
})

test('displayWidth counts Hangul as two cells', async () => {
  expect(displayWidth('↻ 10/7(수) 11:00')).toBe(16)
  expect(displayWidth('5h █░ 3%')).toBe(8)
})

test('packRows fills each row up to the room and keeps order', async () => {
  const items = [20, 30, 25].map(width => ({ width }))
  expect(packRows(items, 60, 3).map(row => row.map(item => item.width))).toEqual([[20, 30], [25]])
  expect(packRows(items, 90, 3).map(row => row.length)).toEqual([3])
  expect(packRows([{ width: 80 }], 40, 3).length).toBe(1)
})

test('isSameReset allows the sub-minute jitter between windows', async () => {
  expect(isSameReset('2026-10-07T01:59:59.9Z', '2026-10-07T02:00:00Z')).toBe(true)
  expect(isSameReset('2026-10-07T02:00:00Z', '2026-10-08T02:00:00Z')).toBe(false)
  expect(isSameReset(undefined, '2026-10-07T02:00:00Z')).toBe(false)
})

test('parseProfile names the account a token belongs to', async () => {
  const owner = parseProfile(
    JSON.stringify({ account: { uuid: 'a1', email: 'x@example.com' }, organization: { uuid: 'o1', name: 'Org' } }),
  )
  expect(owner).toEqual({ accountUuid: 'a1', emailAddress: 'x@example.com', organizationUuid: 'o1', organizationName: 'Org' })
  expect(() => parseProfile('{"organization":{}}')).toThrow()
})

test('a 429 keeps the previous reading, marked stale, with no message', async () => {
  const previous = { limits: [{ label: '5h', percent: 30 }], fetchedAt: 1, source: 'lookup' as const }
  const stale = failedReading(previous, new AnthropicError('x', 429), 99, messagesFor('ko'))
  expect(stale).toEqual({ limits: previous.limits, fetchedAt: 1, isStale: true, source: 'lookup' })
  const expired = failedReading(previous, new AnthropicError('x', 401), 99, messagesFor('en'))
  expect(expired.error).toBe(messagesFor('en').authExpired)
  expect(expired.isStale).toBeUndefined()
  // The figures kept are the last lookup's, and so is their time.
  expect(expired.fetchedAt).toBe(1)
})

test('updatedText says how long ago the figures were looked up, to the minute', async () => {
  const m = messagesFor('en')
  const reading = (fetchedAt: number) => ({ limits: [{ label: '5h', percent: 30 }], fetchedAt, source: 'lookup' as const })
  // Under a minute it says nothing.
  expect(updatedText(reading(0), 59_999, m)).toBe('')
  expect(updatedText(reading(0), 60_000, m)).toBe('(updated 1m ago)')
  expect(updatedText(reading(0), 12 * 60_000 + 59_000, m)).toBe('(updated 12m ago)')
  expect(updatedText(reading(0), 75 * 60_000, m)).toBe('(updated 1h 15m ago)')
  expect(updatedText(reading(0), 3 * 60_000, messagesFor('ko'))).toBe('(3m 전 갱신)')
  // No figures yet: nothing to date.
  expect(updatedText({ limits: [], fetchedAt: 0, error: 'x', source: 'lookup' }, 60_000, m)).toBe('')
  expect(updatedText(undefined, 60_000, m)).toBe('')
})

test('figures no lookup produced are never kept', async () => {
  const copied = { limits: [{ label: 'wk', percent: 90 }], fetchedAt: 1 }
  expect(failedReading(copied, new AnthropicError('x', 429), 99, messagesFor('en')).limits).toEqual([])
  const old = { limits: [], fetchedAt: 1, error: 'old message' }
  const fresh = { limits: [], fetchedAt: 2, source: 'lookup' as const }
  expect(lookedUpOnly({ a: copied, b: old, c: fresh })).toEqual({ c: fresh })
  expect(lookedUpOnly(undefined)).toEqual({})
})

test('withMeasured replaces the five-hour and weekly figures and keeps the rest', async () => {
  const previous = {
    limits: [
      { label: '5h', percent: 10 },
      { label: 'wk', percent: 20 },
      { label: 'Fable', percent: 3 },
    ],
    fetchedAt: 1,
    source: 'lookup' as const,
  }
  const next = withMeasured(previous, [
    { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-04T08:00:00Z' },
    { kind: 'seven_day', percentUsed: 21 },
    { kind: 'spend_limit', percentUsed: 50 },
  ], 9)
  expect(next.limits.map(limit => `${limit.label}:${limit.percent}`)).toEqual(['5h:12', 'wk:21', 'Fable:3'])
  expect(next).toMatchObject({ fetchedAt: 9, source: 'lookup' })
  // Figures no lookup produced are not carried along.
  expect(withMeasured({ limits: [{ label: 'Fable', percent: 90 }], fetchedAt: 1 }, [], 9).limits).toEqual([])
})

test('releaseDateOf reads the date of the heading for that version only', async () => {
  const changelog = '# Changes\n\n## 0.2.0 (2026-11-01)\n\n- b\n\n## 0.1.0 (2026-10-04)\n\n- a\n'
  expect(releaseDateOf(changelog, '0.1.0')).toBe('2026-10-04')
  expect(releaseDateOf(changelog, '0.2.0')).toBe('2026-11-01')
  expect(releaseDateOf(changelog, '0.1')).toBeUndefined()
  expect(releaseDateOf('', '0.1.0')).toBeUndefined()
})

test('truncate and padCells count wide characters as two cells', async () => {
  expect(truncate('abcdef', 4)).toBe('abc…')
  expect(truncate('abc', 4)).toBe('abc')
  expect(truncate('가나다라', 5)).toBe('가나…')
  expect(padCells('가', 4)).toBe('가  ')
  expect(padCells('ab', 4, 'start')).toBe('  ab')
})
