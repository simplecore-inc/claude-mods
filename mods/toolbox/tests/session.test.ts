import { expect, mock, test } from 'claude-code/testing'

const TOOLS = JSON.stringify({ version: 1, tools: [{ id: 'quiet', name: 'quiet server', kind: 'shell', run: 'sleep 613' }] })
const quickProps = { title: 'Toolbox', isFocused: true, bodyColumns: 100, placement: 'dock' } as never

test('after /clear the toolbox shows its tools again, and a run it still holds as running', async ($, on) => {
  // The engine's state for the session: a /clear starts the new session with none of it.
  const values: Record<string, unknown> = {}
  on('state.get', ($, e) => ({ value: { value: values[e.key], version: 1 } as never }))
  on('state.set', ($, e) => {
    values[e.key] = e.value

    return { value: { isSet: true, version: 2 } as never }
  })
  const files: Record<string, string> = { '/proj/.toolbox/toolbox.json': TOOLS }
  on('fs.exists', ($, e) => ({ value: (e.path in files) as never }))
  on('fs.read', ($, e) => ({ value: (files[e.path] ?? '') as never }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text

    return { value: undefined as never }
  })
  on('session.root', () => ({ value: '/proj' as never }))
  on('settings.read', () => ({ value: {} as never }))
  on('ui.panes', () => ({ value: [] as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // The run goes on until the test lets it end.
  let finish: () => void = () => undefined
  const ended = new Promise<void>(resolve => {
    finish = resolve
  })
  on('process.spawn', async function* (): AsyncGenerator<never, never> {
    await ended

    return { value: { code: 0, signal: null } } as never
  })
  mock.env(on, {})
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T05:00:00Z') } as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'sc:toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  const ui = await $.ui.mount({ plugin: 'sc-toolbox', surface: 'terminal', component: 'Pane', requestId: 'sc-toolbox', props: quickProps })
  await ui.press({ key: 'quick-quiet' })
  await ui.unmount()
  expect((values.runs as Record<string, { state: string }>).quiet?.state).toBe('running')
  // /clear: the session ends, the process goes on, and the new session's state starts empty.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  for (const key of Object.keys(values)) delete values[key]
  await clock.advance(1000)
  expect((values.tools as { id: string }[] | undefined)?.map(tool => tool.id)).toEqual(['quiet'])
  expect((values.runs as Record<string, { state: string }> | undefined)?.quiet?.state).toBe('running')
  expect(values.summary).toEqual({ running: 1, waiting: 0, failed: 0 })
  finish()
  await clock.settle()
})
