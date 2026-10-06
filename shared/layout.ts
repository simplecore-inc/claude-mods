/** Terminal layout: gauges and their colours, cell widths, and packing cells into rows. */

/** A thin bar of `width` cells, in its filled and remaining parts, so each takes its own color. */
export function barParts(percent: number, width = 8): { filled: string; rest: string } {
  const cells = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return { filled: '━'.repeat(cells), rest: '━'.repeat(width - cells) }
}

/** The bar as one string: what its cells measure. */
export function bar(percent: number, width = 8): string {
  const { filled, rest } = barParts(percent, width)

  return filled + rest
}

export function severityColor(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'yellow'

  return 'green'
}

/**
 * Characters a terminal draws over the cell before them: combining marks,
 * Hangul's vowel and final jamo (a decomposed syllable is one wide cell),
 * zero-width spaces and joiners, and variation selectors.
 */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1160 && code <= 0x11ff) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0xfeff ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}

/** East Asian wide and fullwidth characters, and emoji drawn as pictures: two cells. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Terminal cells a string takes: wide characters take two, combining ones none. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1
  }

  return width
}

/**
 * The escape sequences a program writes for a terminal, each removed whole:
 * CSI (`ESC [`, or its one-byte form) with its parameters and final byte; OSC,
 * DCS, SOS, PM and APC strings up to their terminator; and the short escapes,
 * such as `ESC ( B` from `tput sgr0` and `ESC 7` saving the cursor.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|\u001b[ -/]*[0-~]/g
/** Every control character but tab and newline: C0, DEL and C1. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Text from outside the plugin (a file, a prompt, a model's answer, a
 * program's output) as it may be drawn: its escape sequences and control
 * characters removed, tab and newline kept. The engine refuses a whole tree
 * whose text, label, input value or code holds one, and draws the pane blank.
 */
export function printable(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL, '')
}

/**
 * Splits items into rows no wider than `room`, `gap` cells apart, in order;
 * an item wider than `room` gets a row to itself.
 */
export function packRows<T extends { width: number }>(items: T[], room: number, gap: number): T[][] {
  const rows: T[][] = []
  let used = 0
  for (const item of items) {
    const row = rows[rows.length - 1]
    if (row && used + gap + item.width <= room) {
      row.push(item)
      used += gap + item.width
    } else {
      rows.push([item])
      used = item.width
    }
  }

  return rows
}

/**
 * `text` cut to `width` terminal cells, an ellipsis marking the cut. Counts
 * East Asian wide characters as two cells, so a Korean label never overflows
 * the room it was given.
 */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  if (width <= 1) return width === 1 ? '…' : ''
  let out = ''
  let used = 0
  for (const char of text) {
    const cells = displayWidth(char)
    if (used + cells > width - 1) break
    out += char
    used += cells
  }

  return `${out}…`
}

/** `text` padded with spaces to `width` terminal cells, on the start or the end side. */
export function padCells(text: string, width: number, side: 'start' | 'end' = 'end'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)))

  return side === 'start' ? fill + text : text + fill
}
