import { describe, expect, test } from 'claude-code/testing'

import { fenceAfter, frontmatterOf, importsOf, isPathRule, markdownPages, MARKDOWN_LIMIT, reflow, normalize, outlineOf, pageOfLine, searchMemory } from '../hooks/memory'

describe('a memory file read', () => {
  test('its outline is its headings outside code, and an index\'s linked entries', async () => {
    const text = ['# Global', '', '## Git', '```', '# not a heading', '```', '### Commits ###', '- [Docs pictures stay current](docs-images.md) — each release redraws them'].join('\n')
    expect(outlineOf(text)).toEqual([
      { line: 1, text: 'Global', level: 1 },
      { line: 3, text: 'Git', level: 2 },
      { line: 7, text: 'Commits', level: 3 },
      { line: 8, text: 'Docs pictures stay current: each release redraws them', level: 3 },
    ])
  })

  test('an auto-memory file\'s frontmatter gives its name, description and type', async () => {
    const text = ['---', 'name: docs-images-current', 'description: "every release updates the pictures"', 'metadata:', '  type: feedback', '---', 'body'].join('\n')
    expect(frontmatterOf(text)).toEqual({ name: 'docs-images-current', description: 'every release updates the pictures', type: 'feedback' })
    expect(frontmatterOf('no frontmatter')).toEqual({})
  })
})

describe('@path imports, as Claude Code reads them', () => {
  test('relative to the importing file, from home with ~/, absolute as given', async () => {
    const text = 'See @docs/rules.md and @~/.claude/shared.md and @/etc/team.md.'
    expect(importsOf(text, '/repo/CLAUDE.md', '/home/me')).toEqual(['/repo/docs/rules.md', '/home/me/.claude/shared.md', '/etc/team.md'])
    expect(importsOf('@../up.md', '/repo/sub/CLAUDE.md', '/home/me')).toEqual(['/repo/up.md'])
  })

  test('not in fenced code, not in a code span, not quoted, not an address or a handle', async () => {
    const text = ['```', '@inside/fence.md', '```', 'a `@in/span.md` here', 'quoted "@q/x.md"', 'mail me@example.com, ping @alice', 'a space: @my\\ notes/a.md'].join('\n')
    expect(importsOf(text, '/repo/CLAUDE.md', '/h')).toEqual(['/repo/my notes/a.md'])
  })

  test('a path\'s dots are resolved', async () => {
    expect(normalize('/repo/./a/../b.md')).toBe('/repo/b.md')
  })
})

test('a search finds every line holding the words, with its file and line, ignoring case', async () => {
  const hits = searchMemory(
    [
      { path: '/a/CLAUDE.md', text: '# Git\nCommit only when asked\n' },
      { path: '/b/rules.md', text: 'never COMMIT secrets' },
    ],
    'commit',
  )
  expect(hits).toEqual([
    { path: '/a/CLAUDE.md', line: 2, text: 'Commit only when asked' },
    { path: '/b/rules.md', line: 1, text: 'never COMMIT secrets' },
  ])
  expect(searchMemory([{ path: '/a', text: 'x' }], '  ')).toEqual([])
})

describe('the reader\'s pages', () => {
  test('a short file is one page, its frontmatter left out, its first line numbered after it', async () => {
    const pages = markdownPages(['---', 'name: x', '---', '# Title', 'body'].join('\n'))
    expect(pages).toEqual([{ text: '# Title\nbody', firstLine: 4 }])
  })

  test('a long file is cut into pages under the Markdown limit, at a heading where one fits', async () => {
    const section = (n: number) => [`## Section ${n}`, ...Array.from({ length: 20 }, () => 'x'.repeat(80))].join('\n')
    const text = Array.from({ length: 6 }, (_, n) => section(n + 1)).join('\n')
    const pages = markdownPages(text)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.text.length).toBeLessThan(MARKDOWN_LIMIT)
    // Every page but the first starts at a heading, and the pages hold every line once.
    for (const page of pages.slice(1)) expect(page.text.startsWith('## Section')).toBe(true)
    expect(pages.map(page => page.text).join('\n')).toBe(text)
    expect(pageOfLine(pages, 1)).toBe(0)
    expect(pageOfLine(pages, text.split('\n').length)).toBe(pages.length - 1)
  })

  test('a page cut inside a fenced block closes the fence and the next opens it again', async () => {
    const text = ['```ts', ...Array.from({ length: 300 }, (_, n) => `const line${n} = ${'1'.repeat(40)}`), '```'].join('\n')
    const pages = markdownPages(text)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]?.text.endsWith('\n```')).toBe(true)
    expect(pages[1]?.text.startsWith('```ts\n')).toBe(true)
  })

  test('control characters but tab and newline are removed', async () => {
    expect(markdownPages('a\u0007b\tc\r\nd')[0]?.text).toBe('ab\tc\nd')
  })
})

test('lines wrapped in a paragraph are joined; lists, headings, tables and code keep their lines', async () => {
  const text = ['# Title', 'one paragraph', 'wrapped here.', '', '- an item', '  that wraps', '- another', '', '| a | b |', '| - | - |', '```', 'code', 'more code', '```', 'after'].join('\n')
  expect(reflow(text)).toBe(['# Title', 'one paragraph wrapped here.', '', '- an item that wraps', '- another', '', '| a | b |', '| - | - |', '```', 'code', 'more code', '```', 'after'].join('\n'))
})

test('a full page ends at a paragraph\'s end, not inside it, and the pages still hold every line once', async () => {
  const paragraph = (n: number) => Array.from({ length: 4 }, (_, line) => `Paragraph ${n} line ${line} ${'x'.repeat(70)}`).join('\n')
  const text = Array.from({ length: 30 }, (_, n) => paragraph(n)).join('\n\n')
  const pages = markdownPages(text, { rows: 26, columns: 88 })
  expect(pages.length).toBeGreaterThan(1)
  for (const page of pages.slice(1)) expect(page.text.startsWith('Paragraph ')).toBe(true)
  for (const page of pages.slice(1)) expect(page.text.split('\n')[0]).toMatch(/ line 0 /)
  expect(pages.map(page => page.text).join('\n\n')).toBe(text)
  expect(pageOfLine(pages, pages[1]?.firstLine ?? 0)).toBe(1)
})

test('a fence closes only on the same character, at least as long, with nothing after it', async () => {
  expect(fenceAfter('```ts', null)).toBe('```')
  expect(fenceAfter('   ~~~~', null)).toBe('~~~~')
  expect(fenceAfter('    ```', null)).toBeNull()
  expect(fenceAfter('```', '````')).toBe('````')
  expect(fenceAfter('~~~', '```')).toBe('```')
  expect(fenceAfter('```js', '```')).toBe('```')
  expect(fenceAfter('````', '```')).toBeNull()
  // An outline skips a heading inside a fence that a shorter marker did not close.
  expect(outlineOf(['````md', '```', '# not a heading', '````', '# Heading'].join('\n')).map(entry => entry.text)).toEqual(['Heading'])
})

test('a hard break keeps the line apart from the next', async () => {
  expect(reflow(['first line  ', 'second line\\', 'third', 'fourth'].join('\n'))).toBe(['first line  ', 'second line\\', 'third fourth'].join('\n'))
})

test('a rule is for matching files only when its frontmatter names paths, not when its body does', async () => {
  expect(isPathRule('---\npaths:\n  - "src/**"\n---\n# API rules')).toBe(true)
  expect(isPathRule('---\ndescription: x\npaths: ["*.ts"]\n---\nbody')).toBe(true)
  // A horizontal rule and a YAML example in the body are no frontmatter.
  expect(isPathRule('# Rules\n\n---\n\n```yaml\npaths:\n  - x\n```')).toBe(false)
  expect(isPathRule('---\ndescription: x\n---\npaths: in the body')).toBe(false)
})

test('a reader page counts a wide character as two cells, so a Korean page keeps to its rows', async () => {
  // Paragraphs of 40 Korean characters, 80 cells: one row each at 80 columns, a blank row between.
  const text = Array.from({ length: 40 }, (_, line) => `${String(line).padStart(2, '0')}${'가'.repeat(38)}`).join('\n\n')
  const pages = markdownPages(text, { rows: 26, columns: 80 })
  const rows = (page: string) => page.split('\n').length
  for (const page of pages) expect(rows(page.text)).toBeLessThanOrEqual(Math.floor(26 * 0.85))
})
