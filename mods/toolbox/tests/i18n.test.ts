import { expect, test } from 'claude-code/testing'

import { messagesFor } from '../hooks/i18n'
import { particleProblems } from '../hooks/shared/locale'

/** Every Korean message, its values filled with `word`: a function called with it for each argument it takes. */
function rendered(word: string): string[] {
  const out: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'function') out.push(String((value as (...args: unknown[]) => unknown)(...Array.from({ length: Math.max(1, value.length) }, () => word))))
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(messagesFor('ko'))

  return out
}

test('no Korean message puts a particle after a value that fits only some values', async () => {
  // One word ending in a consonant, one in a vowel: a fixed particle is wrong after one of them.
  const problems = ['목록', '노트', '파일'].flatMap(word => rendered(word).flatMap(text => particleProblems(text, word).map(found => `${found} in "${text}"`)))
  expect(problems).toEqual([])
})
