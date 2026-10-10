// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

// The codex agent whose view is open on each surface, if any, and the reply
// to the last /codex- command run in each such view. The band above the
// prompt sees the view (a render hook may not write $.state, so it is kept
// here) and draws the reply; a command reads the view. Display only: a reload
// drops both, and the next draw sets the view again. Each surface keeps its
// own, so a terminal and a desktop showing different views never flip one
// value back and forth, each redrawing the other.

// Surface by surface, the latest to open a codex view last.
const opens = new Map<string, string>()
const replies = new Map<string, string>()

// The codex agent whose view the surface shows; with no surface named (a
// command, the menu), the one opened last on a surface that still shows it.
export function openView(surface?: string): string | undefined {
  return surface === undefined ? [...opens.values()].at(-1) : opens.get(surface)
}

// Says whether the surface's view changed; a view no surface shows any more drops its reply.
export function setOpenView(surface: string, agentId: string | undefined): boolean {
  const was = opens.get(surface)
  if (agentId === was) return false
  opens.delete(surface)
  if (agentId !== undefined) opens.set(surface, agentId)
  if (was !== undefined && ![...opens.values()].includes(was)) replies.delete(was)
  return true
}

export function replyIn(agentId: string): string | undefined {
  return replies.get(agentId)
}

export function setReply(agentId: string, reply: string): void {
  replies.set(agentId, reply)
}
