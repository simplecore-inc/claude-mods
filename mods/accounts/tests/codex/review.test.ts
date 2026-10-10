// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from 'claude-code/testing'

import { apply, type Run } from '../../hooks/codex/events'
import { nameOf } from '../../hooks/codex/model'

describe('names', () => {
  test('codex ids read as people say them', () => {
    expect(nameOf('gpt-6.1-sol')).toBe('Sol 6.1')
    expect(nameOf('gpt-6-astra')).toBe('Astra 6')
    expect(nameOf('gpt-5.5')).toBe('gpt-5.5')
  })
})

describe('events', () => {
  test('an error Codex recovers from does not fail the run', () => {
    const run: Run = {}
    apply(run, 'error', { error: { message: 'reconnecting' }, willRetry: true })
    apply(run, 'item/completed', { item: { type: 'agentMessage', text: 'ok' } })
    apply(run, 'turn/completed', { turn: { status: 'completed' } })
    expect(run.error).toBeUndefined()
    expect(run.answer).toBe('ok')
  })
})

describe('usage', () => {
  const at = (input: number, cached: number, output: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output })

  // How Claude Code turns each step's usage into an agent row's number: the
  // latest step's input (fresh, cache read, cache write) replaces the last,
  // its output adds to the outputs before it.
  function row(turns: Run[]): number {
    let latest = 0
    let outputs = 0
    for (const { usage } of turns) {
      if (!usage) continue
      latest = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      outputs += usage.output_tokens
    }
    return latest + outputs
  }

  test('a turn reports its last request as input, cached tokens apart, and its own output', () => {
    const run: Run = {}
    // A resumed thread already held 5000 tokens; this turn made two requests.
    apply(run, 'thread/tokenUsage/updated', { tokenUsage: { total: at(5600, 800, 60), last: at(600, 300, 10) } })
    apply(run, 'thread/tokenUsage/updated', { tokenUsage: { total: at(6000, 1300, 100), last: at(400, 500, 40) } })
    expect(run.usage).toEqual({ input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })
  })

  test("the row shows Codex's current context, not the thread's running total", () => {
    // Each request re-reads the whole thread from the cache, so the running
    // total grows far past the context the last request was answered over.
    const first: Run = {}
    apply(first, 'thread/tokenUsage/updated', { tokenUsage: { total: at(40_000, 30_000, 300), last: at(40_000, 30_000, 300) } })
    apply(first, 'thread/tokenUsage/updated', { tokenUsage: { total: at(90_000, 75_000, 500), last: at(50_000, 45_000, 200) } })
    const second: Run = {}
    apply(second, 'thread/tokenUsage/updated', { tokenUsage: { total: at(150_000, 130_000, 700), last: at(60_000, 55_000, 200) } })
    apply(second, 'thread/tokenUsage/updated', { tokenUsage: { total: at(220_000, 195_000, 1_000), last: at(70_000, 65_000, 300) } })
    expect(row([first, second])).toBe(70_000 + 1_000)
    expect(second.tokens).toEqual({ input: 220_000, cached: 195_000, output: 1_000 })
  })
})
