/**
 * Which dock tabs an editor should open, given what it last saved.
 *
 * Extracted from `App` because the rule is not obvious and was wrong: adding a
 * view to `WORKSPACE_TABS` shipped it to nobody. The stored strip is filtered
 * against the catalogue, so any editor that had ever saved one kept exactly
 * the tabs it already had — BROWSER was in the build, in the bundle, and
 * invisible to every existing install.
 */

/**
 * Merge views introduced since this strip was saved.
 *
 * `seen` is what the editor has already *offered*, which is the distinction
 * `stored` cannot express: a view missing from `stored` is either brand new or
 * one the user deliberately closed, and re-opening the latter on every reload
 * would be its own bug. An editor saved before `seen` existed passes its
 * stored strip as `seen`, so it gains genuinely new views once and nothing
 * else.
 *
 * New views are appended rather than slotted into catalogue order: the strip
 * is the user's, and reshuffling it to introduce one tab is a bigger surprise
 * than where that tab lands.
 */
export function withIntroducedTabs<Tab extends string>(
  stored: readonly Tab[],
  seen: readonly Tab[],
  catalogue: readonly Tab[],
): Tab[] {
  // An empty strip means "no preference recorded", not "the user closed
  // everything" — a dock with no tabs has nothing to show and no way back.
  if (stored.length === 0) return [...catalogue];
  const introduced = catalogue.filter((view) => !seen.includes(view));
  return [...new Set([...stored, ...introduced])];
}
