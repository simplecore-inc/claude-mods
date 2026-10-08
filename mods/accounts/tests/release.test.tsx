import { expect, test } from 'claude-code/testing'
import type { ElementTable } from 'claude-code'

import { Header, theme } from '../hooks/shared/kit'
import { LATEST_RELEASE_KEY, RELEASE_CHECK_MS, isNewerVersion, latestReleaseUrl, latestVersion, releaseHeader, versionOfRelease } from '../hooks/shared/release'
import type { LatestRelease, ReleaseIo } from '../hooks/shared/release'

const label = (version: string, date?: string) => (date ? `v${version} (${date})` : `v${version}`)

test('the latest-release address comes from the manifest\'s GitHub repository, and from no other host', async () => {
  expect(latestReleaseUrl('https://github.com/simplecore-inc/claude-mods')).toBe('https://api.github.com/repos/simplecore-inc/claude-mods/releases/latest')
  expect(latestReleaseUrl('https://github.com/owner/repo.git/')).toBe('https://api.github.com/repos/owner/repo/releases/latest')
  expect(latestReleaseUrl('https://gitlab.com/owner/repo')).toBeNull()
  expect(latestReleaseUrl(undefined)).toBeNull()
})

test('a release tag reads as its version, and versions compare part by part', async () => {
  expect(versionOfRelease('{"tag_name":"v0.6.3"}')).toBe('0.6.3')
  expect(versionOfRelease('{"tag_name":"nightly"}')).toBeNull()
  expect(versionOfRelease('not json')).toBeNull()
  expect(isNewerVersion('0.6.10', '0.6.9')).toBe(true)
  expect(isNewerVersion('0.7.0', '0.6.12')).toBe(true)
  expect(isNewerVersion('0.6.3', '0.6.3')).toBe(false)
  expect(isNewerVersion('0.6.2', '0.6.3')).toBe(false)
})

test('the header shows the date until a later release is published, then Update Required in its place', async () => {
  expect(releaseHeader({ version: '0.6.3', date: '2026-10-08', latest: '0.6.3' }, label, 'Update Required')).toEqual({ release: 'v0.6.3 (2026-10-08)', isReleaseOutdated: false })
  expect(releaseHeader({ version: '0.6.3', date: '2026-10-08', latest: null }, label, 'Update Required')).toEqual({ release: 'v0.6.3 (2026-10-08)', isReleaseOutdated: false })
  expect(releaseHeader({ version: '0.6.3', date: '2026-10-08', latest: '0.6.4' }, label, 'Update Required')).toEqual({ release: 'v0.6.3 (Update Required)', isReleaseOutdated: true })
  expect(releaseHeader({}, label, 'Update Required')).toEqual({ release: undefined, isReleaseOutdated: false })
})

/** A store, a clock and GitHub answering with the tag given, counting its requests. */
function releaseIo(tag: string | null, start: number) {
  let kept: unknown
  let now = start
  const requests: string[] = []
  const io: ReleaseIo = {
    now: async () => now,
    get: async () => kept,
    set: async (value: LatestRelease) => void (kept = value),
    fetch: async url => {
      requests.push(url)
      return tag === null ? { ok: false, status: 403, text: '' } : { ok: true, status: 200, text: JSON.stringify({ tag_name: tag }) }
    },
  }

  return { io, requests, advance: (ms: number) => void (now += ms), kept: () => kept as LatestRelease | undefined }
}

test('GitHub is asked once every few hours, its answer kept for every session, and a failed request keeps the last answer', async () => {
  const github = releaseIo('v0.6.4', 1_000)
  const url = 'https://api.github.com/repos/o/r/releases/latest'
  expect(await latestVersion(github.io, url)).toBe('0.6.4')
  expect(await latestVersion(github.io, url)).toBe('0.6.4')
  expect(github.requests.length).toBe(1)
  expect(github.kept()).toEqual({ version: '0.6.4', checkedAt: 1_000 })
  github.advance(RELEASE_CHECK_MS)
  expect(await latestVersion(github.io, url)).toBe('0.6.4')
  expect(github.requests.length).toBe(2)
  // Rate-limited: what was heard before stands, and the next check asks again.
  const limited = releaseIo(null, 5_000)
  await limited.io.set({ version: '0.6.4', checkedAt: 5_000 - RELEASE_CHECK_MS })
  expect(await latestVersion(limited.io, url)).toBe('0.6.4')
  expect(await latestVersion(limited.io, url)).toBe('0.6.4')
  expect(limited.requests.length).toBe(2)
  expect(LATEST_RELEASE_KEY).toBe('latestRelease')
})

/** The element table as plain tags, so a drawn tree can be read without an engine. */
const TAGS = { Box: 'Box', Text: 'Text', Button: 'Button' } as unknown as ElementTable
type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
function texts(node: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach(child => texts(child, found))
  else if (node && typeof node === 'object') {
    const element = node as Node
    if (element.type === 'Text') found.push(element)
    texts(element.children, found)
  }

  return found
}

test('an outdated release is drawn in the warning colour, a current one dim', async () => {
  const shown = (isReleaseOutdated: boolean) =>
    texts(Header(TAGS, { brand: '[SC] Accounts', release: 'v0.6.3 (x)', isReleaseOutdated, isUnderTabs: false, columns: 100 })).find(node =>
      JSON.stringify(node.children).includes('v0.6.3'),
    )?.props
  expect(shown(true)).toMatchObject({ color: theme.warn })
  expect(shown(true)?.dimColor).toBeUndefined()
  expect(shown(false)).toMatchObject({ dimColor: true })
})
