import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssetsLibraryPage } from "./AssetsLibraryPage";
import { assetRepos } from "../../lib/assetLibrary";

afterEach(cleanup);

function renderPage(overrides: Partial<Parameters<typeof AssetsLibraryPage>[0]> = {}) {
  return render(
    <AssetsLibraryPage
      installedRepoIds={[]}
      onInstall={() => {}}
      onUninstall={() => {}}
      projectTitle="Starter"
      {...overrides}
    />,
  );
}

describe("AssetsLibraryPage grid", () => {
  it("renders a card per registry repo", () => {
    const { container } = renderPage();

    const cards = container.querySelectorAll("[data-asset-card]");
    expect(cards.length).toBe(assetRepos.length);
    for (const repo of assetRepos) {
      expect(screen.getByRole("button", { name: repo.name })).toBeTruthy();
    }
  });

  it("filters cards by search and shows the empty state for no matches", () => {
    const { container } = renderPage();
    const input = screen.getByLabelText("Search assets");

    fireEvent.change(input, { target: { value: "zzz-no-such-asset" } });
    expect(container.querySelectorAll("[data-asset-card]").length).toBe(0);
    expect(screen.getByText("No assets match")).toBeTruthy();

    fireEvent.change(input, { target: { value: assetRepos[0].tags[0] } });
    expect(screen.getByRole("button", { name: assetRepos[0].name })).toBeTruthy();
  });
});

describe("AssetsLibraryPage detail dialog", () => {
  const repo = assetRepos[0];

  it("opens on card click with a credit link pointing at the source repo", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: repo.name }));

    expect(await screen.findByRole("heading", { name: repo.name })).toBeTruthy();
    const credit = screen.getByRole("link");
    expect(credit.getAttribute("href")).toBe(repo.url);
    expect(credit.getAttribute("target")).toBe("_blank");
    expect(credit.getAttribute("rel")).toBe("noreferrer");
  });

  it("installs the repo into the project from the footer button", async () => {
    const onInstall = vi.fn();
    renderPage({ onInstall });

    fireEvent.click(screen.getByRole("button", { name: repo.name }));
    fireEvent.click(await screen.findByRole("button", { name: `Install to Starter` }));

    expect(onInstall).toHaveBeenCalledWith(repo.id);
  });

  it("shows the installed state with a Remove button that uninstalls", async () => {
    const onUninstall = vi.fn();
    renderPage({ installedRepoIds: [repo.id], onUninstall });

    fireEvent.click(screen.getByRole("button", { name: repo.name }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onUninstall).toHaveBeenCalledWith(repo.id);
  });
});
