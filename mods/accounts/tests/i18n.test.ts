import { expect, test } from 'claude-code/testing'

import { messagesFor, resolveLocale } from '../hooks/i18n'

test('the language setting wins over the locale variables', async () => {
  expect(resolveLocale('한국어', ['en_US.UTF-8'])).toBe('ko')
  expect(resolveLocale('Korean', [])).toBe('ko')
  expect(resolveLocale('ko-KR', [])).toBe('ko')
  expect(resolveLocale('english', ['ko_KR.UTF-8'])).toBe('en')
})

test('an untranslated language falls back to English', async () => {
  expect(resolveLocale('日本語', ['ko_KR.UTF-8'])).toBe('en')
  expect(resolveLocale('kotlin', [])).toBe('en')
})

test('without the setting the first set locale variable decides', async () => {
  expect(resolveLocale(undefined, [undefined, '', 'ko_KR.UTF-8'])).toBe('ko')
  expect(resolveLocale('', ['C', 'ko_KR.UTF-8'])).toBe('en')
  expect(resolveLocale(undefined, [])).toBe('en')
})

test('both tables carry every message', async () => {
  expect(Object.keys(messagesFor('ko')).sort()).toEqual(Object.keys(messagesFor('en')).sort())
  expect(messagesFor('en').removed('a@example.com')).toBe('Removed the a@example.com account.')
})
