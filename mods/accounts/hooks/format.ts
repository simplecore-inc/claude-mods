import type { AccountView, LimitView } from '../types'
import type { Locale } from './shared/locale'
import { resetText } from './shared/time'

export { bar, barParts, displayWidth, packRows, severityColor } from './shared/layout'
export { releaseDateOf } from './shared/locale'
export { formatDuration, resetClock, resetCountdown, resetText, untilReset } from './shared/time'

/** `5h 26% → 17:00(2h 56m) · wk 45% → Wed 10/7 11:00(2d 20h)`. */
export function describeLimits(limits: LimitView[], now: number, nowLabel = 'now', locale: Locale = 'en'): string {
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

/** Whether two reset times name the same moment, allowing the server's sub-minute jitter. */
export function isSameReset(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false

  return Math.abs(Date.parse(a) - Date.parse(b)) <= 2 * 60 * 1000
}

