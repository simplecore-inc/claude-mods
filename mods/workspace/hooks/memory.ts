/**
 * Claude Code's memory files as the Memory tab shows them: each file's
 * outline, and every line a search finds, with where it is. Pure: the hooks
 * module finds and reads the files.
 */

/**
 * The fence a line opens or closes, by CommonMark's rule: up to three spaces
 * of indent, then three or more backticks or tildes. With `open` (the marker
 * of the fence open now), the line closes it when it is the same character,
 * at least as long, with nothing after it; it opens one otherwise. Returns the
 * open fence's marker after the line, or null with none open.
 */
export function fenceAfter(line: string, open: string | null): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match?.[1]) return open
  const marker = match[1]
  if (open === null) return marker[0] === '`' && (match[2] ?? '').includes('`') ? null : marker
  const closes = marker[0] === open[0] && marker.length >= open.length && (match[2] ?? '').trim() === ''

  return closes ? null : open
}

/** One line of a file's outline: a heading, or an auto-memory entry's name. */
export type OutlineEntry = { line: number; text: string; level: number }

/** One line a search found: the file it is in, its number and its text. */
export type MemoryHit = { path: string; line: number; text: string }

/** An auto-memory file's frontmatter: `name`, `description` and the type under `metadata`. */
export type MemoryFront = { name?: string; description?: string; type?: string }

/** The frontmatter between the first two `---` lines, read key by key; nothing when the file has none. */
export function frontmatterOf(text: string): MemoryFront {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const front: MemoryFront = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^\s*(name|description|type):\s*(.*)$/.exec(line)
    if (pair?.[1] && pair[2] !== undefined) front[pair[1] as keyof MemoryFront] = pair[2].trim().replace(/^["']|["']$/g, '')
  }

  return front
}

/**
 * A file's outline: its Markdown headings with their depth, outside fenced
 * code; for a MEMORY.md index, each linked entry (`- [Title](file.md)`).
 */
export function outlineOf(text: string): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  let fence: string | null = null
  text.split(/\r?\n/).forEach((line, index) => {
    const before = fence
    fence = fenceAfter(line, fence)
    if (before !== null || fence !== null) return
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading?.[1] && heading[2]) {
      entries.push({ line: index + 1, text: heading[2], level: heading[1].length })

      return
    }
    const link = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/.exec(line)
    if (link?.[1]) entries.push({ line: index + 1, text: link[3] ? `${link[1]}: ${link[3]}` : link[1], level: 3 })
  })

  return entries
}

/**
 * The files a memory file imports with `@path`, as Claude Code reads them:
 * outside fenced code and code spans, unquoted, a space in a path written as
 * `\\ `; `~/` from `home`, a relative path from the importing file's folder.
 */
export function importsOf(text: string, file: string, home: string): string[] {
  const folder = file.slice(0, file.lastIndexOf('/'))
  const found: string[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const before = fence
    fence = fenceAfter(line, fence)
    if (before !== null || fence !== null) continue
    const outsideSpans = line.replace(/`[^`]*`/g, ' ')
    for (const match of outsideSpans.matchAll(/(?:^|\s)@((?:\\ |[^\s"'`])+)/g)) {
      const path = (match[1] ?? '').replace(/\\ /g, ' ').replace(/[.,;:)]+$/, '')
      // An address or a handle (`@user`) is not a path: a path has a slash or a file extension.
      if (!path.includes('/') && !/\.\w+$/.test(path)) continue
      const absolute = path.startsWith('~/') ? `${home}/${path.slice(2)}` : path.startsWith('/') ? path : `${folder}/${path}`
      found.push(normalize(absolute))
    }
  }

  return [...new Set(found)]
}

/** A path with `.` and `..` parts resolved. */
export function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }

  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

/** Every line of `files` holding `query`, ignoring case, in file order; at most `limit`. */
export function searchMemory(files: { path: string; text: string }[], query: string, limit = 50): MemoryHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: MemoryHit[] = []
  for (const file of files) {
    const lines = file.text.split(/\r?\n/)
    for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
      const line = lines[index] ?? ''
      if (line.toLowerCase().includes(needle)) hits.push({ path: file.path, line: index + 1, text: line.trim() })
    }
  }

  return hits
}

/** One page of a file for the reader: its Markdown and the file's line it starts on. */
export type MarkdownPage = { text: string; firstLine: number }

/** The most characters the engine's Markdown element takes; a page keeps under it. */
export const MARKDOWN_LIMIT = 10_000
/** The characters a reader page holds: about what a pane shows without scrolling, so its tiles stay in view. */
export const READER_PAGE_CHARS = 3_000

/**
 * Joins the lines a paragraph was wrapped into, as Markdown means them: a
 * line of text after a line of text is the same paragraph. Headings, list
 * items, quotes, tables, rules, HTML, indented and fenced code keep their
 * lines.
 */
export function reflow(text: string): string {
  const out: string[] = []
  let fence: string | null = null
  let isParagraph = false
  for (const line of text.split('\n')) {
    const before = fence
    fence = fenceAfter(line, fence)
    if (before !== null || fence !== null) {
      out.push(line)
      isParagraph = false
      continue
    }
    const isBlock = line.trim() === '' || /^(\s{4,}|\t)/.test(line) || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line)
    if (!isBlock && isParagraph && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`
    else out.push(line)
    // A list item's continuation lines join it too; a blank line, another block or a hard break
    // (two spaces or a backslash at the end) ends it.
    const isHardBreak = / {2,}$/.test(line) || /\\$/.test(line)
    isParagraph = line.trim() !== '' && !isHardBreak && !/^\s*(#{1,6}\s|\||<|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line) && !/^(\s{4,}|\t)/.test(line)
  }

  return out.join('\n')
}

/**
 * A memory file as pages the Markdown element can draw: the frontmatter left
 * out, control characters but tab and newline removed, and the text cut into
 * pages of at most `limit` characters, at a heading where one fits and at a
 * line otherwise. A page cut inside a fenced block closes the fence, and the
 * next page opens it again with the same marker.
 */
export function markdownPages(text: string, room: { chars?: number; rows?: number; columns?: number } = {}): MarkdownPage[] {
  const limit = Math.min(room.chars ?? READER_PAGE_CHARS, MARKDOWN_LIMIT - 500)
  // A line wraps at the reader's width; the rows a page may take leave a margin for that guess.
  const columns = Math.max(20, room.columns ?? 80)
  const rowLimit = room.rows === undefined ? Number.POSITIVE_INFINITY : Math.max(6, Math.floor(room.rows * 0.85))
  // Wrapped lines are drawn joined into paragraphs, so a line of text costs its share of rows, a blank line one.
  const rowsOf = (line: string) => (line.trim() === '' ? 1 : line.length / columns)
  let rows = 0
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  const skipped = front ? front[0].split('\n').length - 1 : 0
  const body = (front ? text.slice(front[0].length) : text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const lines = body.split('\n')
  const pages: MarkdownPage[] = []
  let current: string[] = []
  let size = 0
  let firstLine = skipped + 1
  // The open fence's marker closes a page; its opening line, language and all, opens the next.
  let fence: string | null = null
  let opener = ''
  const flush = (nextLine: number) => {
    if (current.length === 0) return
    pages.push({ text: fence ? `${current.join('\n')}\n${fence}` : current.join('\n'), firstLine })
    current = fence ? [opener] : []
    size = fence ? opener.length + 1 : 0
    rows = fence ? 1 : 0
    firstLine = nextLine
  }
  lines.forEach((raw, index) => {
    const lineNumber = skipped + index + 1
    // A line longer than a page is cut; such a line is rare in a memory file.
    const line = raw.length > limit - 20 ? `${raw.slice(0, limit - 21)}…` : raw
    const isHeading = fence === null && /^#{1,3}\s/.test(line)
    // A heading starts a new page once the page is past half; any line does once it would overflow.
    const isFull = size + line.length + 1 > limit || rows + rowsOf(line) > rowLimit
    const isPastHalf = size > limit / 2 || rows > rowLimit / 2
    if (isHeading && isPastHalf) flush(lineNumber)
    else if (isFull) {
      // A full page ends at its last blank line, so a paragraph is not cut, when that line is in its second half.
      const blank = fence === null ? current.lastIndexOf('') : -1
      if (blank > current.length / 2) {
        const carried = current.slice(blank + 1)
        current = current.slice(0, blank)
        flush(lineNumber - carried.length)
        current.push(...carried)
        size = carried.reduce((sum, kept) => sum + kept.length + 1, 0)
        rows = carried.reduce((sum, kept) => sum + rowsOf(kept), 0)
      } else flush(lineNumber)
    }
    current.push(line)
    size += line.length + 1
    rows += rowsOf(line)
    const before = fence
    fence = fenceAfter(line, fence)
    if (before === null && fence !== null) opener = line.trim()
  })
  fence = null
  flush(skipped + lines.length + 1)

  return pages.length > 0 ? pages : [{ text: '', firstLine: 1 }]
}

/** The page that holds `line` of the file. */
export function pageOfLine(pages: MarkdownPage[], line: number): number {
  let found = 0
  pages.forEach((page, index) => {
    if (page.firstLine <= line) found = index
  })

  return found
}
