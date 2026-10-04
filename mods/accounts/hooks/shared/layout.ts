// Copied from shared/ by scripts/sync.mjs; edit shared/ and run the script.
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

/** Terminal cells a string takes: East Asian wide and fullwidth characters take two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += isWide ? 2 : 1
  }

  return width
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
  for (const char of text) {
    if (displayWidth(out + char) > width - 1) break
    out += char
  }

  return `${out}…`
}

/** `text` padded with spaces to `width` terminal cells, on the start or the end side. */
export function padCells(text: string, width: number, side: 'start' | 'end' = 'end'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)))

  return side === 'start' ? fill + text : text + fill
}
