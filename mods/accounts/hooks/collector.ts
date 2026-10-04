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
  private pr: { branch: string; at: number; value: { number: number; reviewState: string | null } | null } = {
    branch: '',
    at: 0,
    value: null,
  }

  constructor(private readonly io: CollectorIo) {}

  /** The checked-out branch of `cwd`, or `''` outside a repository or on a detached head. */
  async branch(cwd: string): Promise<string> {
    const { exitCode, stdout } = await this.io.run(['git', '-C', cwd, 'branch', '--show-current'], { timeoutMs: 2000 })

    return exitCode === 0 ? stdout.trim() : ''
  }

  /** The open PR of `branch`, asked of `gh` when the branch changed or the last answer is three minutes old. */
  async pullRequest(cwd: string, branch: string, now: number): Promise<{ number: number; reviewState: string | null } | null> {
    if (branch === '') return null
    if (this.pr.branch === branch && now - this.pr.at < PR_TTL_MS) return this.pr.value
    // Set first, so a slow or failing gh is asked once per window, not on every read.
    this.pr = { branch, at: now, value: this.pr.branch === branch ? this.pr.value : null }
    const { exitCode, stdout } = await this.io.run(['gh', 'pr', 'view', '--json', 'number,reviewDecision'], { cwd, timeoutMs: 10_000 })
    this.pr.value = exitCode === 0 ? parsePr(stdout) : null

    return this.pr.value
  }

  /** The in-progress task of the session's newest todo list, or `''`. */
  async task(home: string, session: string): Promise<string> {
    const directory = `${home}/.claude/todos`
    const [newest] = todoFilesOf(await this.io.list(directory), session)
    if (!newest) return ''
    const text = await this.io.read(`${directory}/${newest}`)

    return text === null ? '' : inProgressTask(text)
  }

  /**
   * Whether ultracode is on, from the transcript's switches. Transcripts grow
   * to hundreds of MB, so only the bytes appended since the last call are
   * scanned, by `tail` and `grep` outside the plugin's environment; a
   * transcript that shrank or changed path is scanned afresh.
   */
  async ultracode(transcript: string): Promise<boolean> {
    const size = await this.io.size(transcript)
    if (size === null) return false
    if (this.ultra.path !== transcript || size < this.ultra.offset) this.ultra = { path: transcript, offset: 0, active: false }
    if (size === this.ultra.offset) return this.ultra.active
    // Read up to `size`. A record is appended in one write, so a cut line there is rare,
    // and only an ultracode switch inside such a line would go unseen.
    const script = `head -c "$2" "$1" | tail -c +"$3" | grep -a -F -e "$4" | awk -v max="$5" 'length($0) <= max'`
    const { exitCode, stdout } = await this.io.run(
      ['sh', '-c', script, 'sh', transcript, String(size), String(this.ultra.offset + 1), ULTRA_MARKER, String(MAX_ATTACHMENT_LINE)],
      { timeoutMs: 30_000 },
    )
    // grep exits 1 when nothing matched, which is an answer, not a failure.
    if (exitCode > 1) return this.ultra.active
    this.ultra = { path: transcript, offset: size, active: ultracodeAfter(stdout, this.ultra.active) }

    return this.ultra.active
  }
}

/** The transcript Claude Code writes for a session started in `root`: its project folder is the path with every other character a `-`. */
export function transcriptPath(home: string, root: string, session: string): string {
  return `${home}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${session}.jsonl`
}
