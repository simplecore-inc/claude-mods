import type { HttpResponse } from 'claude-code'

import type { LimitView, StatusInfo, WebhookSend } from '../types'
import { claudeDirectory, deleteWebhookToken, platformOf, readWebhookToken, writeWebhookToken } from './credentials'
import type { Messages } from './i18n'
import type { Io } from './io'
import { message, within } from './io'
import type { WebhookDraft } from './views/webhook'
import { changeKey, DEFAULT_TEMPLATE_TEXT, FORMER_DEFAULT_TEXTS, parseConfig, renderTemplate, urlProblem, webhookRequest, webhookValues, WEBHOOK_HEARTBEAT_MS, WEBHOOK_MIN_GAP_MS } from './webhook'
import type { WebhookConfig } from './webhook'
import { writeAtomic } from './writes'

/**
 * The webhook: the session's status filled into the template file and sent
 * to the URL set, when it changes and as a heartbeat. One send waits at a
 * time, so a receiver that does not answer never gathers a queue.
 */

/** What the feed reads and shows beyond the machine. */
export type FeedContext = {
  io: Io
  messages: () => Messages
  webhookLast: (last: WebhookSend) => Promise<void>
  /** The live account's email and windows, for the template's variables. */
  liveFigures: () => Promise<{ email: string | null; limits: LimitView[] }>
  session: { id: () => string; hostname: () => string | null; version: () => string | null }
}

/** The `$.store` key of the webhook feed's settings, shared by every session on the machine. */
export const WEBHOOK_KEY = 'webhook'
/** How long a receiver has to answer before the dialog says it did not. */
const WEBHOOK_TIMEOUT_MS = 10_000
/** How long a send with no answer at all holds the feed before it is let go. */
const WEBHOOK_ABANDON_MS = 5 * 60 * 1000
/** The most of a receiver's answer the dialog keeps: a receiver can answer HTTP 200 and still say it stored nothing. */
const REPLY_KEPT = 200

/** What the feed last sent and when, so an unchanged status is not sent again until the heartbeat. */
let lastFeed = { key: '', at: 0 }
/** The send waiting for its answer, numbered, and since when. */
let sending: { number: number; since: number } | null = null
let sends = 0

/** Starts the feed afresh, as a new session does. */
export function resetFeed(): void {
  lastFeed = { key: '', at: 0 }
}

/** The template file of the webhook feed, under Claude Code's config directory. */
export async function templatePath(io: Io): Promise<string> {
  return `${await claudeDirectory(io)}/sc-accounts/webhook.json`
}

/** The template's text: the file's, or the default while there is none. */
async function readTemplate(io: Io): Promise<string> {
  const path = await templatePath(io)

  return (await io.exists(path)) ? io.read(path) : DEFAULT_TEMPLATE_TEXT
}

/** Writes the template file from the default when it is missing, or brings a former default up to date, as the dialog does each time it opens. */
export async function ensureTemplate(io: Io): Promise<void> {
  const path = await templatePath(io)
  if (await io.exists(path)) {
    await upgradeTemplate(io)

    return
  }
  const { isWindows } = await platformOf(io)
  await writeAtomic(io, path, DEFAULT_TEMPLATE_TEXT, { isPrivate: false, isWindows })
}

/**
 * Brings a template file that still holds, byte for byte, a default an
 * earlier release wrote to the current default; a file the person edited is
 * theirs and stays as it is. Run as a session starts and as the dialog opens;
 * a send never writes the template. Whether it wrote.
 */
export async function upgradeTemplate(io: Io): Promise<boolean> {
  const path = await templatePath(io)
  if (!(await io.exists(path))) return false
  // Only a file the size of a former default is read: the defaults are ASCII, so characters are bytes.
  const { size } = await io.stat(path)
  if (!FORMER_DEFAULT_TEXTS.some(text => text.length === size) || !FORMER_DEFAULT_TEXTS.includes(await io.read(path))) return false
  const { isWindows } = await platformOf(io)
  await writeAtomic(io, path, DEFAULT_TEMPLATE_TEXT, { isPrivate: false, isWindows })

  return true
}

/** The start of a receiver's answer on one line, or null when it said nothing. */
export function replyExcerpt(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim()

  return line === '' ? null : line.slice(0, REPLY_KEPT)
}

/** The template filled with the session's status now, or why it cannot be. */
async function webhookBody(ctx: FeedContext, status: StatusInfo, modelId: string, cwd: string, cost: number | null) {
  const figures = await ctx.liveFigures()
  const values = webhookValues({
    session: ctx.session.id(),
    now: await ctx.io.now(),
    hostname: ctx.session.hostname(),
    version: ctx.session.version(),
    cwd,
    modelId,
    status,
    cost,
    account: figures.email,
    limits: figures.limits,
  })

  return { values, rendered: renderTemplate(await readTemplate(ctx.io), values) }
}

/** Sends the filled template, and keeps how it went for the dialog: the answer and what it said, or why none came. */
async function send(ctx: FeedContext, config: WebhookConfig, rendered: { body: string; value: unknown }, token: string | null, onSettled?: () => void): Promise<void> {
  const at = await ctx.io.now()
  let request: Promise<HttpResponse> | null = null
  try {
    const { url, init } = webhookRequest(config, rendered, token)
    request = ctx.io.fetch(url, init)
    void request.finally(() => onSettled?.()).catch(() => undefined)
    const response = await within(ctx.io, request, WEBHOOK_TIMEOUT_MS, ctx.messages().webhookNoAnswer(WEBHOOK_TIMEOUT_MS / 1000))
    await ctx.webhookLast({ at, status: response.status, error: null, reply: replyExcerpt(response.text) })
  } catch (error) {
    // Failed before the request went out: nothing is left waiting.
    if (request === null) onSettled?.()
    await ctx.webhookLast({ at, status: null, error: message(error), reply: null })
  }
}

/** Sends the status when the feed is on and something changed, or the heartbeat is due; never twice in two seconds. */
export async function feedWebhook(ctx: FeedContext, status: StatusInfo, modelId: string, cwd: string, cost: number | null): Promise<void> {
  const { io } = ctx
  // Read each time, so a save in any session applies to every session.
  const config = parseConfig(await io.store.get(WEBHOOK_KEY))
  if (!config.enabled || urlProblem(config.url) !== null) return
  const now = await io.now()
  if (now - lastFeed.at < WEBHOOK_MIN_GAP_MS) return
  // One send waits at a time; one that never answers is let go after a while, so the feed goes on.
  if (sending !== null && now - sending.since < WEBHOOK_ABANDON_MS) return
  const { values, rendered } = await webhookBody(ctx, status, modelId, cwd, cost)
  if (!('body' in rendered)) return
  const key = changeKey(values)
  if (key === lastFeed.key && now - lastFeed.at < WEBHOOK_HEARTBEAT_MS) return
  lastFeed = { key, at: now }
  sends += 1
  const number = sends
  sending = { number, since: now }
  const release = () => {
    if (sending?.number === number) sending = null
  }
  // Not awaited: the status reading never waits on the receiver.
  void send(ctx, config, rendered, await readWebhookToken(io).catch(() => null), release).catch((error: unknown) => io.log(message(error)))
}

/** The draft as a config, its URL trimmed. */
export function draftConfig(draft: WebhookDraft): WebhookConfig {
  return { enabled: draft.enabled, url: draft.url.trim(), method: draft.method }
}

/** The words for a URL that cannot be sent to, or null. */
export function urlMessage(m: Messages, problem: ReturnType<typeof urlProblem>): string | null {
  if (problem === 'empty') return m.webhookUrlEmpty
  if (problem === 'scheme') return m.webhookUrlScheme
  if (problem === 'invalid') return m.webhookUrlInvalid

  return null
}

/** The settings as stored, whether a token is kept, the template file written first when missing: what the dialog opens with. */
export async function openWebhook(io: Io): Promise<{ config: WebhookConfig; hasToken: boolean }> {
  const config = parseConfig(await io.store.get(WEBHOOK_KEY))
  const hasToken = (await readWebhookToken(io)) !== null
  await ensureTemplate(io)

  return { config, hasToken }
}

/** What the dialog previews: the request the draft would make now, or why it makes none. */
export async function webhookPreview(ctx: FeedContext, draft: WebhookDraft, status: StatusInfo | null, modelId: string, cwd: string, cost: number | null): Promise<{ body: string } | { problem: string }> {
  const m = ctx.messages()
  if (!status) return { problem: m.webhookTemplateMissing }
  const { rendered } = await webhookBody(ctx, status, modelId, cwd, cost)
  if ('invalid' in rendered) return { problem: m.webhookTemplateInvalid(rendered.invalid) }
  if ('unknown' in rendered) return { problem: m.webhookTemplateUnknown(rendered.unknown.join(', ')) }
  const config = draftConfig(draft)
  if (config.method === 'GET' && urlProblem(config.url) === null) return { body: `GET ${webhookRequest(config, rendered, null).url}` }

  return { body: JSON.stringify(rendered.value, null, 2) }
}

/** Saves the draft: the settings to the store, the token to its secret store; refused with a reason when the URL cannot be sent to. */
export async function saveWebhook(ctx: FeedContext, draft: WebhookDraft): Promise<string> {
  const m = ctx.messages()
  const config = draftConfig(draft)
  if (config.enabled && urlProblem(config.url) !== null) throw new Error(urlMessage(m, urlProblem(config.url)) ?? '')
  if (draft.clearToken) await deleteWebhookToken(ctx.io)
  if (draft.token.trim() !== '') await writeWebhookToken(ctx.io, draft.token.trim())
  await ctx.io.store.set(WEBHOOK_KEY, config)
  resetFeed()

  return config.enabled ? m.webhookOn : m.webhookOff
}

/** Sends the draft once, the token typed or kept, and keeps how it went. */
export async function testWebhook(ctx: FeedContext, draft: WebhookDraft, status: StatusInfo | null, modelId: string, cwd: string, cost: number | null): Promise<void> {
  const m = ctx.messages()
  const config = draftConfig(draft)
  const problem = urlProblem(config.url)
  if (problem !== null) throw new Error(urlMessage(m, problem) ?? '')
  if (!status) throw new Error(m.webhookTemplateMissing)
  const { rendered } = await webhookBody(ctx, status, modelId, cwd, cost)
  if (!('body' in rendered)) throw new Error('invalid' in rendered ? m.webhookTemplateInvalid(rendered.invalid) : m.webhookTemplateUnknown(rendered.unknown.join(', ')))
  const typed = draft.token.trim()
  const token = draft.clearToken ? null : typed !== '' ? typed : await readWebhookToken(ctx.io)
  await send(ctx, config, rendered, token)
}
