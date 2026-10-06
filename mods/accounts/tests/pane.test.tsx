import { expect, mock, test } from 'claude-code/testing'

import { SURFACES, bandProps, seedState, mountPane } from './paneHarness'

test('the pane offers switching only for the accounts not in use', async ($, on) => {
  seedState(on, {})
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'use-u2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    // Every account is a card; the one in use is drawn in the accent color.
    expect((await ui.find({ key: 'row-u1' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect((await ui.find({ key: 'row-u2' }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(await ui.find({ key: 'remove-u2' })).toBeDefined()
    // Switching is a filled button with a word, not a glyph.
    expect((await ui.find({ key: 'use-u2' }))?.text).toBe('Switch')
    expect((await ui.find({ key: 'use-u2-tile' }))?.props).toMatchObject({ paddingX: 1, backgroundColor: '#1f4650' })
    expect((await ui.find({ key: 'remove-u2' }))?.text).toBe('✕')
    expect(await ui.find({ key: 'use-u1' })).toBeUndefined()
    // The account in use reads in its Active badge's colour; the others in the plain one.
    expect((await ui.findAll({ type: 'Text', text: 'mina@example.com' })).some(found => found.props.color === 'cyan' && found.props.bold === true)).toBe(true)
    expect((await ui.findAll({ type: 'Text', text: 'jun@example.org' })).some(found => found.props.color !== undefined)).toBe(false)
    // The footer splits into equal filled tiles, one button in each; Close is in the header.
    expect(await ui.find({ key: 'tile-close' })).toBeUndefined()
    expect(await ui.find({ key: 'header-exit-ground' })).toBeDefined()
    for (const key of ['refresh', 'add', 'webhook']) {
      // One row tall: a filled tile with no border.
      const tile = (await ui.find({ key: `tile-${key}` }))?.props
      expect(tile).toMatchObject({ width: 39 })
      expect(tile?.borderStyle).toBeUndefined()
      expect(tile?.backgroundColor).toBeDefined()
      expect(await ui.find({ key })).toBeDefined()
      // Words alone: no glyph ahead of the label, no hotkey drawn beside it.
      expect((await ui.find({ key }))?.text).toMatch(/^[\p{L} ]+$/u)
    }
    expect(await ui.find({ key: 'guide' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Login expired/ })).toBeDefined()
    // A rate-limited account shows one mark and no words.
    expect((await ui.findAll({ type: 'Text', text: /^ ◷$/ })).length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /한도|limited/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^↻ .+\(\d+d \d{2}h\)$/ })).toBeDefined()
    // Fable resets with the weekly window: one reset line for the two.
    expect((await ui.findAll({ type: 'Text', text: /^↻ / })).length).toBe(2)
    // ...and one cell: the weekly cell holds Fable's bar, so Fable has no cell of its own.
    expect(await ui.find({ key: 'u1-wk' })).toBeDefined()
    expect(await ui.find({ key: 'u1-Fable' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Fable / })).toBeDefined()
    await ui.unmount()
  }
})

test('the add guide shows every line', async ($, on) => {
  seedState(on, { isGuideOpen: true })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // Text carries no key, so the guide's last line is found by its words.
    expect(await ui.find({ type: 'Text', text: /Within a minute/ })).toBeDefined()
    await ui.unmount()
  }
})

test('removing an account asks in a dialog that names it, in place of the list', async ($, on) => {
  seedState(on, { dialog: { kind: 'remove', uuid: 'u2' } })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^\[SC\] / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Remove jun@example.org?' })).toBeDefined()
    expect((await ui.find({ key: 'dialog-confirm' }))?.text).toBe('Remove')
    expect((await ui.find({ key: 'dialog' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'yellow' })
    expect(await ui.find({ key: 'row-u1' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the remove button is one press: the dialog does the asking', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'remove-u2' }))?.text).toBe('✕')
  expect(await ui.find({ key: 'remove-u2-confirm' })).toBeUndefined()
  await ui.unmount()
})

test('limit columns move to a new row only when the pane is too narrow', async ($, on) => {
  seedState(on, {})
  const wide = await mountPane($, 'terminal', 120)
  expect(await wide.find({ key: 'u1-limits-0' })).toBeDefined()
  expect(await wide.find({ key: 'u1-limits-1' })).toBeUndefined()
  await wide.unmount()
  const narrow = await mountPane($, 'terminal', 40)
  expect(await narrow.find({ key: 'u1-limits-1' })).toBeDefined()
  await narrow.unmount()
})

test('each account with figures says how long ago they were looked up', async ($, on) => {
  // The test clock stands at 0: u1 was looked up five minutes before, u3 half a minute before.
  seedState(on, {
    usage: {
      u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: -5 * 60_000, source: 'lookup' },
      u2: { limits: [], fetchedAt: -5 * 60_000, error: 'Login expired', source: 'lookup' },
      u3: { limits: [{ label: '5h', percent: 10 }], fetchedAt: -30_000, source: 'lookup' },
    },
  })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // u1 says it; u3, under a minute, and u2, with no figures to date, say nothing.
    const shown = await ui.findAll({ type: 'Text', text: /^ {2}\(updated .+ ago\)$/ })
    expect(shown.map(found => found.text)).toEqual(['  (updated 5m ago)'])
    await ui.unmount()
  }
})

for (const [where, pane] of [
  ['behind another pane\'s tab', { isShown: false, isPlaced: true }],
  ['waiting undrawn', { isShown: true, isPlaced: false }],
] as const) {
  test(`with the accounts pane ${where}, pressing the band opens it afresh, in front`, async ($, on) => {
    seedState(on, {})
    on('ui.panes', () => ({ value: [{ id: 'account-switch', ...pane }] as never }))
    const calls: string[] = []
    on('ui.open', ($, e) => {
      calls.push(`open ${e.id}`)
      return { value: { isPlaced: true } as never }
    })
    on('ui.close', ($, e) => {
      calls.push(`close ${e.id}`)
      return { value: undefined as never }
    })
    const ui = await $.ui.mount({ plugin: 'sc-accounts', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    await ui.press({ key: 'band-account' })
    expect(calls).toEqual(['close account-switch', 'open account-switch'])
    await ui.unmount()
  })
}

test('alone, the pane\'s header names it: [SC] Accounts', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  await ui.unmount()
})

test('beside the workspace, the header still names the pane, a row below the engine\'s tabs', async ($, on) => {
  seedState(on, { 'sc-workspace:paneOpen': true })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('alone, the header names the pane on the first row', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '[SC] Accounts' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

for (const [who, configured, isFiled] of [
  ['the login this session knows', 'u1', true],
  ['a login another session switched to', 'u2', false],
] as const) {
  test(`a response measured under ${who} is ${isFiled ? '' : 'never '}filed under the live account`, async ($, on) => {
    // The turn starts after the live account last changed (at 0), as a turn after a switch does.
    seedState(on, {}, 60_000)
    // Stand for the engine beneath: Claude Code's config names the login its requests use.
    on('env.get', ($, e) => ({ value: (e.name === 'HOME' ? '/home/me' : undefined) as never }))
    on('fs.read', () => ({ value: JSON.stringify({ oauthAccount: { accountUuid: configured, emailAddress: 'x@example.com' } }) as never }))
    const stored: string[] = []
    on('store.set', ($, e) => {
      stored.push(e.key)
      return { value: undefined as never }
    })
    on('store.get', () => ({ value: undefined as never }))
    on('session.measure', ($, e) => ({ changed: e.changed }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
    on('ui.log', () => ({ value: undefined as never }))
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never).catch(() => undefined)
    await $.session.measure({
      context: { window: 200_000, percent: 40 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2099-01-01T00:00:00Z' }],
      changed: ['rateLimits'],
    } as never)
    expect(stored.includes('usage')).toBe(isFiled)
  })
}

test('the pane has two tabs, Accounts with the count of accounts and Usage', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'tab-accounts' }))?.text).toMatch(/Accounts 3/)
  expect(await ui.find({ key: 'tab-usage' })).toBeDefined()
  await ui.unmount()
})

test('an account shows what it spent past the plan only when the endpoint reported it', async ($, on) => {
  seedState(on, {
    usage: {
      u1: { limits: [{ label: '5h', percent: 30 }], fetchedAt: 0, source: 'lookup', spend: { used: { minor: 1234, currency: 'USD', exponent: 2 }, limit: { minor: 5000, currency: 'USD', exponent: 2 } } },
      u2: { limits: [{ label: '5h', percent: 10 }], fetchedAt: 0, source: 'lookup' },
    },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Spent past the plan: 12.34 USD of 50.00 USD' })).toBeDefined()
  // One line in all: the account the endpoint reported no spend for has none.
  expect(await ui.findAll({ type: 'Text', text: /^Spent past the plan/ })).toHaveLength(1)
  await ui.unmount()
})

test('every gauge takes the same width on every card, whether a reset line shows under it or not', async ($, on) => {
  seedState(on, {})
  const ui = await mountPane($, 'terminal')
  // mina's 5h shows a reset line; kai's does not.
  const minaFive = await ui.find({ key: 'u1-5h-slot' })
  const kaiFive = await ui.find({ key: 'u3-5h-slot' })
  expect(minaFive?.props.width).toBeGreaterThan(0)
  expect(kaiFive?.props.width).toBe(minaFive?.props.width)
  // wk and Fable reset together: one block, the gauges side by side with no slot between them.
  expect(await ui.find({ key: 'u1-wk-slot' })).toBeUndefined()
  expect((await ui.find({ key: 'u1-wk' }))?.props.width).toBe(2 * Number(minaFive?.props.width ?? 0) + 3)
  await ui.unmount()
})

test('on the day a weekly window resets, its reset reads red; the five-hour window\'s stays dim', async ($, on) => {
  // Two hours before the weekly reset, whatever the machine's time zone: the same local day.
  seedState(on, {}, Date.parse('2099-01-03T00:00:00Z'))
  const ui = await mountPane($, 'terminal')
  const resets = await ui.findAll({ type: 'Text', text: /^↻ / })
  const weekly = resets.find(found => /\(1h|\(2h/.test(found.text ?? ''))
  expect(weekly?.props).toMatchObject({ color: 'red', bold: true })
  expect(resets.filter(found => found.props.color === undefined && found.props.dimColor === true).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('Switch asks first, Cancel holding the keyboard, so a stray Enter never changes every session\'s login', async ($, on) => {
  seedState(on, {})
  mock.store(on)
  const switched: unknown[] = []
  on('process.run', ($, e) => {
    switched.push(e.argv)
    return { value: { exitCode: 1, stdout: '', stderr: '' } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'use-u2' })
  await ui.unmount()
  // The press leaves the dialog to draw and touches no login.
  const after = await mountPane($, 'terminal')
  expect(await after.find({ type: 'Text', text: 'Switch to jun@example.org?' })).toBeDefined()
  expect(switched).toEqual([])
  await after.unmount()
})

test('the switch dialog names the account and focuses Cancel first', async ($, on) => {
  seedState(on, { dialog: { kind: 'switch', uuid: 'u2' } })
  mock.store(on)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Switch to jun@example.org?' })).toBeDefined()
  expect((await ui.find({ key: 'dialog-cancel' }))?.props.autoFocus).toBe(true)
  // No restart is asked: Claude Code reads the stored login again before it refreshes, so an open window follows the switch.
  expect(await ui.find({ type: 'Text', text: /window opened before the switch/ })).toBeUndefined()
  expect((await ui.find({ key: 'dialog-confirm' }))?.props.autoFocus).toBeUndefined()
  // With no Orca writing the login, it says nothing of Orca.
  expect(await ui.find({ type: 'Text', text: /Orca/ })).toBeUndefined()
  await ui.unmount()
})

test('with Orca writing the Claude login, the switch dialog says the account is selected in Orca too', async ($, on) => {
  seedState(on, { dialog: { kind: 'switch', uuid: 'u2' } }, 1_000)
  mock.store(on, { orca: { claude: { accounts: [{ id: 'o-mina', email: 'mina@example.com', organizationUuid: null }], activeId: 'o-mina' }, seenAt: 1_000 } })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Orca manages the Claude logins on this machine, so the account is selected in Orca too.' })).toBeDefined()
  await ui.unmount()
})

test('an account whose login Orca keeps says why its figures age, with no error', async ($, on) => {
  seedState(on, {
    usage: { u2: { limits: [{ label: '5h', percent: 12 }], fetchedAt: 0, isHeld: true, source: 'lookup' } },
  })
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Orca keeps this login, so its token is not refreshed here; the figures are looked up again once the account is in use.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /expired/ })).toBeUndefined()
  await ui.unmount()
})
