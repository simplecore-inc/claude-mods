import { WEEKDAYS } from './locale'
import type { Locale } from './locale'

/** `2h 56m`, `5d 04h`, `12m`: the second unit always in two digits; `zeroLabel` under a minute. */
export function formatDuration(ms: number, zeroLabel = '0m'): string {
  const minutes = Math.floor(ms / 60000)
  if (Number.isNaN(minutes)) return ''
  if (minutes <= 0) return zeroLabel
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`

  return `${minutes}m`
}

/** `2h 56m`, `5d 16h`, `12m`; `nowLabel` once the reset has passed. */
export function untilReset(resetsAt: string | undefined, now: number, nowLabel = 'now'): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''

  return formatDuration(at - now, nowLabel)
}

/**
 * The local wall-clock time a window resets at: `17:00` today, otherwise
 * `Wed 10/7 11:00`, or in Korean the date, then the weekday in parentheses. `offsetMinutes` is what
 * `Date#getTimezoneOffset` answers for that instant (UTC minus local).
 */
export function resetClock(
  resetsAt: string | undefined,
  now: number,
  locale: Locale = 'en',
  offsetMinutes?: number,
): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const offset = (offsetMinutes ?? new Date(at).getTimezoneOffset()) * 60000
  const local = new Date(at - offset)
  const today = new Date(now - offset)
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  const isToday =
    local.getUTCFullYear() === today.getUTCFullYear() &&
    local.getUTCMonth() === today.getUTCMonth() &&
    local.getUTCDate() === today.getUTCDate()
  if (isToday) return time
  const date = `${local.getUTCMonth() + 1}/${local.getUTCDate()}`
  const weekday = WEEKDAYS[locale][local.getUTCDay()]

  return locale === 'ko' ? `${date}(${weekday}) ${time}` : `${weekday} ${date} ${time}`
}

/** `17:00(2h 36m)`, `10/7(수) 11:00(2d 20h)`: when a window resets, and how long until then. */
export function resetText(
  resetsAt: string | undefined,
  now: number,
  locale: Locale = 'en',
  nowLabel = 'now',
  offsetMinutes?: number,
): string {
  const clock = resetClock(resetsAt, now, locale, offsetMinutes)
  if (!clock) return ''

  return `${clock}(${untilReset(resetsAt, now, nowLabel)})`
}
