import { describe, expect, it } from "vitest";
import { withIntroducedTabs } from "./viewState";

const CATALOGUE = ["play", "code", "browser", "reports"] as const;
type Tab = (typeof CATALOGUE)[number];

describe("withIntroducedTabs", () => {
  it("shows a newly added view to an editor that predates it", () => {
    // The bug this covers: BROWSER shipped in the build and the bundle and was
    // invisible to every existing install, because a saved strip is filtered
    // against the catalogue and never grows.
    const stored: Tab[] = ["play", "code", "reports"];
    expect(withIntroducedTabs(stored, stored, CATALOGUE)).toEqual([
      "play",
      "code",
      "reports",
      "browser",
    ]);
  });

  it("leaves a view the user closed closed", () => {
    // Once offered, a missing view is a decision — re-opening it on every
    // reload would be a different, more annoying bug.
    const stored: Tab[] = ["play", "code", "reports"];
    expect(withIntroducedTabs(stored, CATALOGUE, CATALOGUE)).toEqual(stored);
  });

  it("does not reshuffle a strip to introduce a tab", () => {
    // The order is the user's. Appending is a smaller surprise than sorting
    // their strip back into catalogue order.
    const stored: Tab[] = ["reports", "play"];
    expect(withIntroducedTabs(stored, stored, CATALOGUE)).toEqual([
      "reports",
      "play",
      "code",
      "browser",
    ]);
  });

  it("opens everything when nothing was recorded", () => {
    // An empty strip means no preference, not "the user closed them all": a
    // dock with no tabs has nothing to show and no way back.
    expect(withIntroducedTabs([], [], CATALOGUE)).toEqual([...CATALOGUE]);
  });

  it("never duplicates a tab that is both stored and introduced", () => {
    const stored: Tab[] = ["play", "browser"];
    expect(withIntroducedTabs(stored, ["play"], CATALOGUE)).toEqual([
      "play",
      "browser",
      "code",
      "reports",
    ]);
  });
});
