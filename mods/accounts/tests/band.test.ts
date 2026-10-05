import { expect, test } from 'claude-code/testing'

import { toolboxCell } from '../hooks/views/band'

test('the toolbox cell says what runs, waits and failed, its ground by the most pressing', async () => {
  expect(toolboxCell({ running: 0, waiting: 0, failed: 0 })).toEqual({ label: '⚒ Toolbox', state: 'idle' })
  expect(toolboxCell({ running: 2, waiting: 0, failed: 0 })).toEqual({ label: '⚒ Toolbox · 2 running', state: 'running' })
  expect(toolboxCell({ running: 1, waiting: 1, failed: 1 })).toEqual({ label: '⚒ Toolbox · 1 running · 1 waiting · 1 failed', state: 'failed' })
  expect(toolboxCell({ running: 0, waiting: 1, failed: 0 }).state).toBe('waiting')
})
