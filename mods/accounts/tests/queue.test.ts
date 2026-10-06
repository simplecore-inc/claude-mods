import { expect, test } from 'claude-code/testing'

import { serialQueue } from '../hooks/queue'

test('a serial queue runs one piece at a time, in order, past a piece that threw', async () => {
  const exclusive = serialQueue()
  const events: string[] = []
  const piece = (name: string, ms: number, isFailing = false) =>
    exclusive(async () => {
      events.push(`${name} start`)
      // Yield `ms` times, so a later piece would start in between if nothing held it back.
      for (let step = 0; step < ms; step += 1) await Promise.resolve()
      events.push(`${name} end`)
      if (isFailing) throw new Error(name)

      return name
    })
  const results = await Promise.allSettled([piece('refresh', 30, true), piece('switch', 5), piece('lookup', 1)])
  expect(events).toEqual(['refresh start', 'refresh end', 'switch start', 'switch end', 'lookup start', 'lookup end'])
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
})
