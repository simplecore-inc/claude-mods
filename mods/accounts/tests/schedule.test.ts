import { describe, expect, test } from 'claude-code/testing'

import { NO_LOOKUP, POLL_MS, afterRateLimit, afterSuccess, isAutomaticLookupDue, readShared } from '../hooks/schedule'

const NOW = 1_800_000_000_000

describe('isAutomaticLookupDue', () => {
  test('the first tick on the machine looks up', async () => {
    expect(isAutomaticLookupDue(NO_LOOKUP, NOW)).toBe(true)
  })
  test('a lookup another session started within the period is reused', async () => {
    expect(isAutomaticLookupDue({ ...NO_LOOKUP, startedAt: NOW - POLL_MS + 1000 }, NOW)).toBe(false)
    expect(isAutomaticLookupDue({ ...NO_LOOKUP, startedAt: NOW - POLL_MS }, NOW)).toBe(true)
  })
  test('a 429 wait holds automatic lookups back', async () => {
    expect(isAutomaticLookupDue({ ...NO_LOOKUP, backoffUntil: NOW + 1 }, NOW)).toBe(false)
  })
})

describe('afterRateLimit', () => {
  test('Retry-After in seconds sets the wait', async () => {
    expect(afterRateLimit(NO_LOOKUP, NOW, '120').backoffUntil).toBe(NOW + 120_000)
  })
  test('Retry-After as an HTTP date sets the wait', async () => {
    expect(afterRateLimit(NO_LOOKUP, NOW, new Date(NOW + 90_000).toUTCString()).backoffUntil).toBe(NOW + 90_000)
  })
  test('without Retry-After the wait starts at five minutes and doubles up to an hour', async () => {
    const first = afterRateLimit(NO_LOOKUP, NOW, undefined)
    expect(first.backoffMs).toBe(5 * 60_000)
    expect(afterRateLimit(first, NOW, undefined).backoffMs).toBe(10 * 60_000)
    expect(afterRateLimit({ ...first, backoffMs: 50 * 60_000 }, NOW, undefined).backoffMs).toBe(60 * 60_000)
  })
  test('a lookup that meets no 429 clears the wait', async () => {
    expect(afterSuccess(afterRateLimit(NO_LOOKUP, NOW, undefined))).toEqual(NO_LOOKUP)
  })
})

test('readShared tolerates a missing or foreign record', async () => {
  expect(readShared(undefined)).toEqual(NO_LOOKUP)
  expect(readShared({ startedAt: 'x', backoffUntil: 5 })).toEqual({ startedAt: 0, backoffUntil: 5, backoffMs: 0 })
})
