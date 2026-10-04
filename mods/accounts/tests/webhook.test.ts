import { expect, test } from 'claude-code/testing'

import { DEFAULT_TEMPLATE_TEXT, changeKey, parseConfig, renderTemplate, urlProblem, webhookRequest, webhookValues } from '../hooks/webhook'
import type { WebhookValues } from '../hooks/webhook'

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

const values: WebhookValues = webhookValues({
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
})

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
    rate_limits: { five_hour: { used_percentage: 60 }, seven_day: { used_percentage: null } },
    account: 'mina@example.com',
    hostname: 'box',
  })
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

test('the clock alone is not a change', async () => {
  expect(changeKey({ ...values, time: 'later', timestamp: 2 })).toBe(changeKey(values))
  expect(changeKey({ ...values, context: 43 })).not.toBe(changeKey(values))
})
