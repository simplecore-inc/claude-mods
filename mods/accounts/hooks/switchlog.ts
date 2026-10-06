/**
 * The record of every change of the login Claude Code uses: each switch this
 * mod makes, and each change it finds that no switch of its made. Kept as one
 * JSON line per change, so a change nobody asked for can be traced to the
 * session that made it, or shown to have come from outside the mod.
 */

/** One change of the live login. */
export type LoginChange = {
  /** Milliseconds since the epoch. */
  at: number
  /**
   * `switch`: this mod switched; `heal`: this mod put the configured account's saved login back after
   * Claude Code's was rejected; `outside`: the login changed with no switch or heal of this mod's just before.
   */
  kind: 'switch' | 'heal' | 'outside'
  /** The session that made or noticed the change, its folder and the mod's version there. */
  session: string
  cwd: string
  version: string
  /** How a switch was asked for: the Switch dialog or the `use` command. */
  via?: 'dialog' | 'command'
  /** The emails before and after; null when unknown. */
  from: string | null
  to: string
}

/** How long after a switch of this mod's a change to the same account is that switch's, in any session. */
export const OWN_SWITCH_MS = 2 * 60 * 1000
/** The most lines the record keeps: the oldest go first. */
export const CHANGES_KEPT = 200

/** The record's lines as changes, a line that does not parse left out. */
export function parseChanges(text: string): LoginChange[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as LoginChange]
      } catch {
        return []
      }
    })
}

/** The record with one more change, cut to the newest `CHANGES_KEPT`. */
export function withChange(text: string, change: LoginChange): string {
  const lines = [...text.split('\n').filter(line => line.trim() !== ''), JSON.stringify(change)]

  return `${lines.slice(-CHANGES_KEPT).join('\n')}\n`
}

/** Whether a switch or a heal of this mod's, in any session, made the login `to` shortly before `at`. */
export function isOwnSwitch(changes: readonly LoginChange[], to: string, at: number): boolean {
  return changes.some(change => (change.kind === 'switch' || change.kind === 'heal') && change.to === to && at - change.at >= -5_000 && at - change.at <= OWN_SWITCH_MS)
}
