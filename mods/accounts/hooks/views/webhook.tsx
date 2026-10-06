import type { ElementTable } from 'claude-code'

import { PLAIN_VARIABLES, TIME_FORMATS, TIME_VARIABLES, timeValues, WEBHOOK_HEARTBEAT_MS, WEBHOOK_MIN_GAP_MS } from '../webhook'
import type { TimeFormat } from '../webhook'
import type { Messages } from '../i18n'
import { CARD_CHROME, DialogFrame, dialogHeader, IconButton, InputFrame, theme, Tiles, Toggle, Toned } from '../shared/kit'
import type { HeaderInfo } from '../shared/kit'
import { displayWidth, packRows, truncate } from '../shared/layout'

/** The rows of the body preview shown before it is cut. */
const PREVIEW_ROWS = 14

export type WebhookDraft = { enabled: boolean; url: string; method: 'POST' | 'GET'; token: string; hasToken: boolean; clearToken: boolean }

export type WebhookModel = {
  draft: WebhookDraft
  /** Where the template is read from, as the person reaches it (`~/` for home). */
  templatePath: string
  /** The body the template makes now, indented; or why it makes none. */
  preview: { body: string } | { problem: string }
  /** Why the draft's URL cannot be posted to, or null. */
  urlProblem: string | null
  /** The last send, test or feed, as one line, and the start of what the receiver answered; null before any. */
  lastSend: { text: string; ok: boolean; reply: string | null } | null
  /** The time now, which each time format's example shows. */
  now: number
  /** Whether the surface draws an Input (every surface but mobile). */
  hasField: boolean
  m: Messages
  bodyColumns: number
  header: HeaderInfo
  focused: string | null
}

export type WebhookActions = {
  toggle: () => void
  toggleMethod: () => void
  setUrl: (url: string) => void
  setToken: (token: string) => void
  clearToken: () => void
  test: () => void
  save: () => void
  cancel: () => void
}

/**
 * The webhook's settings, drawn as a dialog in the accounts pane: the on/off
 * switch, the method, the URL, the bearer token, the template file to edit
 * with the variables it may use (the times grouped by format, each format
 * said with the time now as its example), what it sends now, and the last
 * send with the receiver's answer.
 */
export function WebhookDialog(ui: ElementTable, model: WebhookModel, actions: WebhookActions) {
  const { Box, Text } = ui
  const Input = model.hasField && 'Input' in ui ? ui.Input : undefined
  const { m, draft } = model
  const room = Math.max(20, model.bodyColumns - CARD_CHROME)
  // Variable names packed into rows of the room, two cells apart.
  const nameRows = (key: string, names: readonly string[]) =>
    packRows(
      names.map(name => ({ key: name, width: displayWidth(`{{${name}}}`) })),
      room,
      2,
    ).map((row, index) => (
      <Box key={`${key}-${index}`} gap={2}>
        {row.map(cell => (
          <Text key={`variable-${cell.key}`}>{`{{${cell.key}}}`}</Text>
        ))}
      </Box>
    ))
  const example = timeValues(model.now)
  const formatText: Record<TimeFormat, string> = {
    iso: m.webhookTimeIso(example.iso),
    epoch: m.webhookTimeEpoch(example.epoch),
    epochMs: m.webhookTimeEpochMs(example.epochMs),
    local: m.webhookTimeLocal(example.local),
  }
  const previewLines = 'body' in model.preview ? model.preview.body.split('\n') : []
  const shownLines = previewLines.slice(0, PREVIEW_ROWS)

  const body = (
    <Box key="webhook-body" flexDirection="column" marginTop={1}>
      {Toggle(ui, 'webhook-enabled', draft.enabled, m.webhookSend, { on: m.switchOn, off: m.switchOff }, actions.toggle)}
      <Text key="webhook-when" dimColor wrap="wrap">
        {m.webhookWhen(WEBHOOK_HEARTBEAT_MS / 1000, WEBHOOK_MIN_GAP_MS / 1000)}
      </Text>
      {Toggle(ui, 'webhook-method', draft.method === 'POST', m.webhookMethod, { on: 'POST', off: 'GET' }, actions.toggleMethod)}
      {draft.method === 'GET' && <Text dimColor>{m.webhookGetHint}</Text>}
      <Box key="webhook-url" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookUrl}</Text>
        {Input ? (
          InputFrame(
            ui,
            'webhook-url-field',
            true,
            <Input
              key="webhook-url-input"
              value={draft.url}
              placeholder={m.webhookUrlPlaceholder}
              onInput={value => actions.setUrl(value)}
              onSubmit={value => actions.setUrl(value)}
            />,
          )
        ) : (
          <Text>{draft.url || m.webhookUrlPlaceholder}</Text>
        )}
        {model.urlProblem && Toned(ui, 'webhook-url-problem', model.urlProblem, 'danger')}
      </Box>
      <Box key="webhook-token" flexDirection="column" marginTop={1}>
        <Box key="webhook-token-head" gap={2}>
          <Text>
            <Text dimColor>{`${m.webhookToken} `}</Text>
            <Text>{draft.hasToken && !draft.clearToken ? m.webhookTokenSet : m.webhookTokenNone}</Text>
          </Text>
          {draft.hasToken && !draft.clearToken && IconButton(ui, 'webhook-token-clear', m.webhookTokenClear, theme.danger, actions.clearToken)}
        </Box>
        {Input &&
          InputFrame(
            ui,
            'webhook-token-field',
            false,
            <Input
              key="webhook-token-input"
              value={draft.token}
              placeholder={m.webhookTokenPlaceholder}
              onInput={value => actions.setToken(value)}
              onSubmit={value => actions.setToken(value)}
            />,
          )}
        <Text dimColor wrap="wrap">
          {m.webhookTokenKept}
        </Text>
      </Box>
      <Box key="webhook-template" flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>{`${m.webhookTemplateFile} `}</Text>
          {Toned(ui, 'webhook-template-path', model.templatePath, 'accent')}
        </Text>
        <Text dimColor wrap="wrap">
          {m.webhookTemplateHint}
        </Text>
      </Box>
      <Box key="webhook-variables" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookVariables}</Text>
        {nameRows('webhook-variables', PLAIN_VARIABLES)}
      </Box>
      <Box key="webhook-times" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookTimes}</Text>
        {TIME_FORMATS.map(format => (
          <Box key={`webhook-time-${format}`} flexDirection="column">
            {nameRows(`webhook-time-${format}`, TIME_VARIABLES[format])}
            <Box key={`webhook-time-${format}-about`} marginLeft={2}>
              <Text dimColor wrap="wrap">
                {formatText[format]}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Box key="webhook-preview" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookPreview}</Text>
        {'problem' in model.preview ? (
          Toned(ui, 'webhook-preview-problem', model.preview.problem, 'danger', { wrap: 'wrap' })
        ) : (
          <Box key="webhook-preview-lines" flexDirection="column">
            {shownLines.map((line, index) => (
              <Text key={`preview-${index}`} dimColor>
                {truncate(line, room)}
              </Text>
            ))}
            {previewLines.length > shownLines.length && <Text dimColor>{m.webhookMoreLines(previewLines.length - shownLines.length)}</Text>}
          </Box>
        )}
      </Box>
      {Toned(ui, 'webhook-last', model.lastSend?.text ?? m.webhookNeverSent, model.lastSend ? (model.lastSend.ok ? 'ok' : 'danger') : undefined, { isDim: !model.lastSend })}
      {model.lastSend?.reply != null && Toned(ui, 'webhook-reply', truncate(m.webhookReply(model.lastSend.reply), room), undefined, { isDim: true })}
    </Box>
  )

  return DialogFrame(
    ui,
    dialogHeader(model.header, actions.cancel),
    theme.accent,
    m.webhookTitle,
    body,
    Tiles(
      ui,
      room,
      [
        { key: 'dialog-confirm', label: m.saveButton, isMain: true, onPress: actions.save },
        { key: 'webhook-test', label: m.webhookTest, onPress: actions.test },
        { key: 'dialog-cancel', label: m.cancel, isDismiss: true, onPress: actions.cancel },
      ],
      { focused: model.focused },
    ),
  )
}
