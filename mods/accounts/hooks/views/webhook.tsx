import type { ElementTable } from 'claude-code'

import { WEBHOOK_HEARTBEAT_MS, WEBHOOK_MIN_GAP_MS, WEBHOOK_VARIABLES } from '../webhook'
import type { Messages } from '../i18n'
import { CARD_CHROME, DialogFrame, IconButton, theme, Tiles, Toggle } from '../shared/kit'
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
  /** The last send, test or feed, as one line; null before any. */
  lastSend: { text: string; ok: boolean } | null
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
 * with the variables it may use, what it sends now, and the last send.
 */
export function WebhookDialog(ui: ElementTable, model: WebhookModel, actions: WebhookActions) {
  const { Box, Text } = ui
  const Input = model.hasField && 'Input' in ui ? ui.Input : undefined
  const { m, draft } = model
  const room = Math.max(20, model.bodyColumns - CARD_CHROME)
  const variables = packRows(
    WEBHOOK_VARIABLES.map(name => ({ key: name, width: displayWidth(`{{${name}}}`) })),
    room,
    2,
  )
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
          <Box key="webhook-url-field" borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Input
              key="webhook-url-input"
              value={draft.url}
              placeholder={m.webhookUrlPlaceholder}
              onInput={value => actions.setUrl(value)}
              onSubmit={value => actions.setUrl(value)}
            />
          </Box>
        ) : (
          <Text>{draft.url || m.webhookUrlPlaceholder}</Text>
        )}
        {model.urlProblem && <Text color={theme.danger}>{model.urlProblem}</Text>}
      </Box>
      <Box key="webhook-token" flexDirection="column" marginTop={1}>
        <Box key="webhook-token-head" gap={2}>
          <Text>
            <Text dimColor>{`${m.webhookToken} `}</Text>
            <Text>{draft.hasToken && !draft.clearToken ? m.webhookTokenSet : m.webhookTokenNone}</Text>
          </Text>
          {draft.hasToken && !draft.clearToken && IconButton(ui, 'webhook-token-clear', m.webhookTokenClear, theme.danger, actions.clearToken)}
        </Box>
        {Input && (
          <Box key="webhook-token-field" borderStyle="round" borderColor="gray" borderDimColor paddingX={1}>
            <Input
              key="webhook-token-input"
              value={draft.token}
              placeholder={m.webhookTokenPlaceholder}
              onInput={value => actions.setToken(value)}
              onSubmit={value => actions.setToken(value)}
            />
          </Box>
        )}
        <Text dimColor wrap="wrap">
          {m.webhookTokenKept}
        </Text>
      </Box>
      <Box key="webhook-template" flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>{`${m.webhookTemplateFile} `}</Text>
          <Text color={theme.accent}>{model.templatePath}</Text>
        </Text>
        <Text dimColor wrap="wrap">
          {m.webhookTemplateHint}
        </Text>
      </Box>
      <Box key="webhook-variables" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookVariables}</Text>
        {variables.map((row, index) => (
          <Box key={`webhook-variables-${index}`} gap={2}>
            {row.map(cell => (
              <Text key={`variable-${cell.key}`}>{`{{${cell.key}}}`}</Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box key="webhook-preview" flexDirection="column" marginTop={1}>
        <Text dimColor>{m.webhookPreview}</Text>
        {'problem' in model.preview ? (
          <Text color={theme.danger} wrap="wrap">
            {model.preview.problem}
          </Text>
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
      <Text key="webhook-last" color={model.lastSend ? (model.lastSend.ok ? theme.ok : theme.danger) : undefined} dimColor={!model.lastSend}>
        {model.lastSend?.text ?? m.webhookNeverSent}
      </Text>
    </Box>
  )

  return DialogFrame(
    ui,
    model.header,
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
