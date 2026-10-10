// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import type { ElementTable, RenderElement } from 'claude-code'

import { printable } from '../shared/layout'

/**
 * The band above the prompt in a codex agent's view: the reply to the last
 * `/codex-` command run there, over whatever the band holds beneath.
 */
export function CodexReplyBand(ui: ElementTable, reply: string, below: RenderElement | null) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column">
      <Text>{printable(reply)}</Text>
      {below}
    </Box>
  )
}
