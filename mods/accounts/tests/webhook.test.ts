import { expect, test } from 'claude-code/testing'

import { DEFAULT_TEMPLATE_TEXT, changeKey, localTime, parseConfig, renderTemplate, urlProblem, webhookRequest, webhookValues } from '../hooks/webhook'
import type { FeedInput, WebhookValues } from '../hooks/webhook'

const STATUS = {
  updatedAt: 1,
  model: 'Opus 5.5',
  effort: 'high',
  ultracode: false,
  fast: false,
  contextUsed: 42,
  task: '',
  dir: 'claude-mods',
  branch: 'main',
  pr: null,
  linesAdded: 3,
  linesRemoved: 1,
}

const INPUT: FeedInput = {
  session: 's1',
  now: Date.parse('2026-10-04T05:00:00Z'),
  hostname: 'box',
  version: '2.1.289',
  cwd: '/work/claude-mods',
  modelId: 'claude-opus-5-5',
  status: STATUS,
  cost: 1.5,
  account: 'mina@example.com',
  limits: [{ label: '5h', percent: 60, resetsAt: '2026-10-04T08:00:00Z' }],
}

const values: WebhookValues = webhookValues(INPUT)

test('a placeholder standing alone becomes its value as JSON; inside a longer string, text', async () => {
  const rendered = renderTemplate('{"ctx": "{{context}}", "fast": "{{fast}}", "pr": "{{pr}}", "who": "{{account}} on {{hostname}}"}', values)
  expect(rendered).toEqual({
    body: '{"ctx":42,"fast":false,"pr":null,"who":"mina@example.com on box"}',
    value: { ctx: 42, fast: false, pr: null, who: 'mina@example.com on box' },
  })
})

test('a template that is not JSON, or names an unknown variable, says so', async () => {
  expect('invalid' in renderTemplate('{"a": {{context}}}', values)).toBe(true)
  expect(renderTemplate('{"a": "{{nope}}", "b": "x {{alsoNope}}"}', values)).toEqual({ unknown: ['nope', 'alsoNope'] })
})

test('the default template fills into the status line input\'s shape', async () => {
  const rendered = renderTemplate(DEFAULT_TEMPLATE_TEXT, values)
  if (!('value' in rendered)) throw new Error('the default template did not fill')
  expect(rendered.value).toMatchObject({
    session_id: 's1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { used_percentage: 42 },
    cost: { total_cost_usd: 1.5, total_lines_added: 3, total_lines_removed: 1 },
    // Reset times in Unix seconds, as the status line input gives them.
    rate_limits: { five_hour: { used_percentage: 60, resets_at: Date.parse('2026-10-04T08:00:00Z') / 1000 }, seven_day: { used_percentage: null, resets_at: null } },
    account: 'mina@example.com',
    hostname: 'box',
  })
})

test('each time fills in every format: ISO text in UTC, Unix seconds, Unix milliseconds, and local time with its offset', async () => {
  const reset = webhookValues({ ...INPUT, limits: [{ label: '5h', percent: 52, resetsAt: '2026-10-06T09:20:00.000Z' }] })
  expect(reset.fiveHourResetsAt).toBe('2026-10-06T09:20:00.000Z')
  expect(reset.fiveHourResetsAtEpoch).toBe(1791278400)
  expect(reset.fiveHourResetsAtEpochMs).toBe(1791278400000)
  expect(reset.fiveHourResetsAtLocal).toBe(localTime(1791278400000))
  expect(values.time).toBe('2026-10-04T05:00:00.000Z')
  expect(values.timeEpoch).toBe(Date.parse('2026-10-04T05:00:00Z') / 1000)
  expect(values.timeEpochMs).toBe(Date.parse('2026-10-04T05:00:00Z'))
  expect(values.timestamp).toBe(values.timeEpochMs)
  // No weekly window, or a reset time that does not parse: null in every format.
  expect([values.weeklyResetsAt, values.weeklyResetsAtEpoch, values.weeklyResetsAtEpochMs, values.weeklyResetsAtLocal]).toEqual([null, null, null, null])
  const garbled = webhookValues({ ...INPUT, limits: [{ label: '5h', percent: 52, resetsAt: 'soon' }] })
  expect([garbled.fiveHourResetsAt, garbled.fiveHourResetsAtEpoch, garbled.fiveHourResetsAtLocal]).toEqual([null, null, null])
})

test('local time is the wall clock with its offset from UTC, as RFC 3339 writes it', async () => {
  const at = Date.parse('2026-10-06T09:20:00Z')
  expect(localTime(at, -540)).toBe('2026-10-06T18:20:00+09:00')
  expect(localTime(at, 0)).toBe('2026-10-06T09:20:00+00:00')
  expect(localTime(at, 300)).toBe('2026-10-06T04:20:00-05:00')
  expect(localTime(at, -330)).toBe('2026-10-06T14:50:00+05:30')
})

test('POST sends the body as JSON; GET the top-level fields as query parameters; a token as Bearer', async () => {
  const rendered = { body: '{"a":1,"b":{"c":2},"d":null}', value: { a: 1, b: { c: 2 }, d: null } }
  const post = webhookRequest({ enabled: true, url: 'https://example.com/hook', method: 'POST' }, rendered, 'secret')
  expect(post).toEqual({
    url: 'https://example.com/hook',
    init: { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: rendered.body },
  })
  const get = webhookRequest({ enabled: true, url: 'https://example.com/hook?x=1', method: 'GET' }, rendered, null)
  expect(get.init).toEqual({ method: 'GET', headers: {} })
  expect(get.url).toBe('https://example.com/hook?x=1&a=1&b=%7B%22c%22%3A2%7D')
})

test('only an absolute http or https URL can be sent to', async () => {
  expect(urlProblem('')).toBe('empty')
  expect(urlProblem('ftp://example.com')).toBe('scheme')
  expect(urlProblem('not a url')).toBe('invalid')
  expect(urlProblem('http://10.0.0.1:3000/api/events')).toBeNull()
})

test('a stored config reads field by field; anything else is the default, off', async () => {
  expect(parseConfig({ enabled: true, url: 'https://example.com', method: 'GET' })).toEqual({ enabled: true, url: 'https://example.com', method: 'GET' })
  expect(parseConfig({ enabled: 'yes', method: 'PUT' })).toEqual({ enabled: false, url: '', method: 'POST' })
  expect(parseConfig(null)).toEqual({ enabled: false, url: '', method: 'POST' })
})

test('the clock alone, in any format, is not a change; a reset time that moved is', async () => {
  expect(changeKey({ ...values, time: 'later', timeEpoch: 3, timeEpochMs: 4, timeLocal: 'later', timestamp: 2 })).toBe(changeKey(values))
  expect(changeKey({ ...values, context: 43 })).not.toBe(changeKey(values))
  expect(changeKey({ ...values, fiveHourResetsAtEpoch: 5 })).not.toBe(changeKey(values))
})
