/** The mods whose panes open side by side; each keeps `paneOpen` in its state while its pane is open. */
export type ModPane = 'sc-accounts' | 'sc-workspace' | 'sc-toolbox'

/**
 * Whether another mod's pane is open beside this one, from each mod's
 * `paneOpen`, read with `$.state.get` while drawing: the engine then draws its tab row above the pane, and the
 * header keeps a row apart from it.
 */
export function isBesideOtherPanes(self: ModPane, open: Record<ModPane, boolean>): boolean {
  return (Object.keys(open) as ModPane[]).some(plugin => plugin !== self && open[plugin])
}
