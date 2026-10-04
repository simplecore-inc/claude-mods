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

test('the webhook is named in each language, and says when it sends', async () => {
  expect(messagesFor('en').webhookTitle).toBe('Webhook')
  expect(messagesFor('ko').webhookTitle).toBe('웹훅')
  expect(messagesFor('ko').webhookWhen(30, 2)).toBe('상태(모델, effort, 컨텍스트, 사용량, 브랜치, 변경 줄 수 등)가 바뀔 때 보내고, 바뀌지 않아도 30초마다 보냅니다. 2초 안에 두 번 보내지는 않습니다.')
})
