export type Locale = 'en' | 'ko'

/** Short weekday names, Sunday first, as `Date#getDay` counts. */
export const WEEKDAYS: Record<Locale, readonly string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ko: ['일', '월', '화', '수', '목', '금', '토'],
}

const KOREAN = /^(ko\b|ko[-_]|korean|한국어)/i

/**
 * Picks the display language. Claude Code's `language` setting wins when set
 * (any language without a translation here falls back to English); without
 * it the POSIX locale variables decide, in their own precedence order.
 */
export function resolveLocale(language: unknown, localeVariables: (string | undefined)[]): Locale {
  if (typeof language === 'string' && language.trim() !== '') return KOREAN.test(language.trim()) ? 'ko' : 'en'
  const locale = localeVariables.find(value => value !== undefined && value !== '')

  return locale !== undefined && KOREAN.test(locale) ? 'ko' : 'en'
}

/** The release date a changelog heading gives a version: `## 0.1.0 (2026-10-04)`. */
export function releaseDateOf(changelog: string, version: string): string | undefined {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`^##\\s+v?${escaped}\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm').exec(changelog)?.[1]
}
