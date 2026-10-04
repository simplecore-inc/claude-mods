import { describe, expect, test } from 'claude-code/testing'

import type { StatusInfo } from '../types'
import { ansiHex, contextScaled, modelPill, pillWidth, placePill, reviewMark, shortModel } from '../hooks/statusline'

const STATUS: StatusInfo = {
  updatedAt: 1,
  model: 'Opus 5.5 (1M context)',
  effort: 'low',
  ultracode: false,
  fast: true,
  contextUsed: 40,
  task: '',
  dir: 'claude-mods',
  branch: 'main',
  pr: { number: 12, reviewState: 'approved' },
  linesAdded: 3,
  linesRemoved: 1,
}

describe('ansiHex', () => {
  test('the base, cube and grey ranges', async () => {
    expect(ansiHex(9)).toBe('#ff0000')
    expect(ansiHex(16)).toBe('#000000')
    expect(ansiHex(60)).toBe('#5f5f87')
    expect(ansiHex(231)).toBe('#ffffff')
    expect(ansiHex(237)).toBe('#3a3a3a')
  })
})

test('shortModel and contextScaled match the status line command', async () => {
  expect(shortModel('Opus 5.5 (1M context)')).toBe('Opus5.5(1M)')
  expect(shortModel('Opus 5.5')).toBe('Opus5.5')
  expect(contextScaled(40)).toBe(50)
  expect(contextScaled(95)).toBe(100)
})

test('the model pill carries effort and fast; ultracode replaces effort', async () => {
  expect(modelPill(STATUS).map(segment => segment.text)).toEqual(['Opus5.5(1M)', '○ low', '▶ fast'])
  const ultra = modelPill({ ...STATUS, ultracode: true, fast: false })
  expect(ultra.map(segment => segment.text)).toEqual(['Opus5.5(1M)', '★ ULTRACODE ★'])
  expect(ultra[1]?.letters?.map(letter => letter.char).join('')).toBe('★ ULTRACODE ★')
})

test('the place pill, its width and the review mark', async () => {
  const place = placePill(STATUS)
  expect(place.map(segment => segment.text)).toEqual(['claude-mods', '◇ main'])
  expect(pillWidth(place, text => text.length)).toBe(11 + 6 + 3)
  expect(reviewMark('approved')).toEqual({ text: '✔', fg: 42 })
  expect(reviewMark('needs_work')).toEqual({ text: 'needs work', fg: 245 })
  expect(reviewMark(null)).toBeUndefined()
})

