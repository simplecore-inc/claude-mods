import type { Note } from '../types'

/** Gives every note without a number the next one, oldest first, keeping the numbers already given. */
export function numbered(notes: Note[]): Note[] {
  let next = notes.reduce((max, note) => Math.max(max, note.seq ?? 0), 0)
  const missing = new Set(
    [...notes]
      .filter(note => note.seq === undefined)
      .sort((a, b) => a.at - b.at)
      .map(note => note.id),
  )
  const seqs = new Map<string, number>()
  for (const note of [...notes].sort((a, b) => a.at - b.at)) if (missing.has(note.id)) seqs.set(note.id, (next += 1))

  return notes.map(note => (seqs.has(note.id) ? { ...note, seq: seqs.get(note.id) } : note))
}

/** The next number for a new note. */
export function nextSeq(notes: Note[]): number {
  return notes.reduce((max, note) => Math.max(max, note.seq ?? 0), 0) + 1
}

/**
 * The block sent with a prompt: the project's open notes, each by its number,
 * and how Claude says it finished one. The person confirms in the Notes tab.
 */
export function notesContext(project: string, open: Note[]): string {
  return [
    `Open notes for ${project}:`,
    ...open.map(note => `- N${note.seq ?? '?'}: ${note.text}`),
    'When your answer finishes one of these notes, write [done N<number>] for it, such as [done N3].',
  ].join('\n')
}

/** The note numbers an answer marks finished with `[done N<number>]`. */
export function doneMarks(answer: string): number[] {
  return [...answer.matchAll(/\[done N(\d+)\]/g)].map(match => Number(match[1]))
}
