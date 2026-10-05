import type { ElementTable, RenderElement } from 'claude-code'

import type { AccountView, BandSpan, BandTarget, LimitView, StatusInfo, UsageView } from '../../types'
import { bar, barParts, displayWidth, packRows, resetClock, severityColor } from '../format'
import type { Locale } from '../i18n'
import { ansiHex, contextLabelColor, contextScaled, modelPill, pillWidth, placePill, reviewMark } from '../statusline'
import type { PillSegment } from '../statusline'
import { STALE_MARK } from './accounts'
import { Rule } from '../shared/kit'

// ui-check: raw-colours - the band redraws the status line's own ANSI colours, which are data here, not theme.

/** Cells a band gauge spans: narrower than the pane's, so the band keeps to one line longer. */
const BAR_WIDTH = 6
/** The xterm-256 ground behind the context gauge. */
const CONTEXT_GROUND = 236
/** The xterm-256 ground behind the lines changed. */
const LINES_GROUND = 236
/** The xterm-256 ground behind the toolbox cell, by what its tools are doing: idle, running, waiting, failed. */
const TOOLBOX_GROUND = { idle: 60, running: 28, waiting: 136, failed: 124 } as const
/**
 * The toolbox's band cell: its name, then what runs, waits or failed unseen,
 * and the state its ground is coloured by, the most pressing first.
 */
export function toolboxCell(counts: { running: number; waiting: number; failed: number }): { label: string; state: 'idle' | 'running' | 'waiting' | 'failed' } {
  const parts = [
    counts.running > 0 ? `${counts.running} running` : '',
    counts.waiting > 0 ? `${counts.waiting} waiting` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
  ].filter(Boolean)
  const state = counts.failed > 0 ? 'failed' : counts.running > 0 ? 'running' : counts.waiting > 0 ? 'waiting' : 'idle'

  // The cell is English in every language, as the band names the tool by its product name.
  return { label: ['⚒ Toolbox', ...parts].join(' · '), state }
}

/** Cells between two cells of the band's status line. */
const STATUS_GAP = 1

/** A span's look as Text props, so a face and a Button's hover draw it alike. */
export function look(span: BandSpan) {
  return {
    ...(span.color ? { color: span.color } : {}),
    ...(span.backgroundColor ? { backgroundColor: span.backgroundColor } : {}),
    ...(span.bold ? { bold: true as const } : {}),
    ...(span.dimColor ? { dimColor: true as const } : {}),
  }
}

/** A span's Button hover: the span's own look, never the inversion a Button takes under the pointer. */
export function pressedLook(span: BandSpan) {
  return { inverse: false, ...look(span) }
}

export type BandModel = {
  status: StatusInfo | null
  account: AccountView | undefined
  reading: UsageView | undefined
  windows: LimitView[]
  contextUsed: number | null
  now: number
  locale: Locale
  /** Cells the band may fill across. */
  room: number
  /** The toolbox cell: its label, and what its tools are doing, which colours its ground. */
  toolbox: { label: string; state: keyof typeof TOOLBOX_GROUND }
  /** Toggles what a cell's label opens: the accounts pane, or the workspace. */
  onPress: (target: BandTarget) => void
}

/**
 * The status on the band above the prompt, on one line that wraps only where
 * the band runs out of room: model and effort, the task, the live account,
 * the context gauge, the usage windows, the place and the lines changed.
 */
export function StatusBand(ui: ElementTable, model: BandModel) {
  const { Box, Button, Text } = ui
  const { status, account, reading, windows, contextUsed, now, locale, room, onPress } = model
  /** Spans drawn in their own colours. */
  const drawSpans = (key: string, spans: BandSpan[]): RenderElement => (
    <Text key={key}>
      {spans.map((span, index) => (
        <Text key={`${key}-${index}`} {...look(span)}>
          {span.text}
        </Text>
      ))}
    </Text>
  )
  /**
   * A cell that toggles `target` when pressed, drawn from spans in their own
   * colours. Only a Button press counts as the person asking, which places a
   * pane at any width, and a Button takes no colour at rest; so over the face
   * lies a row of Buttons, one per span, hidden until the pointer is on the
   * cell. Each Button's hover is its span's look and never inverts, so the
   * revealed row draws exactly as the face does, and takes the press.
   */
  const pressCell = (key: string, target: BandTarget, spans: BandSpan[]): RenderElement => (
    <Box key={key}>
      {drawSpans(`${key}-face`, spans)}
      {/* Unkeyed, so the hover that reveals it is the cell's. */}
      <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
        {spans
          .filter(span => span.text !== '')
          .map((span, index) => (
            <Button
              key={index === 0 ? `band-${key}` : `band-${key}-${index}`}
              label={span.text}
              plain
              hover={pressedLook(span)}
              onPress={() => onPress(target)}
            />
          ))}
      </Box>
    </Box>
  )
  /** A pill as spans: a half block, each segment on its ground, the half block after it. */
  const pillSpans = (segments: PillSegment[]): BandSpan[] => [
    { text: '▐', color: ansiHex(segments[0]?.bg ?? 0) },
    ...segments.flatMap((segment, index) => {
      const after = segments[index + 1]

      return [
        { text: segment.text, color: ansiHex(segment.fg), backgroundColor: ansiHex(segment.bg), ...(segment.bold ? { bold: true } : {}) },
        { text: '▌', color: ansiHex(segment.bg), ...(after ? { backgroundColor: ansiHex(after.bg) } : {}) },
      ]
    }),
  ]

  const drawPill = (key: string, segments: PillSegment[]) => (
    <Text key={key}>
      <Text color={ansiHex(segments[0]?.bg ?? 0)}>▐</Text>
      {segments.map((segment, index) => {
        const after = segments[index + 1]

        return (
          <Text key={`${key}-${index}`}>
            <Text backgroundColor={ansiHex(segment.bg)} color={ansiHex(segment.fg)} bold={segment.bold === true}>
              {segment.letters
                ? segment.letters.map((letter, at) => (
                    <Text key={`${key}-${index}-${at}`} color={ansiHex(letter.fg)}>
                      {letter.char}
                    </Text>
                  ))
                : segment.text}
            </Text>
            {after ? (
              <Text color={ansiHex(segment.bg)} backgroundColor={ansiHex(after.bg)}>
                ▌
              </Text>
            ) : (
              <Text color={ansiHex(segment.bg)}>▌</Text>
            )}
          </Text>
        )
      })}
    </Text>
  )

  type Cell = { key: string; width: number; draw: () => RenderElement }
  /** A filled cell: its spans on one ground, rounded off by half blocks. */
  const onGround = (ground: string, spans: BandSpan[]): BandSpan[] => [
    { text: '▐', color: ground },
    ...spans.map(span => ({ ...span, backgroundColor: ground })),
    { text: '▌', color: ground },
  ]
  const first: Cell[] = []
  // The context gauge is built here and placed beside the usage windows below.
  if (contextUsed !== null) {
    // The usage bars' gauge, coloured by the context thresholds, on a ground of its own.
    const scaled = contextScaled(contextUsed)
    const { filled: gauge, rest } = barParts(scaled, BAR_WIDTH)
    const label = scaled >= 95 ? `✖ ${scaled}%` : `${scaled}%`
    const ground = ansiHex(CONTEXT_GROUND)
    const ink = ansiHex(contextLabelColor(scaled))
    first.push({
      key: 'context',
      width: displayWidth(`ctx ${bar(scaled, BAR_WIDTH)} ${label}`) + 2,
      draw: () =>
        drawSpans(
          'context',
          onGround(ground, [
            { text: 'ctx ', color: ansiHex(250) },
            { text: gauge, color: ink },
            { text: rest, color: ansiHex(240) },
            { text: ` ${label}`, color: ink, bold: true },
          ]),
        ),
    })
  }
  // The account leads the band; the model and effort follow it.
  if (account) {
    const name = `${account.email}${reading?.isStale ? ` ${STALE_MARK}` : ''}`
    first.push({
      key: 'account',
      width: displayWidth(name),
      draw: () =>
        pressCell(
          'account',
          'accounts',
          [{ text: account.email, color: ansiHex(110), bold: true }, ...(reading?.isStale ? [{ text: ` ${STALE_MARK}`, color: 'yellow', dimColor: true }] : [])],
        ),
    })
  }
  if (status) {
    const model = modelPill(status)
    first.push({ key: 'model', width: pillWidth(model, displayWidth), draw: () => drawPill('model', model) })
    if (status.task) {
      const task = `‣ ${status.task}`
      first.push({
        key: 'task',
        width: displayWidth(task),
        draw: () => (
          <Text key="task" color={ansiHex(229)} bold>
            {task}
          </Text>
        ),
      })
    }
  }

  const second: Cell[] = []
  for (const limit of windows) {
    const reset = resetClock(limit.resetsAt, now, locale)
    const text = `${limit.label} ${bar(limit.percent, BAR_WIDTH)} ${Math.round(limit.percent)}%${reset ? ` ↻ ${reset}` : ''}`
    const { filled, rest } = barParts(limit.percent, BAR_WIDTH)
    second.push({
      key: limit.label,
      width: displayWidth(text),
      draw: () =>
        drawSpans(`usage-${limit.label}`, [
          { text: `${limit.label} `, dimColor: true },
          { text: filled, color: severityColor(limit.percent) },
          { text: rest, color: 'gray', dimColor: true },
          { text: ` ${Math.round(limit.percent)}%` },
          ...(reset ? [{ text: ` ↻ ${reset}`, dimColor: true }] : []),
        ]),
    })
  }
  // The place comes last, right before the lines changed.
  if (status) {
    const place = placePill(status)
    const pr = status.pr
    const mark = pr ? reviewMark(pr.reviewState) : undefined
    const prText = pr ? ` #${pr.number}${mark ? mark.text : ''}` : ''
    second.push({
      key: 'place',
      width: pillWidth(place, displayWidth) + displayWidth(prText),
      // The place opens the workspace too, as the lines changed do.
      draw: () =>
        pressCell('place', 'workspace', [
          ...pillSpans(place),
          ...(pr ? [{ text: ` #${pr.number}`, color: ansiHex(75), bold: true }] : []),
          ...(mark ? [{ text: mark.text, color: ansiHex(mark.fg) }] : []),
        ]),
    })
  }
  if (status && (status.linesAdded > 0 || status.linesRemoved > 0)) {
    const added = `+${status.linesAdded}`
    const removed = `-${status.linesRemoved}`
    // One filled block, so the counts read as one thing.
    second.push({
      key: 'lines',
      width: displayWidth(`${added} ${removed}`) + 2,
      draw: () =>
        pressCell(
          'lines',
          'workspace',
          onGround(ansiHex(LINES_GROUND), [
            { text: added, color: ansiHex(42), bold: true },
            { text: ' ' },
            { text: removed, color: ansiHex(203), bold: true },
          ]),
        ),
    })
  }

  // The toolbox's cell ends the second row: pressed, the toolbox shows its tools as tiles.
  second.push({
    key: 'toolbox',
    width: displayWidth(model.toolbox.label) + 2,
    draw: () => pressCell('toolbox', 'toolbox', onGround(ansiHex(TOOLBOX_GROUND[model.toolbox.state]), [{ text: model.toolbox.label, color: ansiHex(230), bold: true }])),
  })

  // One line while it fits; a new row only where the band runs out of room.
  // The context sits right before the five-hour window, beside the other gauges.
  const context = first.filter(cell => cell.key === 'context')
  const firstUsage = second.findIndex(cell => cell.key === '5h' || cell.key === 'wk')
  const cells = [
    ...first.filter(cell => cell.key !== 'context'),
    ...(firstUsage < 0 ? [...second, ...context] : [...second.slice(0, firstUsage), ...context, ...second.slice(firstUsage)]),
  ]
  const rows = packRows(cells, room, STATUS_GAP).map((row, index) => (
    <Box key={`status-row-${index}`} gap={STATUS_GAP}>
      {row.map(cell => cell.draw())}
    </Box>
  ))

  // A dim rule above sets the band off from the transcript, as the prompt's border does below it.
  return (
    <Box flexDirection="column">
      {Rule(ui, 'band-rule', room)}
      {rows}
    </Box>
  )
}
