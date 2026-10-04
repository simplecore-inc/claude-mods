import type { ElementTable } from 'claude-code'

import { barParts, displayWidth, severityColor } from './layout'

/**
 * The pieces every tab of the pane is built from, so the tabs look like one
 * screen: one header, one tab bar, one card, one gauge, one button language.
 * Each takes the surface's element table (`$.ui.resolve(e)`), never `$`.
 */

export const theme = {
  accent: 'cyan',
  danger: 'red',
  warn: 'yellow',
  ok: 'green',
  track: 'gray',
  /** The footer tiles' fill, the main tile's, and either under the pointer. */
  tile: '#2a2f38',
  tileMain: '#1f4650',
  tileHover: '#3a4250',
  /** The selected tab's fill. */
  tabActive: '#2f3a46',
  stale: 'yellow',
  /** An on/off switch's segments: on when current, off when current, and the one not current. */
  switchOn: '#1f7a3a',
  switchOffActive: '#5a606b',
  switchOff: '#2a2f38',
}

/** Cells a gauge spans. */
export const GAUGE_WIDTH = 8
/** Cells between two cells of a row of gauges. */
export const CELL_GAP = 3
/** Cells a card's border and horizontal padding take across. */
export const CARD_CHROME = 4
/** Cells between two footer tiles. */
const TILE_GAP = 1

export type Tile = { key: string; label: string; isMain?: boolean; isDismiss?: boolean; isFocused?: boolean; onPress: () => void }
export type TabSpec = { key: string; label: string; badge?: string; hotkey: string }

export function Header(ui: ElementTable, brand: string, release: string | undefined) {
  const { Box, Text } = ui

  return (
    <Box key="header" justifyContent="space-between">
      <Text bold>{brand}</Text>
      {release && <Text dimColor>{release}</Text>}
    </Box>
  )
}

/** The tab bar: the selected tab filled, the others dim; a digit presses each. */
export function TabBar(ui: ElementTable, tabs: TabSpec[], active: string, onSelect: (key: string) => void) {
  const { Box, Button, Text } = ui

  return (
    <Box key="tabs" gap={1} marginTop={1}>
      {tabs.map(tab => {
        const isActive = tab.key === active

        return (
          <Box
            key={`tab-${tab.key}`}
            paddingX={1}
            backgroundColor={isActive ? theme.tabActive : undefined}
            hover={{ backgroundColor: theme.tabActive }}
          >
            <Button
              key={`tab-button-${tab.key}`}
              label={tab.label}
              hotkey={tab.hotkey}
              plain
              {...(isActive ? {} : { dimColor: true })}
              onPress={() => onSelect(tab.key)}
            />
            {tab.badge && <Text color={isActive ? theme.accent : undefined} dimColor={!isActive}>{` ${tab.badge}`}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

/** A dim rule across `width` cells, under the tab bar. */
export function Rule(ui: ElementTable, key: string, width: number) {
  const { Text } = ui

  return (
    <Text key={key} dimColor>
      {'─'.repeat(Math.max(1, width))}
    </Text>
  )
}

/** A rounded card; the accented one (the account in use, a running agent) in the accent colour. */
export function Card(ui: ElementTable, key: string, isAccent: boolean, children: unknown) {
  const { Box } = ui

  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle="round"
      borderColor={isAccent ? theme.accent : undefined}
      borderDimColor={!isAccent}
      paddingX={1}
    >
      {children as never}
    </Box>
  )
}

/** A section heading: a title, and a dim detail after it. */
export function Section(ui: ElementTable, key: string, title: string, detail?: string) {
  const { Text } = ui

  return (
    <Text key={key}>
      <Text bold>{title}</Text>
      {detail && <Text dimColor>{`  ${detail}`}</Text>}
    </Text>
  )
}

/** A thin gauge: its label, the used part coloured by severity over a dim track, the percentage. */
export function Gauge(ui: ElementTable, key: string, label: string, percent: number, color = severityColor(percent)) {
  const { Text } = ui
  const { filled, rest } = barParts(percent, GAUGE_WIDTH)

  return (
    <Text key={key}>
      <Text dimColor>{`${label} `}</Text>
      <Text color={color}>{filled}</Text>
      <Text color={theme.track} dimColor>
        {rest}
      </Text>
      <Text>{` ${Math.round(percent)}%`}</Text>
    </Text>
  )
}

/** A glyph button: dim at rest, its tone under the pointer. */
export function IconButton(ui: ElementTable, key: string, glyph: string, tone: string, onPress: () => void) {
  const { Button } = ui

  return <Button key={key} label={glyph} plain dimColor hover={{ color: tone, bold: true }} onPress={onPress} />
}

/**
 * A destructive glyph button in two presses: the first arms it and shows
 * `glyph?` at full strength, the second runs it.
 */
export function ConfirmButton(
  ui: ElementTable,
  key: string,
  glyph: string,
  isArmed: boolean,
  onArm: () => void,
  onConfirm: () => void,
) {
  const { Button } = ui
  if (isArmed) {
    return <Button key={`${key}-confirm`} label={`${glyph}?`} plain hover={{ color: theme.danger, bold: true }} onPress={onConfirm} />
  }

  return IconButton(ui, key, glyph, theme.danger, onArm)
}

/** A filled badge such as `active`. */
export function Badge(ui: ElementTable, key: string, text: string, background = theme.accent) {
  const { Text } = ui

  return (
    <Text key={key} color="black" backgroundColor={background}>
      {` ${text} `}
    </Text>
  )
}

/** What a tab shows with nothing in it. */
export function Empty(ui: ElementTable, key: string, lines: string[]) {
  const { Box, Text } = ui

  return (
    <Box key={key} flexDirection="column" paddingX={2} paddingY={1}>
      {lines.map((line, index) => (
        <Text key={`${key}-${index}`} dimColor={index > 0}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** Cells a tile keeps on each side of its label. */
const TILE_PADDING = 2

/**
 * The footer: equal filled tiles across the pane, one row tall, each label
 * centred on one line. Tiles that would squeeze a label onto two lines move
 * to a further row instead. The main action's tile carries the accent's tint.
 */
export function Tiles(ui: ElementTable, bodyColumns: number, tiles: Tile[], outline?: { focused: string | null }) {
  const { Box, Button } = ui
  const needed = Math.max(...tiles.map(tile => displayWidth(tile.label))) + TILE_PADDING * 2
  const perRow = Math.max(1, Math.min(tiles.length, Math.floor((bodyColumns + TILE_GAP) / (needed + TILE_GAP))))
  const width = Math.max(needed, Math.floor((bodyColumns - TILE_GAP * (perRow - 1)) / perRow))
  const rows: Tile[][] = []
  for (let start = 0; start < tiles.length; start += perRow) rows.push(tiles.slice(start, start + perRow))

  return (
    <Box key="footer" flexDirection="column" marginTop={1} rowGap={1}>
      {rows.map((row, index) => (
        <Box key={`footer-row-${index}`} gap={TILE_GAP}>
          {row.map(tile => (
            <Box
              key={`tile-${tile.key}`}
              width={width}
              justifyContent="center"
              alignItems="center"
              backgroundColor={tile.isMain ? theme.tileMain : theme.tile}
              hover={{ backgroundColor: theme.tileHover }}
              // Outlined tiles show where the keyboard is: the focused one in the accent colour.
              {...(outline
                ? outline.focused === tile.key
                  ? { borderStyle: 'round', borderColor: theme.accent }
                  : { borderStyle: 'round', borderColor: 'gray', borderDimColor: true }
                : {})}
            >
              <Button
                key={tile.key}
                label={tile.label}
                plain
                {...(tile.isDismiss ? { role: 'dismiss' as const } : {})}
                {...(tile.isFocused ? { autoFocus: true as const } : {})}
                onPress={tile.onPress}
              />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** One line of a dialog: its text, and a tone for the line that matters most. */
export type DialogLine = { text: string; tone?: 'danger' | 'ok' | 'muted' }

/**
 * A confirmation dialog, drawn in a pane opened with `focus`, `closeOnEscape`
 * and `holdToasts`: the pane's usual header, then a bordered box holding the
 * title, the facts the choice rests on, and the two tiles, the confirming one
 * focused so Enter answers. The border takes the warning colour: what the
 * dialog confirms is hard to take back.
 */
export function Dialog(
  ui: ElementTable,
  bodyColumns: number,
  header: { brand: string; release: string | undefined },
  title: string,
  lines: DialogLine[],
  confirm: { label: string; onPress: () => void },
  cancel: { label: string; onPress: () => void },
  /** The key of the tile holding the keyboard; the confirming tile until the ring moves. */
  focused: string | null = null,
) {
  const { Box, Text } = ui
  const color = (tone: DialogLine['tone']) => (tone === 'danger' ? theme.danger : tone === 'ok' ? theme.ok : undefined)

  return (
    <Box key="dialog-pane" flexDirection="column">
      {Header(ui, header.brand, header.release)}
      <Box key="dialog" flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
        <Text bold>{title}</Text>
        <Box key="dialog-lines" flexDirection="column" marginTop={1}>
          {lines.map((line, index) => (
            <Text key={`dialog-line-${index}`} color={color(line.tone)} dimColor={line.tone === 'muted'} wrap="wrap">
              {line.text}
            </Text>
          ))}
        </Box>
        {Tiles(
          ui,
          Math.max(20, bodyColumns - CARD_CHROME),
          [
            { key: 'dialog-confirm', label: confirm.label, isMain: true, isFocused: true, onPress: confirm.onPress },
            { key: 'dialog-cancel', label: cancel.label, isDismiss: true, onPress: cancel.onPress },
          ],
          { focused: focused ?? 'dialog-confirm' },
        )}
      </Box>
    </Box>
  )
}

/**
 * An on/off switch drawn as two segments, `[ On | Off ]`: the segment for the
 * current state filled (green for on, grey for off), the other dim. Pressing
 * the other segment switches to it; the setting's name beside it flips it.
 */
export function Toggle(
  ui: ElementTable,
  key: string,
  isOn: boolean,
  label: string,
  states: { on: string; off: string },
  onToggle: () => void,
) {
  const { Box, Button } = ui
  const segment = (side: 'on' | 'off') => {
    const isCurrent = (side === 'on') === isOn

    return (
      <Box
        key={`${key}-${side}-segment`}
        paddingX={1}
        backgroundColor={isCurrent ? (side === 'on' ? theme.switchOn : theme.switchOffActive) : theme.switchOff}
        {...(isCurrent ? {} : { hover: { backgroundColor: theme.tileHover } })}
      >
        <Button
          key={`${key}-${side}`}
          label={states[side]}
          plain
          {...(isCurrent ? {} : { dimColor: true })}
          // The current segment is already the state: pressing it changes nothing.
          onPress={() => {
            if (!isCurrent) onToggle()
          }}
        />
      </Box>
    )
  }

  return (
    <Box key={key} gap={1}>
      <Box key={`${key}-segments`}>
        {segment('on')}
        {segment('off')}
      </Box>
      <Button key={`${key}-label`} label={label} plain hover={{ color: theme.accent, bold: true }} onPress={onToggle} />
    </Box>
  )
}
