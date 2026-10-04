import type { StatusInfo } from '../types'

/** One block of a pill: its text, its ground and its ink, as xterm-256 colours. */
export type PillSegment = { text: string; bg: number; fg: number; bold?: boolean; letters?: { char: string; fg: number }[] }

/** The xterm-256 colour `index` as `#rrggbb`, so any surface draws the same colour. */
export function ansiHex(index: number): string {
  const hex = (value: number) => value.toString(16).padStart(2, '0')
  if (index < 16) {
    const base = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ][index] ?? [0, 0, 0]

    return `#${base.map(hex).join('')}`
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10

    return `#${hex(level)}${hex(level)}${hex(level)}`
  }
  const cube = index - 16
  const step = (value: number) => (value === 0 ? 0 : 55 + value * 40)

  return `#${hex(step(Math.floor(cube / 36)))}${hex(step(Math.floor(cube / 6) % 6))}${hex(step(cube % 6))}`
}

/** `Opus 5.5 (1M context)` → `Opus5.5(1M)`. */
export function shortModel(name: string): string {
  return name.replace(/\s*\((\S+) context\)/i, '($1)').replace(/ (?=\d)/g, '')
}

/** Context used, rescaled so the 80% auto-compact point reads as 100%. */
export function contextScaled(used: number): number {
  return Math.min(100, Math.round((Math.max(0, Math.min(100, used)) / 80) * 100))
}

export function contextLabelColor(scaled: number): number {
  if (scaled < 63) return 46
  if (scaled < 81) return 226
  if (scaled < 95) return 208

  return 196
}

const EFFORT_STYLES: Record<string, { bg: number; fg: number; bold: boolean; mark: string }> = {
  low: { bg: 240, fg: 252, bold: false, mark: '○' },
  medium: { bg: 25, fg: 231, bold: false, mark: '◐' },
  high: { bg: 29, fg: 231, bold: true, mark: '●' },
  xhigh: { bg: 166, fg: 231, bold: true, mark: '◆' },
  max: { bg: 160, fg: 231, bold: true, mark: '★' },
}

const ULTRA_RAMP = [201, 207, 213, 219, 183, 147, 111, 81, 51]

/** The model pill: the model, then ULTRACODE or the effort level, then fast mode. */
export function modelPill(status: StatusInfo): PillSegment[] {
  const segments: PillSegment[] = [{ text: shortModel(status.model), bg: 60, fg: 231, bold: true }]
  if (status.ultracode) {
    segments.push({
      text: '★ ULTRACODE ★',
      bg: 53,
      fg: 226,
      bold: true,
      letters: [...'★ ULTRACODE ★'].map((char, index) => ({
        char,
        fg: index < 2 || index > 10 ? 226 : (ULTRA_RAMP[index - 2] ?? 226),
      })),
    })
  } else if (status.effort) {
    const style = EFFORT_STYLES[status.effort] ?? { bg: 240, fg: 252, bold: false, mark: '•' }
    segments.push({ text: `${style.mark} ${status.effort}`, bg: style.bg, fg: style.fg, bold: style.bold })
  }
  if (status.fast) segments.push({ text: '▶ fast', bg: 220, fg: 16, bold: true })

  return segments
}

/** The place pill: the directory, then the branch. */
export function placePill(status: StatusInfo): PillSegment[] {
  const segments: PillSegment[] = [{ text: status.dir, bg: 237, fg: 252 }]
  if (status.branch) segments.push({ text: `◇ ${status.branch}`, bg: 97, fg: 231, bold: true })

  return segments
}

/** Cells a pill takes: its texts and a half block at each end. */
export function pillWidth(segments: PillSegment[], measure: (text: string) => number): number {
  return segments.reduce((sum, segment) => sum + measure(segment.text), 0) + segments.length + 1
}

/** The mark after a PR number for its review state, with its colour. */
export function reviewMark(state: string | null): { text: string; fg: number } | undefined {
  if (state === null) return undefined
  if (state === 'approved') return { text: '✔', fg: 42 }
  if (state === 'changes_requested') return { text: '✖', fg: 203 }
  if (state === 'commented') return { text: '◐', fg: 75 }

  return { text: state.replace(/_/g, ' '), fg: 245 }
}
