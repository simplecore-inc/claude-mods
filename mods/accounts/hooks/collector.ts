import { transcriptPath } from './shared/claude'
import { inProgressTask, parsePr, todoFilesOf, ultracodeAfter, ULTRA_MARKER } from './status'

/** Runs a command by argv; the hooks module passes one over `$.process.run`. */
export type Run = (
  argv: readonly string[],
  init?: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** What the collector reads through: the hooks module builds each over `$`. */
export type CollectorIo = {
  run: Run
  /** A file's text, or null when it is missing. */
  read: (path: string) => Promise<string | null>
  /** A directory's entries, or none when it is missing. */
  list: (path: string) => Promise<readonly { name: string; mtimeMs: number }[]>
  /** A file's size in bytes, or null when it is missing. */
  size: (path: string) => Promise<number | null>
}

/** How long a PR reading stands before `gh` is asked again, on the same branch. */
const PR_TTL_MS = 3 * 60 * 1000
/** The longest transcript line read for an ultracode switch; attachment records are small. */
const MAX_ATTACHMENT_LINE = 64 * 1024

/**
 * Reads the parts of the status the engine does not hand a plugin, each as cheaply
 * as it allows: the branch from git, the PR from `gh` at most every three
 * minutes, the task from the session's todo list, and ultracode from the
 * transcript, scanning only what was appended since the last read.
 */
export class StatusCollector {
  private ultra = { path: '', offset: 0, active: false }
  /** Set once the shell the transcript scan runs in could not be started (Windows has none): never tried again. */
  private hasNoShell = false
  private pr: { branch: string; at: number; value: { number: number; reviewState: string | null } | null } = {
    branch: '',
    at: 0,
    value: null,
  }

  /** The session's transcript once found, and when a search last came up empty. */
  private found = { session: '', path: '', missedAt: -Infinity }

  constructor(private readonly io: CollectorIo) {}

  /**
   * Runs a command that may be missing on this machine (git, gh, a shell):
   * one that cannot be started answers like one that failed, so a missing
   * tool empties its part of the status and never the whole read.
   */
  private async tryRun(argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) {
    try {
      return await this.io.run(argv, init)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return { exitCode: -1, stdout: '', stderr: error.message }
    }
  }

  /** The checked-out branch of `cwd`, or `''` outside a repository, on a detached head, or without git. */
  async branch(cwd: string): Promise<string> {
    const { exitCode, stdout } = await this.tryRun(['git', '-C', cwd, 'branch', '--show-current'], { timeoutMs: 2000 })

    return exitCode === 0 ? stdout.trim() : ''
  }

  /** The open PR of `branch`, asked of `gh` when the branch changed or the last answer is three minutes old. */
  async pullRequest(cwd: string, branch: string, now: number): Promise<{ number: number; reviewState: string | null } | null> {
    if (branch === '') return null
    if (this.pr.branch === branch && now - this.pr.at < PR_TTL_MS) return this.pr.value
    // Set first, so a slow or failing gh is asked once per window, not on every read.
    this.pr = { branch, at: now, value: this.pr.branch === branch ? this.pr.value : null }
    const { exitCode, stdout } = await this.tryRun(['gh', 'pr', 'view', '--json', 'number,reviewDecision'], { cwd, timeoutMs: 10_000 })
    this.pr.value = exitCode === 0 ? parsePr(stdout) : null

    return this.pr.value
  }

  /** The in-progress task of the session's newest todo list (under Claude Code's config directory), or `''`. */
  async task(configDirectory: string, session: string): Promise<string> {
    const directory = `${configDirectory}/todos`
    const [newest] = todoFilesOf(await this.io.list(directory), session)
    if (!newest) return ''
    const text = await this.io.read(`${directory}/${newest}`)

    return text === null ? '' : inProgressTask(text)
  }

  /**
   * The session's transcript, or null before it is written. It is looked for
   * in the folder named after `root` first. Where it is not there (the root
   * Claude Code named it after differs, such as a path it resolved through a
   * link), every project folder is searched for `<session>.jsonl`, at most
   * once a minute until it is found, and the place found is kept.
   */
  async transcript(configDirectory: string, root: string, session: string, now: number): Promise<string | null> {
    if (this.found.session !== session) this.found = { session, path: '', missedAt: -Infinity }
    if (this.found.path !== '' && (await this.io.size(this.found.path)) !== null) return this.found.path
    const named = transcriptPath(configDirectory, root, session)
    if ((await this.io.size(named)) !== null) {
      this.found.path = named

      return named
    }
    if (now - this.found.missedAt < TRANSCRIPT_RETRY_MS) return null
    const projects = `${configDirectory}/projects`
    for (const folder of await this.io.list(projects)) {
      const path = `${projects}/${folder.name}/${session}.jsonl`
      if ((await this.io.size(path)) !== null) {
        this.found.path = path

        return path
      }
    }
    this.found.missedAt = now

    return null
  }

  /**
   * Whether ultracode is on, from the transcript's switches. Transcripts grow
   * to hundreds of MB, so only the bytes appended since the last call are
   * scanned, by `tail` and `grep` outside the plugin's environment; a
   * transcript that shrank or changed path is scanned afresh.
   */
  async ultracode(transcript: string | null): Promise<boolean> {
    if (this.hasNoShell || transcript === null) return false
    const size = await this.io.size(transcript)
    if (size === null) return false
    if (this.ultra.path !== transcript || size < this.ultra.offset) this.ultra = { path: transcript, offset: 0, active: false }
    if (size === this.ultra.offset) return this.ultra.active
    // Read up to `size`. A record is appended in one write, so a cut line there is rare,
    // and only an ultracode switch inside such a line would go unseen.
    const script = `head -c "$2" "$1" | tail -c +"$3" | grep -a -F -e "$4" | awk -v max="$5" 'length($0) <= max'`
    const { exitCode, stdout, stderr } = await this.tryRun(
      ['sh', '-c', script, 'sh', transcript, String(size), String(this.ultra.offset + 1), ULTRA_MARKER, String(MAX_ATTACHMENT_LINE)],
      { timeoutMs: 30_000 },
    )
    if (exitCode === -1) {
      // A shell that could not be started is missing for good; one stopped by the time limit
      // (a slow disk, a huge first scan) is asked again from the same offset next time.
      if (/failed to start|ENOENT/.test(stderr)) this.hasNoShell = true

      return this.ultra.active
    }
    // The pipeline ends with awk, so it exits 0 whether grep matched or not; anything else is a failure.
    if (exitCode !== 0) return this.ultra.active
    this.ultra = { path: transcript, offset: size, active: ultracodeAfter(stdout, this.ultra.active) }

    return this.ultra.active
  }
}

/** How long a transcript that could not be found waits before the project folders are searched again. */
const TRANSCRIPT_RETRY_MS = 60_000

