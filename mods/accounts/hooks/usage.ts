import type { RankRow, Tokens, UsageSummary } from '../types'

/**
 * Token usage counted from Claude Code's session transcripts on this machine.
 *
 * Each response the model sent is one transcript line with its usage. The
 * lines are read outside the plugin's environment (`sh`, `head`, `tail`,
 * `awk`), only the bytes appended since the last count, and only the fields
 * counted here leave the shell. A response is written once per content
 * block, so its message id is counted once.
 */


/** One response as the scan reads it. */
export type ScanRecord = { at: string; cwd: string; model: string; id: string; input: number; cacheWrite: number; cacheRead: number; output: number }

/** What has been counted, kept in a file of the mod's own between sessions. */
export type UsageIndex = {
  version: 3
  /** Per transcript: the bytes counted so far. */
  files: Record<string, { offset: number }>
  /**
   * Every message id counted, in any transcript: a resumed or forked session
   * copies earlier responses into its own transcript, ids and all, and each is
   * counted once. Kept as a list in the file; a count works on it as a set.
   */
  ids: string[]
  /** Tokens by `day\tmodel\tproject`; the day is the local date. */
  buckets: Record<string, Tokens>
  /**
   * Per session (its transcript's name; a subagent's transcript counts toward
   * the session that started it): the projects it worked in, the days it was
   * active and the models it used.
   */
  sessions: Record<string, { projects: string[]; days: string[]; models: string[] }>
}


export function emptyIndex(): UsageIndex {
  return { version: 3, files: {}, buckets: {}, sessions: {}, ids: [] }
}

/**
 * The session a transcript belongs to: its own name for a session's
 * transcript (`<project>/<session>.jsonl`), the folder it sits under for a
 * subagent's (`<project>/<session>/subagents/agent-<id>.jsonl`).
 */
export function sessionOf(relative: string): string {
  const parts = relative.split('/').filter(Boolean)
  if (parts.length >= 3) return parts[1] ?? ''

  return (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '')
}

/** Reads a stored index; anything else, an index of another version included, starts over. */
export function asIndex(value: unknown): UsageIndex {
  const index = value as Partial<UsageIndex> | null
  if (!index || index.version !== 3 || typeof index.files !== 'object' || typeof index.buckets !== 'object' || typeof index.sessions !== 'object' || !Array.isArray(index.ids)) {
    return emptyIndex()
  }

  return index as UsageIndex
}

/**
 * The scan: bytes `$3`.. `$2` of transcript `$1` (`$4` of them), each
 * assistant line with a usage reduced to tab-separated fields: time, working
 * directory, model, message id, then input, cache write, cache read and
 * output tokens. Every field is the first of its key, and the token keys are
 * looked for only in the usage object, whose keys come in no fixed order. A
 * line is printed once the next one starts or the bytes end on its newline,
 * so a line cut by the end of the range is left for the next scan; the last
 * line printed, `#` and a count, is how many bytes the complete lines took.
 */
export const SCAN_SCRIPT = [
  'head -c "$2" "$1" | tail -c +"$3" | LC_ALL=C awk -v size="$4" \'',
  'function str(key, text) { if (match(text, "\\"" key "\\":\\"[^\\"]*\\"")) return substr(text, RSTART + length(key) + 4, RLENGTH - length(key) - 5); return "" }',
  'function num(key, text) { if (match(text, "\\"" key "\\":[0-9]+")) return substr(text, RSTART + length(key) + 3, RLENGTH - length(key) - 3); return 0 }',
  '{',
  '  if (pending != "") print pending',
  '  pending = ""; last = length($0) + 1; total += last',
  '  if (index($0, "\\"type\\":\\"assistant\\"") && (u = index($0, "\\"usage\\":{\\""))) {',
  '    s = substr($0, u, 600)',
  '    pending = str("timestamp", $0) "\\t" str("cwd", $0) "\\t" str("model", $0) "\\t" str("id", $0) "\\t" num("input_tokens", s) "\\t" num("cache_creation_input_tokens", s) "\\t" num("cache_read_input_tokens", s) "\\t" num("output_tokens", s)',
  '  }',
  '}',
  'END { if (total <= size) { if (pending != "") print pending; print "#\\t" total } else print "#\\t" (total - last) }\'',
].join('\n')

/** How many bytes of the range the scan counted: up to the end of its last complete line. */
export function scannedBytes(stdout: string): number {
  const line = stdout.trimEnd().split('\n').pop() ?? ''

  return line.startsWith('#\t') ? Number(line.slice(2)) : 0
}

/** The scan's lines as records; a line without a message id or a time is left out. */
export function parseScan(stdout: string): ScanRecord[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 8 && parts[0] !== '' && (parts[3] ?? '').startsWith('msg_'))
    .map(([at = '', cwd = '', model = '', id = '', input = '0', cacheWrite = '0', cacheRead = '0', output = '0']) => ({
      at,
      cwd: cwd.replace(/\\\\/g, '\\'),
      model,
      id,
      input: Number(input),
      cacheWrite: Number(cacheWrite),
      cacheRead: Number(cacheRead),
      output: Number(output),
    }))
}

/** The local date of an ISO time, `YYYY-MM-DD`, by the offset the environment answers for that instant. */
export function localDay(iso: string, offsetMinutes?: number): string {
  const at = Date.parse(iso)
  const local = new Date(at - (offsetMinutes ?? new Date(at).getTimezoneOffset()) * 60_000)

  return local.toISOString().slice(0, 10)
}

/** A project's name: the last folder of the directory a session worked in. */
export function projectOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)

  return parts[parts.length - 1] ?? cwd
}

function addTokens(into: Tokens | undefined, record: Pick<ScanRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): Tokens {
  const base = into ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 }

  return {
    input: base.input + record.input,
    output: base.output + record.output,
    cacheRead: base.cacheRead + record.cacheRead,
    cacheWrite: base.cacheWrite + record.cacheWrite,
    responses: base.responses + 1,
  }
}

/**
 * Adds one transcript's newly read records to the index, each message id
 * once across every transcript, and moves its offset to `offset`. `seen` is
 * the set of ids counted, which this adds to; the index passed in is not
 * changed, and the one returned leaves its `ids` to be written from `seen`.
 */
export function addRecords(
  index: UsageIndex,
  seen: Set<string>,
  file: string,
  session: string,
  records: ScanRecord[],
  offset: number,
  offsetMinutes?: number,
): UsageIndex {
  const buckets = { ...index.buckets }
  const sessions = { ...index.sessions }
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    const day = localDay(record.at, offsetMinutes)
    const project = projectOf(record.cwd)
    const key = `${day}\t${record.model}\t${project}`
    buckets[key] = addTokens(buckets[key], record)
    const known = sessions[session] ?? { projects: [], days: [], models: [] }
    sessions[session] = {
      projects: known.projects.includes(project) ? known.projects : [...known.projects, project],
      days: known.days.includes(day) ? known.days : [...known.days, day],
      models: known.models.includes(record.model) ? known.models : [...known.models, record.model],
    }
  }

  return { ...index, buckets, sessions, files: { ...index.files, [file]: { offset } } }
}


/** All four kinds of tokens together. */
export function totalOf(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

/** Cache reads over the input the model read: input plus cache reads. Null with neither. */
export function cacheReuse(tokens: Tokens): number | null {
  const read = tokens.input + tokens.cacheRead

  return read === 0 ? null : tokens.cacheRead / read
}

/** The day `count - 1` days before `today`, `YYYY-MM-DD`. */
function daysBack(today: string, count: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - (count - 1) * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The index summed over the last `days` days up to `today`, or over all of it
 * when `days` is null; rankings keep the `top` largest.
 */
export function summarize(index: UsageIndex, days: number | null, today: string, top = 5): UsageSummary {
  const days_ = Object.keys(index.buckets).map(key => key.split('\t')[0] ?? '')
  const first = days === null ? (days_.sort()[0] ?? today) : daysBack(today, days)
  const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 })
  const add = (a: Tokens, b: Tokens): Tokens => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    responses: a.responses + b.responses,
  })
  let totals = zero()
  const byDay = new Map<string, Tokens>()
  const byModel = new Map<string, Tokens>()
  const byProject = new Map<string, Tokens>()
  for (const [key, tokens] of Object.entries(index.buckets)) {
    const [day = '', model = '', project = ''] = key.split('\t')
    if (day < first || day > today) continue
    totals = add(totals, tokens)
    byDay.set(day, add(byDay.get(day) ?? zero(), tokens))
    byModel.set(model, add(byModel.get(model) ?? zero(), tokens))
    byProject.set(project, add(byProject.get(project) ?? zero(), tokens))
  }
  const active = Object.values(index.sessions).filter(session => session.days.some(day => day >= first && day <= today))
  const rank = (map: Map<string, Tokens>, sessionsOf: (name: string) => number): RankRow[] =>
    [...map.entries()]
      .map(([name, tokens]) => ({ name, tokens, sessions: sessionsOf(name) }))
      .sort((a, b) => totalOf(b.tokens) - totalOf(a.tokens))
      .slice(0, top)
  const daily: UsageSummary['daily'] = []
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${today}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10)
    daily.push({ day, tokens: byDay.get(day) ?? zero() })
  }

  return {
    totals,
    daily,
    models: rank(byModel, name => active.filter(session => session.models.includes(name)).length),
    projects: rank(byProject, name => active.filter(session => session.projects.includes(name)).length),
    sessions: active.length,
  }
}

/** A token count in a few characters: `873`, `12.4k`, `221.6M`, `1.9B`. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value)
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [size, unit] of units) if (value >= size) return `${(value / size).toFixed(1)}${unit}`

  return String(value)
}

/** Message ids written to one file: well under the engine's 4 MiB a read or a write takes. */
export const IDS_PER_FILE = 80_000

/**
 * The index as written: its ids in files of their own, `IDS_PER_FILE` to a
 * file, and the index naming how many there are; the engine reads and writes
 * at most 4 MiB at a time, and a machine's ids pass that.
 */
export function indexToStore(index: UsageIndex, ids: readonly string[]): { index: UsageIndex & { idFiles: number }; idFiles: string[][] } {
  const idFiles: string[][] = []
  for (let start = 0; start < ids.length; start += IDS_PER_FILE) idFiles.push(ids.slice(start, start + IDS_PER_FILE))

  return { index: { ...index, ids: [], idFiles: idFiles.length }, idFiles }
}
