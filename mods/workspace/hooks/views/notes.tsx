import type { ElementTable } from 'claude-code'

import type { Note } from '../../types'
import type { Messages } from '../i18n'
import { Card, Empty, IconButton, Section, theme, Toggle } from '../shared/kit'

export type NotesModel = {
  notes: Note[]
  project: string
  /** Whether the surface draws a text field (every surface but mobile). */
  hasField: boolean
  /** Whether open notes go to Claude with every prompt (the `notesInContext` setting). */
  isSentWithPrompts: boolean
  m: Messages
}

export type NotesActions = {
  add: (text: string) => void
  toggle: (note: Note) => void
  insert: (note: Note) => void
  remove: (note: Note) => void
  toggleSending: () => void
}

export function NotesTab(ui: ElementTable, model: NotesModel, actions: NotesActions) {
  const { Box, Text } = ui
  // The mobile app draws no field: there notes come from /sc:workspace notes <text>.
  const Input = model.hasField && 'Input' in ui ? ui.Input : undefined
  const { m } = model
  const open = model.notes.filter(note => !note.isDone).length
  // Two groups, each newest first: what is left to do, then what is done.
  const newest = (a: Note, b: Note) => b.at - a.at
  const openNotes = model.notes.filter(note => !note.isDone).sort(newest)
  const doneNotes = model.notes.filter(note => note.isDone).sort(newest)
  const row = (note: Note) => {

    return (
      <Box key={`note-${note.id}`} justifyContent="space-between">
        <Box gap={1} flexShrink={1}>
          {/* ☐ marks an open note done; ☑ puts a done one back. A done note is struck
              through: it is no longer sent with prompts, as its group's heading says. */}
          {IconButton(ui, `toggle-${note.id}`, note.isDone ? '☑' : '☐', theme.ok, () => actions.toggle(note))}
          <Text dimColor={note.isDone} strikethrough={note.isDone} wrap="wrap">
            {note.text}
          </Text>
        </Box>
        <Box gap={2} flexShrink={0}>
          {IconButton(ui, `insert-${note.id}`, '↵', theme.accent, () => actions.insert(note))}
          {/* Deleting asks in a dialog first. */}
          {IconButton(ui, `remove-note-${note.id}`, '✕', theme.danger, () => actions.remove(note))}
        </Box>
      </Box>
    )
  }

  return (
    <Box key="notes" flexDirection="column">
      {Section(ui, 'notes-title', m.notesTitle, m.notesDetail(model.project, open, model.notes.length))}
      <Text key="notes-purpose" dimColor wrap="wrap">
        {m.notesPurpose}
      </Text>
      {Input ? (
        // A bordered field in the accent colour, so it reads as the place to type.
        <Box key="notes-input" marginY={1} borderStyle="round" borderColor={theme.accent} paddingX={1} gap={1}>
          <Text color={theme.accent}>✎</Text>
          <Input key="note-new" placeholder={m.notePlaceholder} submitLabel={m.noteAdd} onSubmit={value => actions.add(value)} />
        </Box>
      ) : (
        <Text key="notes-no-input" dimColor>
          {m.notesNoInput}
        </Text>
      )}
      {model.notes.length === 0 && Empty(ui, 'notes-empty', [m.notesEmpty, m.notesEmptyHint])}
      {openNotes.length > 0 && Section(ui, 'notes-open-title', m.notesOpenTitle, `${openNotes.length}`)}
      {openNotes.length > 0 && Card(ui, 'notes-card', false, <Box flexDirection="column">{openNotes.map(row)}</Box>)}
      {/* The switch sits under the notes it sends: what it acts on is right above it. */}
      <Box key="notes-sending" marginTop={1}>
        {Toggle(ui, 'notes-send', model.isSentWithPrompts, m.notesSendToggle, { on: m.switchOn, off: m.switchOff }, actions.toggleSending)}
      </Box>
      {doneNotes.length > 0 && (
        <Box key="notes-done-group" flexDirection="column" marginTop={1}>
          {Section(ui, 'notes-done-title', m.notesDoneTitle, m.notesDoneDetail(doneNotes.length))}
          {Card(ui, 'notes-done-card', false, <Box flexDirection="column">{doneNotes.map(row)}</Box>)}
        </Box>
      )}
    </Box>
  )
}
