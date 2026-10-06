import { expect, test } from 'claude-code/testing'

import { displayWidth } from '../hooks/shared/layout'
import { STATUS, seedState, mountPane } from './paneHarness'

test('the webhook dialog: the switch, the method, the URL, the token, the template file and what is sent now', async ($, on) => {
  seedState(
    on,
    {
      status: STATUS,
      dialog: { kind: 'webhook' },
      webhookDraft: { enabled: true, url: '', method: 'POST', token: '', hasToken: false, clearToken: false },
      webhookLast: null,
    },
    Date.parse('2026-10-06T09:20:00Z'),
  )
  // Stand for the engine beneath: the template file, the session's model and folder.
  on('fs.exists', () => ({ value: true as never }))
  on('fs.read', () => ({ value: '{"session_id": "{{session}}", "ctx": "{{context}}"}' as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' as never }))
  on('session.cwd', () => ({ value: '/work/claude-mods' as never }))
  on('env.get', ($, e) => ({ value: (e.name === 'HOME' ? '/home/me' : undefined) as never }))
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Webhook' })).toBeDefined()
  expect((await ui.find({ key: 'webhook-enabled-on' }))?.text).toBe('On')
  expect((await ui.find({ key: 'webhook-method-on' }))?.text).toBe('POST')
  expect((await ui.find({ key: 'webhook-method-off' }))?.text).toBe('GET')
  // When it sends, in the numbers the feed uses.
  expect(await ui.find({ type: 'Text', text: /every 30 seconds while nothing changes\. Never twice within 2 seconds\.$/ })).toBeDefined()
  expect(await ui.find({ key: 'webhook-url-input' })).toBeDefined()
  expect(await ui.find({ key: 'webhook-token-input' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'none' })).toBeDefined()
  // An empty URL with the feed on says what is wrong before saving.
  expect(await ui.find({ type: 'Text', text: 'Enter the URL to send to.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sc-accounts\/webhook\.json$/ })).toBeDefined()
  // The preview is the template filled now, indented.
  expect(await ui.find({ type: 'Text', text: '  "ctx": 40' })).toBeDefined()
  for (const key of ['dialog-confirm', 'webhook-test', 'dialog-cancel']) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ key: 'tabs' })).toBeUndefined()
  // The times are grouped by format, each group said with the time now as its example.
  for (const name of ['time', 'timeEpoch', 'timeEpochMs', 'timeLocal', 'fiveHourResetsAtEpoch', 'weeklyResetsAtLocal']) expect(await ui.find({ type: 'Text', text: `{{${name}}}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sent as ISO 8601 text in UTC, such as "2026-10-06T09:20:00.000Z".' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Sent as Unix time, a number of seconds, such as 1791278400\. / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Sent as Unix time, a number of milliseconds, such as 1791278400000\. / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Sent as this computer's local time with its offset from UTC, such as "2026-10-0[67]T\d\d:\d\d:00[+-]\d\d:\d\d"\.$/ })).toBeDefined()
  await ui.unmount()
})

test('under the last send the webhook dialog says what the receiver answered, cut to one line', async ($, on) => {
  seedState(on, {
    status: STATUS,
    dialog: { kind: 'webhook' },
    webhookDraft: { enabled: true, url: 'https://example.com/hook', method: 'POST', token: '', hasToken: false, clearToken: false },
    webhookLast: { at: 0, status: 200, error: null, reply: '{"stored":false,"reason":"server_error"}' },
  })
  on('fs.exists', () => ({ value: true as never }))
  on('fs.read', () => ({ value: '{"ctx": "{{context}}"}' as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' as never }))
  on('session.cwd', () => ({ value: '/work/claude-mods' as never }))
  on('env.get', ($, e) => ({ value: (e.name === 'HOME' ? '/home/me' : undefined) as never }))
  const ui = await mountPane($, 'terminal')
  // HTTP 200 reads as sent; the answer beneath says the receiver stored nothing.
  expect(await ui.find({ type: 'Text', text: /^Sent at .+: HTTP 200$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^The receiver answered: / }))?.text).toBe('The receiver answered: {"stored":false,"reason":"server_error"}')
  await ui.unmount()
  const narrow = await mountPane($, 'terminal', 40)
  const cut = (await narrow.find({ type: 'Text', text: /^The receiver answered: / }))?.text ?? ''
  expect(cut.endsWith('…')).toBe(true)
  expect(displayWidth(cut)).toBeLessThanOrEqual(40)
  await narrow.unmount()
})
