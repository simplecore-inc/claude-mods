import { expect, test } from 'claude-code/testing'

import { refreshLockPath } from '../hooks/credentials'
import { fakeMachine } from './machine'

test('on macOS every session refreshes a saved login under one lock, whatever its CLAUDE_CONFIG_DIR', async () => {
  // The keychain the saved logins live in is the machine's, so an Orca pane in an account's own folder
  // and a session on ~/.claude must never refresh one grant at once.
  const plain = fakeMachine()
  const inProfile = fakeMachine({ env: { CLAUDE_CONFIG_DIR: '/home/me/Library/Application Support/orca/claude-profiles/o-jun/home' } })
  const uuid = '34a08cd3-7a1b-4c2d-9e3f-0a1b2c3d4e5f'
  expect(await refreshLockPath(inProfile.io, uuid)).toBe(await refreshLockPath(plain.io, uuid))
  expect(await refreshLockPath(plain.io, uuid)).toBe(`/home/me/.claude/sc-accounts/locks/refresh-${uuid}.lock`)
})
