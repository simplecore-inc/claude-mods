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

/** The particles whose form follows the sound before them: after a final consonant, then after a vowel. */
const PARTICLES: readonly [string, string][] = [
  ['을', '를'],
  ['이', '가'],
  ['은', '는'],
  ['과', '와'],
  ['으로', '로'],
]

/** Whether a Hangul syllable ends in a consonant, and whether that consonant is ㄹ; null for anything else. */
function finalOf(char: string): { hasFinal: boolean; isRieul: boolean } | null {
  const code = char.charCodeAt(0) - 0xac00
  if (code < 0 || code > 11171) return null
  const final = code % 28

  return { hasFinal: final !== 0, isRieul: final === 8 }
}

/**
 * The particles in `text` written right after `word` (a closing quote or
 * placeholder brace between allowed) that do not fit its last syllable, such
 * as `목록를`: a message that puts a fixed particle after a value it fills in
 * is wrong for half the values it takes. Both forms written together
 * (`을(를)`) fit any word and are not reported, and neither is a particle
 * after a closing parenthesis, which belongs to the word before it opened.
 */
export function particleProblems(text: string, word: string): string[] {
  const last = finalOf(word.slice(-1))
  if (!last) return []
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const problems: string[] = []
  for (const match of text.matchAll(new RegExp(`${escaped}[」』"'”’}]*(으로|로|을|를|이|가|은|는|과|와)(?!\\()(?=[\\s.,!?:;)」』]|$)`, 'g'))) {
    const particle = match[1] ?? ''
    const pair = PARTICLES.find(([after, before]) => after === particle || before === particle)
    if (!pair) continue
    const fits = pair[0] === '으로' ? (last.hasFinal && !last.isRieul ? '으로' : '로') : last.hasFinal ? pair[0] : pair[1]
    if (particle !== fits) problems.push(match[0])
  }

  return problems
}
