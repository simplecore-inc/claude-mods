import { expect, test } from 'claude-code/testing'

import { CHANGES_KEPT, isOwnSwitch, OWN_SWITCH_MS, parseChanges, withChange } from '../hooks/switchlog'
import type { LoginChange } from '../hooks/switchlog'

const change = (kind: LoginChange['kind'], to: string, at: number): LoginChange => ({ at, kind, session: 's', cwd: '/w', version: '0.5.2', from: 'a@x', to })

test('a change of the login is this mod\'s only when one of its switches made it, to that account, just before', async () => {
  const changes = [change('switch', 'dev@x', 1_000_000), change('outside', 'lab@x', 1_100_000)]
  expect(isOwnSwitch(changes, 'dev@x', 1_000_000 + 30_000)).toBe(true)
  expect(isOwnSwitch(changes, 'dev@x', 1_000_000 + OWN_SWITCH_MS + 1)).toBe(false)
  // A switch to another account, or a change already found from outside, is not a switch to this one.
  expect(isOwnSwitch(changes, 'simple@x', 1_000_000 + 30_000)).toBe(false)
  expect(isOwnSwitch(changes, 'lab@x', 1_100_000 + 1_000)).toBe(false)
})

test('the record keeps one change a line, the newest kept, and skips a line that does not parse', async () => {
  let text = 'not json\n'
  for (let n = 0; n < CHANGES_KEPT + 5; n += 1) text = withChange(text, change('switch', `u${n}@x`, n))
  const changes = parseChanges(text)
  expect(changes.length).toBe(CHANGES_KEPT)
  expect(changes[changes.length - 1]?.to).toBe(`u${CHANGES_KEPT + 4}@x`)
})
