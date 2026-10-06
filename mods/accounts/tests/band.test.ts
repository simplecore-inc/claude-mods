import { expect, test } from 'claude-code/testing'

import { resetCountdown } from '../hooks/format'
import { countdownTone } from '../hooks/shared/kit'
import { toolboxCell } from '../hooks/views/band'

test('the toolbox cell says what runs, waits and failed, its ground by the most pressing', async () => {
  expect(toolboxCell({ running: 0, waiting: 0, failed: 0 })).toEqual({ label: '⚒ Toolbox', state: 'idle' })
  expect(toolboxCell({ running: 2, waiting: 0, failed: 0 })).toEqual({ label: '⚒ Toolbox · 2 running', state: 'running' })
  expect(toolboxCell({ running: 1, waiting: 1, failed: 1 })).toEqual({ label: '⚒ Toolbox · 1 running · 1 waiting · 1 failed', state: 'failed' })
  expect(toolboxCell({ running: 0, waiting: 1, failed: 0 }).state).toBe('waiting')
})

test('a weekly reset counts down its last three local days: yellow, orange, then red on the day', async () => {
  // UTC, so the days are the dates as written; the reset is Sunday 23:00.
  const at = '2026-10-11T23:00:00Z'
  const day = (iso: string) => resetCountdown(at, Date.parse(iso), 0)
  expect(day('2026-10-08T23:59:00Z')).toBeUndefined()
  expect(day('2026-10-09T00:00:00Z')).toBe(3)
  expect(day('2026-10-10T12:00:00Z')).toBe(2)
  expect(day('2026-10-11T00:01:00Z')).toBe(1)
  expect(day('2026-10-11T23:30:00Z')).toBeUndefined()
  expect(resetCountdown(undefined, 0)).toBeUndefined()
  expect([3, 2, 1, undefined].map(left => countdownTone(left as 1 | 2 | 3 | undefined))).toEqual(['warn', 'caution', 'danger', undefined])
})
