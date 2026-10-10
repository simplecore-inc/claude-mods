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

/**
 * Finds a saved account named whole: its email, in any case, or its uuid.
 * What cannot be undone without a new /login (removing an account) takes
 * this, never a position in a list or a prefix, which a typo can match.
 */
export function pickExact(list: AccountView[], query: string): AccountView | undefined {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return undefined

  return list.find(one => one.uuid.toLowerCase() === wanted || one.email.toLowerCase() === wanted)
}

/** Whether two reset times name the same moment, allowing the server's sub-minute jitter. */
export function isSameReset(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false

  return Math.abs(Date.parse(a) - Date.parse(b)) <= 2 * 60 * 1000
}

/** A number with its thousands grouped and at most two decimals, none when whole: `62500` as `62,500`, `0.75` as `0.75`. */
export function groupDecimal(n: number): string {
  const [whole = '0', fraction = ''] = n.toFixed(2).split('.')
  const kept = fraction.replace(/0+$/, '')

  return `${groupDigits(Number(whole))}${kept === '' ? '' : `.${kept}`}`
}

/** A whole number with its thousands grouped by commas: `141551` as `141,551`. */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
