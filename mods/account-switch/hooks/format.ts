import type { AccountView, LimitView } from '../types'
import { WEEKDAYS } from './i18n'

/** `2h 56m`, `5d 16h`, `12m`; `nowLabel` once the reset has passed. */
export function untilReset(resetsAt: string | undefined, now: number, nowLabel = 'now'): string {
  if (!resetsAt) return ''
  const minutes = Math.floor((Date.parse(resetsAt) - now) / 60000)
  if (Number.isNaN(minutes)) return ''
  if (minutes <= 0) return nowLabel
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`

  return `${minutes}m`
}

/** A thin bar of `width` cells, in its filled and remaining parts, so each takes its own color. */
export function barParts(percent: number, width = 8): { filled: string; rest: string } {
  const cells = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return { filled: '━'.repeat(cells), rest: '━'.repeat(width - cells) }
}

/** The bar as one string: what its cells measure. */
export function bar(percent: number, width = 8): string {
  const { filled, rest } = barParts(percent, width)

  return filled + rest
}

export function severityColor(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'yellow'

  return 'green'
}

/** `5h 26% → 17:00 (2h 56m) · wk 45% → Wed 10/7 11:00 (2d 20h)`. */
export function describeLimits(limits: LimitView[], now: number, nowLabel = 'now', locale: 'en' | 'ko' = 'en'): string {
  return limits
    .map(limit => {
      const reset = resetText(limit.resetsAt, now, locale, nowLabel)

      return `${limit.label} ${Math.round(limit.percent)}%${reset ? ` → ${reset}` : ''}`
    })
    .join(' · ')
}

/** Finds a saved account by 1-based position, uuid, email, or an email prefix only one matches. */
export function pick(list: AccountView[], query: string): AccountView | undefined {
  if (query === '') return undefined
  const index = Number(query)
  if (Number.isInteger(index) && index >= 1) return list[index - 1]
  const exact = list.find(one => one.uuid === query || one.email === query)
  if (exact) return exact
  const prefixed = list.filter(one => one.email.startsWith(query))

  return prefixed.length === 1 ? prefixed[0] : undefined
}

/**
 * The local wall-clock time a window resets at: `17:00` today, otherwise
 * `Wed 10/7 11:00`, or in Korean the date, then the weekday in parentheses. `offsetMinutes` is what
 * `Date#getTimezoneOffset` answers for that instant (UTC minus local).
 */
export function resetClock(
  resetsAt: string | undefined,
  now: number,
  locale: 'en' | 'ko' = 'en',
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

/** `17:00 (2h 36m)`: when a window resets, and how long until then. */
export function resetText(resetsAt: string | undefined, now: number, locale: 'en' | 'ko' = 'en', nowLabel = 'now'): string {
  const clock = resetClock(resetsAt, now, locale)
  if (!clock) return ''

  return `${clock} (${untilReset(resetsAt, now, nowLabel)})`
}

/** Terminal cells a string takes: East Asian wide and fullwidth characters take two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += isWide ? 2 : 1
  }

  return width
}

/**
 * Splits items into rows no wider than `room`, `gap` cells apart, in order;
 * an item wider than `room` gets a row to itself.
 */
export function packRows<T extends { width: number }>(items: T[], room: number, gap: number): T[][] {
  const rows: T[][] = []
  let used = 0
  for (const item of items) {
    const row = rows[rows.length - 1]
    if (row && used + gap + item.width <= room) {
      row.push(item)
      used += gap + item.width
    } else {
      rows.push([item])
      used = item.width
    }
  }

  return rows
}

/** Whether two reset times name the same moment, allowing the server's sub-minute jitter. */
export function isSameReset(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false

  return Math.abs(Date.parse(a) - Date.parse(b)) <= 2 * 60 * 1000
}

/** The release date a changelog heading gives a version: `## 0.1.0 (2026-10-04)`. */
export function releaseDateOf(changelog: string, version: string): string | undefined {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`^##\\s+v?${escaped}\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm').exec(changelog)?.[1]
}
