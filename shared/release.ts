/**
 * Whether a newer release than the one running has been published: the
 * latest release of the repository the plugin's manifest names, asked of
 * GitHub at most every few hours and kept in the plugin's store, so every
 * session of the machine shares one answer.
 */

/** How long a latest-release answer is trusted before GitHub is asked again. */
export const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000

/** The `$.store` key of the latest release last heard of. */
export const LATEST_RELEASE_KEY = 'latestRelease'

/** The latest release as last heard of: its version, and when GitHub was asked. */
export type LatestRelease = { version: string | null; checkedAt: number }

/** What asking for the latest release needs: the store, the clock and a fetch, as the hooks module hands them over. */
export type ReleaseIo = {
  now: () => Promise<number>
  get: () => Promise<unknown>
  set: (value: LatestRelease) => Promise<void>
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: string }>
}

/** GitHub's latest-release endpoint for a repository URL such as `https://github.com/<owner>/<repo>`; null for any other host. */
export function latestReleaseUrl(repository: unknown): string | null {
  if (typeof repository !== 'string') return null
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repository.trim())

  return match ? `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest` : null
}

/** The version a latest-release answer names: its tag without the `v`; null when it names none. */
export function versionOfRelease(text: string): string | null {
  try {
    const tag = (JSON.parse(text) as { tag_name?: unknown }).tag_name
    if (typeof tag !== 'string') return null
    const version = tag.trim().replace(/^v/, '')

    return /^\d+\.\d+\.\d+$/.test(version) ? version : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** Whether `latest` is a later version than `current`, both `major.minor.patch`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parts = (version: string) => version.split('.').map(part => Number.parseInt(part, 10))
  const [a, b] = [parts(latest), parts(current)]
  for (let index = 0; index < 3; index += 1) {
    const [x = 0, y = 0] = [a[index], b[index]]
    if (x !== y) return x > y
  }

  return false
}

function asLatest(value: unknown): LatestRelease | null {
  const kept = value as Partial<LatestRelease> | undefined
  if (typeof kept?.checkedAt !== 'number') return null

  return { version: typeof kept.version === 'string' ? kept.version : null, checkedAt: kept.checkedAt }
}

/**
 * The latest release's version: the one kept while it is recent, else asked
 * of GitHub and kept. A failed request keeps what was heard before and is
 * asked again at the next check; null when nothing was ever heard.
 */
export async function latestVersion(io: ReleaseIo, url: string): Promise<string | null> {
  const now = await io.now()
  const kept = asLatest(await io.get())
  if (kept && now - kept.checkedAt < RELEASE_CHECK_MS) return kept.version
  const response = await io.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-mods' } })
  if (!response.ok) return kept?.version ?? null
  const version = versionOfRelease(response.text)
  await io.set({ version, checkedAt: now })

  return version
}

/** The running release as the hooks module reads it from its own files, and the latest heard of. */
export type RunningRelease = { version?: string; date?: string; repository?: string; latest?: string | null }

/**
 * What the pane header shows of the release: `v0.6.3 (2026-10-08)`, or, once a
 * later release is published, `Update Required` in place of the date, marked
 * for the header to draw in the warning colour.
 */
export function releaseHeader(
  release: RunningRelease,
  label: (version: string, date?: string) => string,
  updateRequired: string,
): { release: string | undefined; isReleaseOutdated: boolean } {
  if (!release.version) return { release: undefined, isReleaseOutdated: false }
  const isReleaseOutdated = typeof release.latest === 'string' && isNewerVersion(release.latest, release.version)

  return { release: label(release.version, isReleaseOutdated ? updateRequired : release.date), isReleaseOutdated }
}
