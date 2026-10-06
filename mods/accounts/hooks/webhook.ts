import type { LimitView, StatusInfo } from '../types'

/**
 * The webhook feed: the session's status sent to a URL the person sets, by
 * POST as a JSON body or by GET as query parameters, with a bearer token when
 * one is set. What is sent comes from a template file whose `{{name}}`
 * placeholders stand for the status. The template is JSON itself, so an editor checks it: a string that is
 * one placeholder alone (`"{{context}}"`) becomes that value as JSON, a number
 * staying a number and a missing value `null`; a placeholder inside a longer
 * string (`"host {{hostname}}"`) is put in as text.
 */

export type WebhookMethod = 'POST' | 'GET'

/** What the feed is set to; nothing is sent while `enabled` is false or `url` is empty. The token is kept apart, as a secret. */
export type WebhookConfig = { enabled: boolean; url: string; method: WebhookMethod }

/** The variables that are not times, in the order the dialog lists them. */
export const PLAIN_VARIABLES = [
  'session',
  'hostname',
  'version',
  'cwd',
  'dir',
  'branch',
  'model',
  'modelId',
  'effort',
  'fast',
  'ultracode',
  'context',
  'cost',
  'linesAdded',
  'linesRemoved',
  'task',
  'pr',
  'prReview',
  'account',
  'fiveHour',
  'weekly',
] as const

/**
 * The formats a time is sent in: ISO 8601 text in UTC, Unix time in seconds
 * (a number, as Claude Code's status line input gives its reset times), Unix
 * time in milliseconds (a number), and the local time with its offset from UTC
 * (RFC 3339 text).
 */
export const TIME_FORMATS = ['iso', 'epoch', 'epochMs', 'local'] as const

export type TimeFormat = (typeof TIME_FORMATS)[number]

/** The time variables by format: now, the five-hour window's reset and the weekly window's, in the order the dialog lists them. */
export const TIME_VARIABLES = {
  iso: ['time', 'fiveHourResetsAt', 'weeklyResetsAt'],
  epoch: ['timeEpoch', 'fiveHourResetsAtEpoch', 'weeklyResetsAtEpoch'],
  epochMs: ['timeEpochMs', 'fiveHourResetsAtEpochMs', 'weeklyResetsAtEpochMs'],
  local: ['timeLocal', 'fiveHourResetsAtLocal', 'weeklyResetsAtLocal'],
} as const

/** Every variable a template may use; `timestamp`, the older name of `timeEpochMs`, still fills. */
export const WEBHOOK_VARIABLES = [
  ...PLAIN_VARIABLES,
  ...TIME_VARIABLES.iso,
  ...TIME_VARIABLES.epoch,
  ...TIME_VARIABLES.epochMs,
  ...TIME_VARIABLES.local,
  'timestamp',
] as const

export type WebhookVariable = (typeof WEBHOOK_VARIABLES)[number]

export type WebhookValues = Record<WebhookVariable, string | number | boolean | null>

/**
 * A template shaped like Claude Code's status line input, its reset times in
 * Unix seconds as that input gives them, so a receiver written for that input
 * already reads it.
 */
export const DEFAULT_TEMPLATE = {
  session_id: '{{session}}',
  cwd: '{{cwd}}',
  workspace: { current_dir: '{{cwd}}' },
  model: { id: '{{modelId}}', display_name: '{{model}}' },
  version: '{{version}}',
  effort: { level: '{{effort}}' },
  fast_mode: '{{fast}}',
  context_window: { used_percentage: '{{context}}' },
  cost: { total_cost_usd: '{{cost}}', total_lines_added: '{{linesAdded}}', total_lines_removed: '{{linesRemoved}}' },
  rate_limits: {
    five_hour: { used_percentage: '{{fiveHour}}', resets_at: '{{fiveHourResetsAtEpoch}}' },
    seven_day: { used_percentage: '{{weekly}}', resets_at: '{{weeklyResetsAtEpoch}}' },
  },
  account: '{{account}}',
  hostname: '{{hostname}}',
}

/** The default template as the file holds it. */
export const DEFAULT_TEMPLATE_TEXT = `${JSON.stringify(DEFAULT_TEMPLATE, null, 2)}\n`

/**
 * The default earlier releases wrote (0.3.0 to 0.5.4), its reset times as ISO
 * text where the status line input gives Unix seconds. A template file still
 * holding it byte for byte was never edited, and is brought to the current
 * default.
 */
const FORMER_DEFAULTS = [
  {
    session_id: '{{session}}',
    cwd: '{{cwd}}',
    workspace: { current_dir: '{{cwd}}' },
    model: { id: '{{modelId}}', display_name: '{{model}}' },
    version: '{{version}}',
    effort: { level: '{{effort}}' },
    fast_mode: '{{fast}}',
    context_window: { used_percentage: '{{context}}' },
    cost: { total_cost_usd: '{{cost}}', total_lines_added: '{{linesAdded}}', total_lines_removed: '{{linesRemoved}}' },
    rate_limits: {
      five_hour: { used_percentage: '{{fiveHour}}', resets_at: '{{fiveHourResetsAt}}' },
      seven_day: { used_percentage: '{{weekly}}', resets_at: '{{weeklyResetsAt}}' },
    },
    account: '{{account}}',
    hostname: '{{hostname}}',
  },
]

/** The former defaults as the file held them. */
export const FORMER_DEFAULT_TEXTS: readonly string[] = FORMER_DEFAULTS.map(template => `${JSON.stringify(template, null, 2)}\n`)

/** The shortest gap between two sends, and the longest the feed stays quiet while nothing changes. */
export const WEBHOOK_MIN_GAP_MS = 2000
export const WEBHOOK_HEARTBEAT_MS = 30 * 1000

export const DEFAULT_CONFIG: WebhookConfig = { enabled: false, url: '', method: 'POST' }

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g
const WHOLE = /^\{\{\s*([A-Za-z]+)\s*\}\}$/

/** The config as stored, every field checked; anything else reads as the default. */
export function parseConfig(value: unknown): WebhookConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_CONFIG
  const raw = value as Partial<WebhookConfig>

  return { enabled: raw.enabled === true, url: typeof raw.url === 'string' ? raw.url : '', method: raw.method === 'GET' ? 'GET' : 'POST' }
}

/** Why a URL cannot be posted to, or null when it can: an absolute http or https URL. */
export function urlProblem(url: string): 'empty' | 'scheme' | 'invalid' | null {
  if (url.trim() === '') return 'empty'
  if (!URL.canParse(url)) return 'invalid'
  const { protocol } = new URL(url)

  return protocol === 'http:' || protocol === 'https:' ? null : 'scheme'
}

/**
 * The template text with its placeholders filled: the body and its value, or
 * why not: the template is not JSON (`invalid`, the parser's words), or it
 * names variables there are none of (`unknown`).
 */
export function renderTemplate(
  template: string,
  values: WebhookValues,
): { body: string; value: unknown } | { unknown: string[] } | { invalid: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(template)
  } catch (error) {
    if (error instanceof SyntaxError) return { invalid: error.message }
    throw error
  }
  const known = new Set<string>(WEBHOOK_VARIABLES)
  const unknown = new Set<string>()
  const fill = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = WHOLE.exec(node)
      if (whole) {
        const name = whole[1] ?? ''
        if (!known.has(name)) unknown.add(name)

        return values[name as WebhookVariable] ?? null
      }

      return node.replace(PLACEHOLDER, (_, name: string) => {
        if (!known.has(name)) unknown.add(name)

        return String(values[name as WebhookVariable] ?? '')
      })
    }
    if (Array.isArray(node)) return node.map(fill)
    if (typeof node === 'object' && node !== null) return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, fill(item)]))

    return node
  }
  const value = fill(parsed)
  if (unknown.size > 0) return { unknown: [...unknown] }

  return { body: JSON.stringify(value), value }
}

/** What the feed's values are built from, gathered by the hooks module. */
export type FeedInput = {
  session: string
  now: number
  hostname: string | null
  version: string | null
  cwd: string
  modelId: string
  status: StatusInfo
  cost: number | null
  account: string | null
  limits: readonly LimitView[]
}

/** One moment in every format. */
export type TimeValues = { iso: string; epoch: number; epochMs: number; local: string }

/**
 * The local wall-clock time at `at` with its offset from UTC, as RFC 3339
 * writes it: `2026-10-06T18:20:00+09:00`. `offsetMinutes` is what
 * `Date#getTimezoneOffset` answers for that instant (UTC minus local).
 */
export function localTime(at: number, offsetMinutes = new Date(at).getTimezoneOffset()): string {
  const east = -offsetMinutes
  const wall = new Date(at + east * 60_000).toISOString().slice(0, 19)
  const size = Math.abs(east)

  return `${wall}${east < 0 ? '-' : '+'}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`
}

/** The moment `at` (milliseconds since 1970 UTC) in every format a template can send it in. */
export function timeValues(at: number, offsetMinutes?: number): TimeValues {
  return { iso: new Date(at).toISOString(), epoch: Math.floor(at / 1000), epochMs: at, local: localTime(at, offsetMinutes) }
}

/** The template variables' values for one moment of the session. */
export function webhookValues(input: FeedInput): WebhookValues {
  const { status } = input
  const window = (label: string) => input.limits.find(limit => limit.label === label)
  // A reset time that does not parse is no time: null in every format.
  const resetOf = (label: string) => {
    const at = Date.parse(window(label)?.resetsAt ?? '')

    return Number.isNaN(at) ? null : timeValues(at)
  }
  const now = timeValues(input.now)
  const fiveHour = resetOf('5h')
  const weekly = resetOf('wk')

  return {
    session: input.session,
    hostname: input.hostname,
    version: input.version,
    cwd: input.cwd,
    dir: status.dir,
    branch: status.branch || null,
    model: status.model,
    modelId: input.modelId,
    effort: status.effort,
    fast: status.fast,
    ultracode: status.ultracode,
    context: status.contextUsed,
    cost: input.cost,
    linesAdded: status.linesAdded,
    linesRemoved: status.linesRemoved,
    task: status.task || null,
    pr: status.pr?.number ?? null,
    prReview: status.pr?.reviewState ?? null,
    account: input.account,
    fiveHour: window('5h')?.percent ?? null,
    weekly: window('wk')?.percent ?? null,
    time: now.iso,
    timeEpoch: now.epoch,
    timeEpochMs: now.epochMs,
    timeLocal: now.local,
    timestamp: now.epochMs,
    fiveHourResetsAt: fiveHour?.iso ?? null,
    fiveHourResetsAtEpoch: fiveHour?.epoch ?? null,
    fiveHourResetsAtEpochMs: fiveHour?.epochMs ?? null,
    fiveHourResetsAtLocal: fiveHour?.local ?? null,
    weeklyResetsAt: weekly?.iso ?? null,
    weeklyResetsAtEpoch: weekly?.epoch ?? null,
    weeklyResetsAtEpochMs: weekly?.epochMs ?? null,
    weeklyResetsAtLocal: weekly?.local ?? null,
  }
}

/** The values that say something changed: all but the ones telling the time now. */
export function changeKey(values: WebhookValues): string {
  const { time: _time, timeEpoch: _timeEpoch, timeEpochMs: _timeEpochMs, timeLocal: _timeLocal, timestamp: _timestamp, ...rest } = values

  return JSON.stringify(rest)
}

/**
 * The request for one send: POST carries the filled template as a JSON body;
 * GET carries its top-level fields as query parameters (an object or array
 * as JSON text, `null` left out). A token goes in `Authorization: Bearer`.
 */
export function webhookRequest(
  config: WebhookConfig,
  rendered: { body: string; value: unknown },
  token: string | null,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (config.method === 'POST') {
    return { url: config.url, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: rendered.body } }
  }
  const url = new URL(config.url)
  const fields = typeof rendered.value === 'object' && rendered.value !== null && !Array.isArray(rendered.value) ? Object.entries(rendered.value) : []
  for (const [key, item] of fields) {
    if (item === null || item === undefined) continue
    url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item))
  }

  return { url: url.toString(), init: { method: 'GET', headers } }
}
