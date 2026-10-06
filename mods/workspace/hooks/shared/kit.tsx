// Copied from shared/ by scripts/sync.mjs; edit shared/ and run the script.
import type { ElementTable } from 'claude-code'

import { barParts, displayWidth, padCells, severityColor, truncate } from './layout'

/**
 * The pieces every tab of the pane is built from, so the tabs look like one
 * screen: one header, one tab bar, one card, one gauge, one button language.
 * Each takes the surface's element table (`$.ui.resolve(e)`), never `$`.
 */

export const theme = {
  accent: 'cyan',
  danger: 'red',
  warn: 'yellow',
  /** Between warn and danger: a weekly reset two days out. */
  caution: '#ff8c1a',
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
  /** Dark grounds behind glyph buttons, one per meaning, so a button reads at rest. */
  glyphAccent: '#1d5566',
  glyphDanger: '#6b2a31',
  glyphWarn: '#6b5719',
  glyphOk: '#28603a',
}

/** The ground behind a glyph button of each tone; any other tone takes the neutral fill. */
const GLYPH_GROUND: Record<string, string> = {
  [theme.accent]: theme.glyphAccent,
  [theme.danger]: theme.glyphDanger,
  [theme.warn]: theme.glyphWarn,
  [theme.ok]: theme.glyphOk,
}

/** Cells a gauge spans. */
export const GAUGE_WIDTH = 6
/** Cells between two cells of a row of gauges. */
export const CELL_GAP = 3
/** Cells a card's border and horizontal padding take across. */
export const CARD_CHROME = 4
/** Cells between two footer tiles. */
const TILE_GAP = 1

export type Tile = { key: string; label: string; isMain?: boolean; isDismiss?: boolean; isFocused?: boolean; onPress: () => void }
export type TabSpec = { key: string; label: string; badge?: string; hotkey: string }

/** A pane's name in its header: the product's short mark, then the mod's name, as `[SC] Workspace`. */
export function paneTitle(mod: string): string {
  return `[SC] ${mod}`
}

/**
 * What heads a pane: its name, its release, whether the engine draws its tab
 * row right above (another pane is open beside it), which the header keeps a
 * row apart from, and the way out: `exit` closes the pane, and a dialog puts
 * its own Cancel there as `backLabel`. `columns` is the width it has.
 */
export type HeaderInfo = {
  brand: string
  release: string | undefined
  isUnderTabs: boolean
  columns?: number
  exit?: { label: string; onPress: () => void }
  backLabel?: string
}

/**
 * A pane's first row: its name at the left and the way out at the right, a
 * filled button that is the first thing scrolled into view however short the
 * terminal is. The release sits before it while the row has room for it.
 */
export function Header(ui: ElementTable, header: HeaderInfo) {
  const { Box, Button, Text } = ui
  const { brand, release, exit } = header
  const exitWidth = exit ? displayWidth(exit.label) + 2 : 0
  const room = (header.columns ?? 80) - displayWidth(brand) - exitWidth - 2
  const isReleaseShown = release !== undefined && displayWidth(release) <= room

  return (
    <Box key="header" justifyContent="space-between" marginTop={header.isUnderTabs ? 1 : 0}>
      <Text bold wrap="truncate-end">
        {brand}
      </Text>
      <Box gap={2} flexShrink={0}>
        {isReleaseShown && <Text dimColor>{release}</Text>}
        {exit && (
          <Box key="header-exit-ground" paddingX={1} flexShrink={0} backgroundColor={theme.tile} hover={{ backgroundColor: theme.tileHover }}>
            <Button key="close" label={exit.label} plain role="dismiss" onPress={exit.onPress} />
          </Box>
        )}
      </Box>
    </Box>
  )
}

/** The header a dialog draws: the pane's, its way out being the dialog's own Cancel. */
export function dialogHeader(header: HeaderInfo, cancel: () => void): HeaderInfo {
  return { ...header, exit: { label: header.backLabel ?? '←', onPress: cancel } }
}

/** The tab bar: the selected tab filled, the others dim; a digit presses each. */
export function TabBar(ui: ElementTable, tabs: TabSpec[], active: string, onSelect: (key: string) => void) {
  const { Box, Button, Text } = ui

  return (
    // A tab never wraps inside: on a narrow pane the next tab moves to a new row.
    // Right under the header: on a short terminal every row the chrome keeps is a row of the tab's body.
    <Box key="tabs" columnGap={1} flexWrap="wrap">
      {tabs.map(tab => {
        const isActive = tab.key === active

        return (
          <Box
            key={`tab-${tab.key}`}
            paddingX={1}
            flexShrink={0}
            backgroundColor={isActive ? theme.tabActive : theme.switchOff}
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

/** What a piece of text means, which sets its colour. */
export type Tone = 'accent' | 'ok' | 'danger' | 'warn' | 'caution' | 'stale'

/**
 * Text in the colour of what it means: current or selected `accent`, added or
 * done `ok`, removed or failed `danger`, changed or waiting `warn`, an old
 * reading `stale`; no tone for plain text. Drawn inside another Text or alone.
 */
export function Toned(
  ui: ElementTable,
  key: string,
  text: string,
  tone?: Tone,
  style: { isDim?: boolean; isBold?: boolean; wrap?: 'wrap' | 'truncate-end' } = {},
) {
  const { Text } = ui

  return (
    <Text key={key} color={tone ? theme[tone] : undefined} dimColor={style.isDim === true} bold={style.isBold === true} {...(style.wrap ? { wrap: style.wrap } : {})}>
      {text}
    </Text>
  )
}

/**
 * Lines added and removed, `+12 −3`, in green and red. With widths, each
 * figure is padded at the start to its column, so rows line up.
 */
export function ChangeCounts(ui: ElementTable, key: string, added: number, removed: number, widths: { added: number; removed: number } = { added: 0, removed: 0 }) {
  const { Text } = ui

  return (
    <Text key={key}>
      {Toned(ui, `${key}-added`, `+${added}`.padStart(widths.added), 'ok')}
      <Text> </Text>
      {Toned(ui, `${key}-removed`, `−${removed}`.padStart(widths.removed), 'danger')}
    </Text>
  )
}

/** A bar of `width` cells: added cells green, removed cells red, the rest a dim dotted track. */
export function ChangeBar(ui: ElementTable, key: string, cells: { added: number; removed: number }, width: number) {
  const { Text } = ui

  return (
    <Text key={key}>
      {Toned(ui, `${key}-added`, '■'.repeat(cells.added), 'ok')}
      {Toned(ui, `${key}-removed`, '■'.repeat(cells.removed), 'danger')}
      {Toned(ui, `${key}-rest`, '·'.repeat(Math.max(0, width - cells.added - cells.removed)), undefined, { isDim: true })}
    </Text>
  )
}

/**
 * The frame around a text input: round, in the accent colour where it is
 * the place to type, dim otherwise; an optional glyph before the input. It
 * takes the whole width it is given, in a row or a column alike.
 */
export function InputFrame(ui: ElementTable, key: string, isAccent: boolean, input: unknown, glyph?: string) {
  const { Box, Text } = ui

  return (
    <Box
      key={key}
      borderStyle="round"
      borderColor={isAccent ? theme.accent : 'gray'}
      borderDimColor={!isAccent}
      paddingX={1}
      gap={1}
      flexGrow={1}
    >
      {glyph && <Text color={isAccent ? theme.accent : undefined}>{glyph}</Text>}
      {input as never}
    </Box>
  )
}

/** A word that is pressed: plain at rest, accent and bold under the pointer. */
export function LinkButton(ui: ElementTable, key: string, label: string, onPress: () => void, extra: { autoFocus?: boolean } = {}) {
  const { Button } = ui

  return <Button key={key} label={label} plain hover={{ color: theme.accent, bold: true }} {...(extra.autoFocus ? { autoFocus: true as const } : {})} onPress={onPress} />
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

/** The tone of a weekly window's label and reset as its reset nears: yellow three days out, orange two, red on the day. */
export function countdownTone(day: 1 | 2 | 3 | undefined): Tone | undefined {
  return day === 1 ? 'danger' : day === 2 ? 'caution' : day === 3 ? 'warn' : undefined
}

/** A thin gauge: its label (dim, or bold in `labelTone`), the used part coloured by severity over a dim track, the percentage. */
export function Gauge(ui: ElementTable, key: string, label: string, percent: number, color = severityColor(percent), labelTone?: Tone) {
  const { Text } = ui
  const { filled, rest } = barParts(percent, GAUGE_WIDTH)

  return (
    <Text key={key}>
      {labelTone ? <Text color={theme[labelTone]} bold>{`${label} `}</Text> : <Text dimColor>{`${label} `}</Text>}
      <Text color={color}>{filled}</Text>
      <Text color={theme.track} dimColor>
        {rest}
      </Text>
      <Text>{` ${Math.round(percent)}%`}</Text>
    </Text>
  )
}

/**
 * A glyph button: the glyph at full strength on a dark ground of its tone's
 * colour (red to delete or stop, yellow to restore or pin, cyan to compare or
 * open, green to finish), so what it does reads at rest; the glyph takes the
 * tone under the pointer. A switch that is off (an unpinned star) sits on the
 * neutral fill. One cell wide, as the glyph alone.
 */
export function IconButton(ui: ElementTable, key: string, glyph: string, tone: string, onPress: () => void, isOff = false) {
  const { Box, Button } = ui
  const ground = isOff ? theme.tile : (GLYPH_GROUND[tone] ?? theme.tile)

  return (
    <Box key={`${key}-ground`} flexShrink={0} backgroundColor={ground} hover={{ backgroundColor: theme.tileHover }}>
      <Button key={key} label={glyph} plain hover={{ color: tone, bold: true }} onPress={onPress} />
    </Box>
  )
}

/**
 * A small filled button for a row's main action: its label on the main
 * tile's tint, one cell of padding each side, lighter under the pointer.
 */
export function TileButton(ui: ElementTable, key: string, label: string, onPress: () => void) {
  const { Box, Button } = ui

  return (
    <Box key={`${key}-tile`} paddingX={1} backgroundColor={theme.tileMain} hover={{ backgroundColor: theme.tileHover }}>
      <Button key={key} label={label} plain onPress={onPress} />
    </Box>
  )
}

/**
 * A value that opens a choice dialog when pressed, drawn as a select: the
 * value and `▾` on the unselected tabs' fill, one cell of padding each side,
 * lighter under the pointer. It never shrinks; the row it sits in gives way.
 */
export function SelectField(ui: ElementTable, key: string, value: string, onPress: () => void) {
  const { Box } = ui

  return (
    <Box key={`${key}-field`} paddingX={1} flexShrink={0} backgroundColor={theme.switchOff} hover={{ backgroundColor: theme.tabActive }}>
      {LinkButton(ui, key, `${value} ▾`, onPress)}
    </Box>
  )
}

/**
 * A dim second line under a row, indented under its text and cut to one
 * line: what a row did last, or a fact that does not fit beside it.
 */
export function SubLine(ui: ElementTable, key: string, text: string) {
  const { Box, Text } = ui

  return (
    <Box key={key} paddingLeft={2}>
      <Text dimColor wrap="truncate-end">
        {`↳ ${text.replace(/\s+/g, ' ').trim()}`}
      </Text>
    </Box>
  )
}

/**
 * Figures in a row: each value bold with its name dim after it, the row
 * wrapping whole figures to the next line where the width runs out.
 */
export function StatRow(ui: ElementTable, key: string, items: { label: string; value: string }[]) {
  const { Box, Text } = ui

  return (
    <Box key={key} columnGap={3} flexWrap="wrap">
      {items.map(item => (
        <Text key={`${key}-${item.label}`}>
          <Text bold>{item.value}</Text>
          <Text dimColor>{` ${item.label}`}</Text>
        </Text>
      ))}
    </Box>
  )
}

/** Eighths of a cell, from empty to full, for the bars of a chart. */
const BAR_EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/**
 * Vertical bars `height` rows tall, one per value, in the accent colour, drawn
 * with eighth blocks so a small value still shows; each bar is as wide as
 * `width` allows (one or two cells, a cell between bars), with its label
 * under it when the bar is two cells wide and on every fifth bar otherwise.
 * The largest value is named above the bars.
 */
export function BarChart(ui: ElementTable, key: string, bars: { label: string; value: number }[], width: number, height: number, largestText: string) {
  const { Box, Text } = ui
  const largest = Math.max(1, ...bars.map(bar => bar.value))
  const barWidth = bars.length * 3 - 1 <= width ? 2 : 1
  const eighths = bars.map(bar => (bar.value > 0 ? Math.max(1, Math.round((bar.value / largest) * height * 8)) : 0))
  const rows = Array.from({ length: height }, (_, index) => height - 1 - index)
  const cell = (filled: number, row: number) => BAR_EIGHTHS[Math.max(0, Math.min(8, filled - row * 8))] ?? ' '

  return (
    <Box key={key} flexDirection="column">
      <Text dimColor>{largestText}</Text>
      {rows.map(row => (
        <Text key={`${key}-row-${row}`} color={theme.accent}>
          {eighths.map(filled => cell(filled, row).repeat(barWidth)).join(' ')}
        </Text>
      ))}
      <Text key={`${key}-labels`} dimColor>
        {barWidth === 2
          ? bars.map(bar => bar.label.slice(-2).padStart(2)).join(' ')
          : // One-cell bars sit two cells apart: a two-character label fits under every fifth.
            bars.reduce((line, bar, index) => (index % 5 === 0 ? padCells(line, index * 2) + bar.label.slice(-2) : line), '')}
      </Text>
    </Box>
  )
}

/**
 * A ranking, one row each: the name, a dim detail after it, and the value at
 * the right edge. The name keeps its whole width up to half the row; the
 * detail takes what is left and is cut first.
 */
export function RankList(ui: ElementTable, key: string, rows: { name: string; detail: string; value: string; onPress?: () => void }[], width: number) {
  const { Box, Text } = ui
  const valueWidth = Math.max(0, ...rows.map(row => displayWidth(row.value)))

  return (
    <Box key={key} flexDirection="column">
      {rows.map((row, index) => {
        const free = Math.max(12, width - valueWidth - 4)
        const room = Math.min(displayWidth(row.name), Math.max(Math.floor(free / 2), free - displayWidth(row.detail)))
        const detail = truncate(row.detail, Math.max(0, free - room))

        // Rows are keyed by place: two rows may share a name (one line found in two files).
        return (
          <Box key={`${key}-${index}`} justifyContent="space-between">
            {/* A row that opens something has its name as the button. */}
            {row.onPress ? (
              <Box gap={2} flexShrink={1}>
                {LinkButton(ui, `${key}-${index}-open`, truncate(row.name, room), row.onPress)}
                <Text dimColor wrap="truncate-end">
                  {detail}
                </Text>
              </Box>
            ) : (
              <Text wrap="truncate-end">
                <Text>{truncate(row.name, room)}</Text>
                <Text dimColor>{detail === '' ? '' : `  ${detail}`}</Text>
              </Text>
            )}
            <Box flexShrink={0} marginLeft={1}>
              <Text bold>{padCells(row.value, valueWidth, 'start')}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * A file's outline under its row: each entry's line number dim in one
 * column, then its text indented by its depth, every entry one line.
 */
export function OutlineList(ui: ElementTable, key: string, entries: { line: number; text: string; level: number }[], width: number) {
  const { Box, Text } = ui
  const numberWidth = Math.max(0, ...entries.map(entry => String(entry.line).length))

  return (
    <Box key={key} flexDirection="column" paddingLeft={2}>
      {entries.map(entry => {
        const indent = '  '.repeat(Math.max(0, entry.level - 1))

        return (
          <Text key={`${key}-${entry.line}`} wrap="truncate-end">
            <Text dimColor>{`${String(entry.line).padStart(numberWidth)}  `}</Text>
            <Text>{truncate(`${indent}${entry.text}`, Math.max(6, width - numberWidth - 4))}</Text>
          </Text>
        )
      })}
    </Box>
  )
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
  if (tiles.length === 0) return null
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

/** A glyph button on a status tile: what it does and the tone of its ground. */
export type TileAction = { key: string; glyph: string; tone: string; onPress: () => void }

/**
 * A tile that says how its thing stands, in two lines: an icon and a title,
 * with glyph buttons at the right of the same line, then a status line; both
 * lines press the tile, across its whole width. `ground` fills the tile with the state's
 * dark colour (`ok` running, `warn` waiting, `danger` failed); `isLit` false
 * drops it to the neutral fill, so a caller alternating it makes the tile blink.
 */
export type StatusTile = {
  key: string
  icon: string
  iconTone?: Tone
  title: string
  status: string
  ground?: 'ok' | 'warn' | 'danger' | 'accent'
  isLit?: boolean
  actions?: TileAction[]
  onPress: () => void
}

const STATUS_GROUND: Record<NonNullable<StatusTile['ground']>, string> = {
  ok: theme.glyphOk,
  warn: theme.glyphWarn,
  danger: theme.glyphDanger,
  accent: theme.glyphAccent,
}

/**
 * Status tiles, `columns` to a row (two by default, one where the pane is
 * too narrow for two of `minWidth` cells), every tile the same width and its
 * text left-aligned and cut to one line each.
 */
export function StatusTiles(ui: ElementTable, bodyColumns: number, tiles: StatusTile[], options: { columns?: number; minWidth?: number } = {}) {
  const { Box, Button } = ui
  const wanted = options.columns ?? 2
  const perRow = Math.max(1, Math.min(wanted, Math.floor((bodyColumns + TILE_GAP) / ((options.minWidth ?? 28) + TILE_GAP))))
  const width = Math.floor((bodyColumns - TILE_GAP * (perRow - 1)) / perRow)
  const rows: StatusTile[][] = []
  for (let start = 0; start < tiles.length; start += perRow) rows.push(tiles.slice(start, start + perRow))

  return (
    <Box key="status-tiles" flexDirection="column" rowGap={1}>
      {rows.map((row, index) => (
        <Box key={`status-row-${index}`} gap={TILE_GAP}>
          {row.map(tile => {
            const buttons = tile.actions ?? []
            // The tile keeps a cell of padding each side; each glyph button is one cell with a cell before it.
            const text = Math.max(4, width - 2)
            const title = Math.max(1, text - displayWidth(tile.icon) - 1 - buttons.length * 2)
            const ground = tile.ground && tile.isLit !== false ? STATUS_GROUND[tile.ground] : theme.tile

            return (
              <Box key={`status-${tile.key}`} width={width} flexShrink={0} paddingX={1} flexDirection="column" backgroundColor={ground} hover={{ backgroundColor: theme.tileHover }}>
                <Box justifyContent="space-between">
                  <Box gap={1} flexShrink={1}>
                    {Toned(ui, `status-icon-${tile.key}`, tile.icon, tile.iconTone, { isBold: true })}
                    <Button key={tile.key} label={padCells(truncate(tile.title.replace(/\s+/g, ' '), title), title)} plain onPress={tile.onPress} />
                  </Box>
                  {buttons.length > 0 && (
                    <Box gap={1} flexShrink={0}>
                      {buttons.map(action => IconButton(ui, action.key, action.glyph, action.tone, action.onPress))}
                    </Box>
                  )}
                </Box>
                <Button key={`${tile.key}-status`} label={padCells(truncate(tile.status, text), text)} plain onPress={tile.onPress} />
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

/** One line of a dialog: its text, and a tone for the line that matters most. */
export type DialogLine = { text: string; tone?: 'danger' | 'ok' | 'muted' }

/**
 * The frame every dialog shares: the pane's usual header, then a round-bordered
 * box holding the title, the body and the tiles.
 */
export function DialogFrame(
  ui: ElementTable,
  header: HeaderInfo,
  borderColor: string,
  title: string,
  body: ReturnType<typeof Header>,
  tiles: ReturnType<typeof Tiles>,
) {
  const { Box, Text } = ui

  return (
    <Box key="dialog-pane" flexDirection="column">
      {Header(ui, header)}
      <Box key="dialog" flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text bold>{title}</Text>
        {body}
        {tiles}
      </Box>
    </Box>
  )
}

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
  header: HeaderInfo,
  title: string,
  lines: DialogLine[],
  confirm: { label: string; onPress: () => void },
  cancel: { label: string; onPress: () => void },
  /** The key of the tile holding the keyboard; the confirming tile until the ring moves. */
  focused: string | null = null,
) {
  const { Box, Text } = ui
  const color = (tone: DialogLine['tone']) => (tone === 'danger' ? theme.danger : tone === 'ok' ? theme.ok : undefined)

  return DialogFrame(
    ui,
    dialogHeader(header, cancel.onPress),
    theme.warn,
    title,
    <Box key="dialog-lines" flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text key={`dialog-line-${index}`} color={color(line.tone)} dimColor={line.tone === 'muted'} wrap="wrap">
          {line.text}
        </Text>
      ))}
    </Box>,
    Tiles(
      ui,
      Math.max(20, bodyColumns - CARD_CHROME),
      [
        { key: 'dialog-confirm', label: confirm.label, isMain: true, isFocused: true, onPress: confirm.onPress },
        { key: 'dialog-cancel', label: cancel.label, isDismiss: true, onPress: cancel.onPress },
      ],
      { focused: focused ?? 'dialog-confirm' },
    ),
  )
}

/**
 * A dialog that asks for a line of text, drawn like the others: the title,
 * the facts the answer is about, a bordered input that holds the keyboard,
 * and Cancel. Enter submits. Where the surface has no input, `noInput` says
 * how else to give the text.
 */
export function InputDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  lines: DialogLine[],
  input: {
    key: string
    placeholder: string
    value?: string
    submitLabel: string
    onSubmit: (value: string) => void
    /** Whether the surface draws a text field: every surface but mobile. */
    hasField: boolean
    noInput: string
  },
  cancel: { label: string; onPress: () => void },
  focused: string | null = null,
) {
  const { Box } = ui
  // The mobile app draws no input: there the dialog says how else to give the text.
  const Input = input.hasField && 'Input' in ui ? ui.Input : undefined

  return DialogFrame(
    ui,
    dialogHeader(header, cancel.onPress),
    theme.accent,
    title,
    <Box key="dialog-input-body" flexDirection="column" marginTop={1}>
      {lines.map((line, index) => Toned(ui, `dialog-line-${index}`, line.text, line.tone === 'danger' ? 'danger' : line.tone === 'ok' ? 'ok' : undefined, { isDim: line.tone === 'muted', wrap: 'wrap' }))}
      <Box key="dialog-input-row" marginTop={1}>
        {Input
          ? InputFrame(
              ui,
              'dialog-input-frame',
              true,
              <Input
                key={input.key}
                placeholder={input.placeholder}
                {...(input.value !== undefined ? { value: input.value } : {})}
                submitLabel={input.submitLabel}
                autoFocus
                onSubmit={input.onSubmit}
              />,
              '✎',
            )
          : Toned(ui, 'dialog-no-input', input.noInput, undefined, { isDim: true, wrap: 'wrap' })}
      </Box>
    </Box>,
    Tiles(ui, Math.max(20, bodyColumns - CARD_CHROME), [{ key: 'dialog-cancel', label: cancel.label, isDismiss: true, onPress: cancel.onPress }], { focused }),
  )
}

/**
 * A dialog that reads a document: its title and a dim line under it, one
 * page of its Markdown drawn as a reply is, and tiles to the previous and
 * next page, with the page's number, and Close. The engine's Markdown takes
 * at most 10,000 characters, so a longer document comes in pages.
 */
export function ReaderDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  subtitle: string,
  markdown: string,
  page: { index: number; count: number; label: string },
  actions: { previous: { label: string; onPress: () => void }; next: { label: string; onPress: () => void }; close: { label: string; onPress: () => void } },
  focused: string | null = null,
) {
  const { Box, Markdown, Text } = ui
  const tiles: Tile[] = [
    ...(page.index > 0 ? [{ key: 'reader-previous', label: actions.previous.label, onPress: actions.previous.onPress }] : []),
    ...(page.index < page.count - 1 ? [{ key: 'reader-next', label: actions.next.label, isMain: true, onPress: actions.next.onPress }] : []),
    { key: 'dialog-cancel', label: actions.close.label, isDismiss: true, onPress: actions.close.onPress },
  ]

  return DialogFrame(
    ui,
    dialogHeader(header, actions.close.onPress),
    theme.accent,
    title,
    <Box key="reader-body" flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {page.count > 1 ? `${subtitle} · ${page.label}` : subtitle}
      </Text>
      <Box key="reader-page" flexDirection="column" marginTop={1}>
        <Markdown key="reader-markdown" text={markdown} />
      </Box>
    </Box>,
    Tiles(ui, Math.max(20, bodyColumns - CARD_CHROME), tiles, { focused }),
  )
}

/** One field of a form dialog: a line of text, with suggestions to pick under it, or a pick from options. */
export type FormField = {
  key: string
  label: string
  value: string
  placeholder?: string
  /** A pick from these instead of typed text (every surface but mobile draws it). */
  options?: { value: string; label: string }[]
  /** Values to pick under the field, such as paths matching what was typed. */
  suggestions?: string[]
  onInput: (value: string) => void
  onPick?: (value: string) => void
}

/**
 * A dialog that asks for several values at once: each field its label dim,
 * then a bordered input or a select, and under a typed field the suggestions
 * to pick; the main tile submits, Cancel dismisses. Enter in any field submits.
 * Where the surface has no field, `noInput` says how else to give the values.
 */
export function FormDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  lines: DialogLine[],
  fields: FormField[],
  actions: { submit: { label: string; onPress: () => void }; cancel: { label: string; onPress: () => void } },
  form: { hasField: boolean; noInput: string },
  focused: string | null = null,
) {
  const { Box, Text } = ui
  const Input = form.hasField && 'Input' in ui ? ui.Input : undefined
  const Select = form.hasField && 'Select' in ui ? ui.Select : undefined

  return DialogFrame(
    ui,
    dialogHeader(header, actions.cancel.onPress),
    theme.accent,
    title,
    <Box key="form-body" flexDirection="column" marginTop={1} gap={1}>
      {lines.map((line, index) => Toned(ui, `form-line-${index}`, line.text, line.tone === 'danger' ? 'danger' : line.tone === 'ok' ? 'ok' : undefined, { isDim: line.tone === 'muted', wrap: 'wrap' }))}
      {!Input && Toned(ui, 'form-no-input', form.noInput, undefined, { isDim: true, wrap: 'wrap' })}
      {Input &&
        fields.map((field, index) => (
          <Box key={`form-field-${field.key}`} flexDirection="column">
            <Text dimColor>{field.label}</Text>
            {field.options && Select ? (
              <Select
                key={`field-${field.key}`}
                options={field.options}
                value={field.value}
                {...(index === 0 ? { autoFocus: true as const } : {})}
                onSelect={value => field.onInput(value)}
              />
            ) : (
              InputFrame(
                ui,
                `form-frame-${field.key}`,
                true,
                <Input
                  key={`field-${field.key}`}
                  value={field.value}
                  {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                  {...(index === 0 ? { autoFocus: true as const } : {})}
                  onInput={value => field.onInput(value)}
                  onSubmit={value => {
                    field.onInput(value)
                    actions.submit.onPress()
                  }}
                />,
              )
            )}
            {(field.suggestions ?? []).length > 0 && (
              <Box key={`form-suggest-${field.key}`} flexDirection="column" paddingLeft={2}>
                {(field.suggestions ?? []).map((suggestion, row) =>
                  LinkButton(ui, `suggest-${field.key}-${row}`, suggestion, () => (field.onPick ?? field.onInput)(suggestion)),
                )}
              </Box>
            )}
          </Box>
        ))}
    </Box>,
    Tiles(
      ui,
      Math.max(20, bodyColumns - CARD_CHROME),
      [
        ...(Input ? [{ key: 'form-submit', label: actions.submit.label, isMain: true, onPress: actions.submit.onPress }] : []),
        { key: 'dialog-cancel', label: actions.cancel.label, isDismiss: true, onPress: actions.cancel.onPress },
      ],
      { focused },
    ),
  )
}

/**
 * A dialog that shows a run's output as it arrives: its state on a line, then
 * the lines in a numbered block, the newest at the bottom while it follows;
 * tiles to page back and forward, to follow or stop following, to stop the
 * run while it runs or run it again once it has ended, and Close.
 */
export function LogDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  status: { text: string; tone?: Tone },
  log: { text: string; firstLine: number; empty: string },
  actions: { older?: Tile; newer?: Tile; follow: Tile; stop?: Tile; again?: Tile; close: Tile },
  focused: string | null = null,
) {
  const { Box, Code } = ui

  return DialogFrame(
    ui,
    dialogHeader(header, actions.close.onPress),
    theme.accent,
    title,
    <Box key="log-body" flexDirection="column" marginTop={1}>
      {Toned(ui, 'log-status', status.text, status.tone)}
      <Box key="log-lines" flexDirection="column" marginTop={1}>
        {log.text === '' ? Toned(ui, 'log-empty', log.empty, undefined, { isDim: true }) : <Code key="log-code" source={log.text} startLine={log.firstLine} wrap="wrap" />}
      </Box>
    </Box>,
    Tiles(
      ui,
      Math.max(20, bodyColumns - CARD_CHROME),
      [actions.older, actions.newer, actions.follow, actions.stop, actions.again, actions.close].filter((tile): tile is Tile => tile !== undefined),
      { focused },
    ),
  )
}

/**
 * A dialog that shows one page of code, a diff or a file: a dim line saying
 * what it is, the page's lines numbered from where the page starts, and tiles
 * to turn pages, then the caller's own (another file, an action on this one),
 * then Close. The page is cut by the caller to a fixed number of lines, so the
 * dialog keeps its height from page to page.
 */
export function CodeDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  subtitle: string,
  code: { source: string; format?: 'diff'; path?: string; empty: string },
  page: { index: number; count: number; label: string },
  actions: { previous: { label: string; onPress: () => void }; next: { label: string; onPress: () => void }; extra?: Tile[]; close: { label: string; onPress: () => void } },
  focused: string | null = null,
) {
  const { Box, Code, Text } = ui
  const tiles: Tile[] = [
    ...(page.index > 0 ? [{ key: 'code-previous', label: actions.previous.label, onPress: actions.previous.onPress }] : []),
    ...(page.index < page.count - 1 ? [{ key: 'code-next', label: actions.next.label, isMain: true, onPress: actions.next.onPress }] : []),
    ...(actions.extra ?? []),
    { key: 'dialog-cancel', label: actions.close.label, isDismiss: true, onPress: actions.close.onPress },
  ]

  return DialogFrame(
    ui,
    dialogHeader(header, actions.close.onPress),
    theme.accent,
    title,
    <Box key="code-body" flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-end">
        {page.count > 1 ? `${subtitle} · ${page.label}` : subtitle}
      </Text>
      <Box key="code-lines" flexDirection="column" marginTop={1}>
        {code.source.trim() === '' ? (
          Toned(ui, 'code-empty', code.empty, undefined, { isDim: true })
        ) : (
          <Code key="code-source" source={code.source} {...(code.format ? { format: code.format } : {})} {...(code.path ? { path: code.path } : {})} />
        )}
      </Box>
    </Box>,
    Tiles(ui, Math.max(20, bodyColumns - CARD_CHROME), tiles, { focused }),
  )
}

/** One choice of a choice dialog: what pressing it picks, and a dim detail beside it. */
export type Choice = { key: string; label: string; detail?: string; isCurrent?: boolean; onPress: () => void }

/**
 * A dialog that asks for one of several choices, drawn like the confirmation
 * dialog: the pane's header, then a bordered box holding the title, one row
 * per choice and Cancel. The current choice is marked `●` and holds the focus
 * first, so Enter keeps it; the labels share one column so the details line up.
 * The border takes the accent colour: choosing changes nothing that cannot be
 * chosen back.
 */
export function ChoiceDialog(
  ui: ElementTable,
  bodyColumns: number,
  header: HeaderInfo,
  title: string,
  choices: Choice[],
  cancel: { label: string; onPress: () => void },
  /** The key of the element holding the keyboard, so the Cancel tile can show it. */
  focused: string | null = null,
) {
  const { Box, Text } = ui
  // Every row is one line: the details share one column at the right, and the labels
  // take what is left of the dialog's width and are cut to it, never wrapped.
  const detailWidth = Math.max(0, ...choices.map(choice => displayWidth(choice.detail ?? '')))
  const labelRoom = Math.max(6, bodyColumns - CARD_CHROME - 2 - (detailWidth > 0 ? detailWidth + 1 : 0))
  const labels = choices.map(choice => truncate(choice.label.replace(/\s+/g, ' ').trim(), labelRoom))
  const labelWidth = Math.max(0, ...labels.map(displayWidth))

  return DialogFrame(
    ui,
    dialogHeader(header, cancel.onPress),
    theme.accent,
    title,
    <Box key="dialog-choices" flexDirection="column" marginTop={1}>
      {choices.map((choice, index) => (
        <Box key={`choice-${choice.key}`} gap={1}>
          <Text color={choice.isCurrent ? theme.accent : undefined} dimColor={!choice.isCurrent}>
            {choice.isCurrent ? '●' : '○'}
          </Text>
          {LinkButton(ui, choice.key, padCells(labels[index] ?? '', labelWidth), choice.onPress, { autoFocus: choice.isCurrent === true })}
          {choice.detail && (
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate-end">
                {choice.detail}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>,
    Tiles(ui, Math.max(20, bodyColumns - CARD_CHROME), [{ key: 'dialog-cancel', label: cancel.label, isDismiss: true, onPress: cancel.onPress }], {
      focused,
    }),
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
