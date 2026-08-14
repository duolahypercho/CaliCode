import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { GamesSidebar } from "./GamesSidebar";
import type { Project } from "../../lib/types";
import type { SessionSummary } from "../../lib/sessions";

const project: Project = {
  schemaVersion: 1,
  slug: "starter",
  title: "CaliCode Starter",
  entities: [],
  scripts: [],
  assets: [],
  tests: [],
  settings: {},
};

afterEach(cleanup);

function renderSidebar(overrides: Partial<ComponentProps<typeof GamesSidebar>> = {}) {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  return render(
    <GamesSidebar
      projects={[project]}
      activeSlug={project.slug}
      sessions={{}}
      activeSessionId={null}
      onOpenProject={() => {}}
      onSelectSession={() => {}}
      onNewSession={() => {}}
      onNewGame={() => {}}
      onOpenAssetsLibrary={() => {}}
      {...overrides}
    />,
  );
}

describe("GamesSidebar project actions", () => {
  it("opens the reference menu with a left click", async () => {
    // jsdom does not provide PointerEvent; Radix deliberately opens mouse
    // menus on pointer-down so a click can immediately move into the menu.
    renderSidebar({ onProjectAction: vi.fn() });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open actions for CaliCode Starter" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Attach folder" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Create permanent worktree" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Edit project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive chats" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  });

  it("opens the same menu when the project row is right-clicked", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("button", { name: "CaliCode Starter" }));

    expect(await screen.findByRole("menuitem", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  });

  it("keeps the ellipsis hidden until hover or keyboard focus", () => {
    renderSidebar();

    const trigger = screen.getByRole("button", { name: "Open actions for CaliCode Starter" });
    expect(trigger.className).toContain("opacity-0");
    expect(trigger.className).toContain("group-hover:opacity-100");
    expect(trigger.className).toContain("group-focus-within:opacity-100");
  });

  it("dispatches each selected action for the project", async () => {
    const onProjectAction = vi.fn();
    renderSidebar({ onProjectAction });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open actions for CaliCode Starter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit project" }));

    expect(onProjectAction).toHaveBeenCalledWith(project, "edit");
  });

  it("labels the folder action Change folder once a folder is attached", async () => {
    const attached: Project = { ...project, workspaceRoot: "/Users/dev/code/my-game" };
    const onProjectAction = vi.fn();
    renderSidebar({ projects: [attached], activeSlug: attached.slug, onProjectAction });

    fireEvent.contextMenu(screen.getByRole("button", { name: "CaliCode Starter" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Change folder" }));
    expect(onProjectAction).toHaveBeenCalledWith(attached, "attach");
  });

  it("shows unpin for a pinned project and dispatches the pin toggle", async () => {
    const onProjectAction = vi.fn();
    renderSidebar({ pinnedProjectSlugs: [project.slug], onProjectAction });

    fireEvent.contextMenu(screen.getByRole("button", { name: "CaliCode Starter" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin project" }));
    expect(onProjectAction).toHaveBeenCalledWith(project, "pin");
  });
});

describe("GamesSidebar session actions", () => {
  const session: SessionSummary = {
    id: "sess-1",
    title: "Tune jump physics",
    projectSlug: "starter",
    provider: null,
    model: null,
    workspaceRoot: null,
    worktreeId: null,
    branch: null,
    createdAt: Math.floor(Date.now() / 1000) - 600,
    updatedAt: Math.floor(Date.now() / 1000) - 120,
    messageCount: 4,
  };

  function renderWithSession(overrides: Partial<ComponentProps<typeof GamesSidebar>> = {}) {
    return renderSidebar({ sessions: { starter: [session] }, ...overrides });
  }

  it("opens the chat menu from the row ellipsis", async () => {
    renderWithSession();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open actions for chat Tune jump physics" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "Pin chat" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rename chat" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Continue in new chat" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy chat ID" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive chat" })).toBeTruthy();
    // Permanent deletion lives in Settings > Archive, never one click from the row.
    expect(screen.queryByRole("menuitem", { name: "Delete chat" })).toBeNull();
  });

  it("offers the working directory only for a chat that has one", async () => {
    renderWithSession();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Tune jump physics/ }));
    expect(await screen.findByRole("menuitem", { name: "Copy chat ID" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Copy working directory" })).toBeNull();

    cleanup();
    renderSidebar({ sessions: { starter: [{ ...session, workspaceRoot: "/Users/dev/code/my-game" }] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Tune jump physics/ }));
    expect(await screen.findByRole("menuitem", { name: "Copy working directory" })).toBeTruthy();
  });

  it("shows unpin and marks the row once the chat is pinned", async () => {
    const onSessionAction = vi.fn();
    renderWithSession({ pinnedSessionIds: [session.id], onSessionAction });

    const row = screen.getByRole("button", { name: /^Tune jump physics/ });
    expect(row.querySelector("[data-session-pinned]")).toBeTruthy();

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin chat" }));
    expect(onSessionAction).toHaveBeenCalledWith(session, "pin");
  });

  it("opens the same menu when the chat row is right-clicked", async () => {
    renderWithSession();

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Tune jump physics/ }));

    expect(await screen.findByRole("menuitem", { name: "Rename chat" })).toBeTruthy();
  });

  it("dispatches the selected action with the session", async () => {
    const onSessionAction = vi.fn();
    renderWithSession({ onSessionAction });

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Tune jump physics/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive chat" }));

    expect(onSessionAction).toHaveBeenCalledWith(session, "archive");
  });

  /* Archiving is the row's clear action, so it must be one click from the row
     — not one menu deep like the rest of the chat actions. */
  it("archives from the row itself, revealed on hover", async () => {
    const onSessionAction = vi.fn();
    renderWithSession({ onSessionAction });

    const archive = screen.getByRole("button", { name: "Archive Tune jump physics" });
    expect(archive.className).toContain("opacity-0");
    expect(archive.className).toContain("group-hover:opacity-100");
    expect(archive.className).toContain("group-focus-within:opacity-100");

    fireEvent.click(archive);
    expect(onSessionAction).toHaveBeenCalledWith(session, "archive");
    // One click, no dialog and no menu in between.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the chat ellipsis hidden until hover or keyboard focus", () => {
    renderWithSession();

    const trigger = screen.getByRole("button", { name: "Open actions for chat Tune jump physics" });
    expect(trigger.className).toContain("opacity-0");
    expect(trigger.className).toContain("group-hover:opacity-100");
    expect(trigger.className).toContain("group-focus-within:opacity-100");
  });

  it("keeps the right-click menu on the chat row from opening the project menu", async () => {
    renderWithSession();

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Tune jump physics/ }));

    await screen.findByRole("menuitem", { name: "Rename chat" });
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
  });
});

describe("GamesSidebar header", () => {
  it("renders the wordmark as a static two-tone lockup, not a menu button", () => {
    renderSidebar();

    // The old "CaliCode ⌄" dropdown trigger is gone.
    expect(screen.queryByRole("button", { name: "CaliCode menu" })).toBeNull();

    // Two-tone wordmark: "cali" faint, "code" strong, with the brand icon.
    const sidebar = screen.getByRole("complementary", { name: "Games sidebar" });
    const cali = screen.getByText("cali");
    const code = screen.getByText("code");
    expect(sidebar.contains(cali)).toBe(true);
    expect(cali.className).toContain("text-ink-faint");
    expect(code.className).toContain("text-ink-strong");
    // Static text — no button wraps the lockup.
    expect(cali.closest("button")).toBeNull();

    // The search toggle stays to the right of the lockup.
    expect(screen.getByRole("button", { name: "Toggle search" })).toBeTruthy();
  });
});

describe("GamesSidebar rows", () => {
  it("renders game rows without a session count", () => {
    renderSidebar();

    const row = screen.getByRole("button", { name: "CaliCode Starter" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toBe("CaliCode Starter");
  });

  it("highlights the active game row while no session is selected", () => {
    renderSidebar();

    const row = screen.getByRole("button", { name: "CaliCode Starter" });
    expect(row.classList.contains("bg-surface-3")).toBe(true);
  });

  it("moves the highlight to the session row when a session is active", () => {
    const session: SessionSummary = {
      id: "sess-1",
      title: "Tune jump physics",
      projectSlug: "starter",
      provider: null,
      model: null,
      workspaceRoot: null,
      worktreeId: null,
      branch: null,
      createdAt: Math.floor(Date.now() / 1000) - 600,
      updatedAt: Math.floor(Date.now() / 1000) - 120,
      messageCount: 4,
    };
    renderSidebar({ sessions: { starter: [session] }, activeSessionId: "sess-1" });

    // Only the session row is gray — the parent game row drops the highlight.
    const gameRow = screen.getByRole("button", { name: "CaliCode Starter" });
    expect(gameRow.classList.contains("bg-surface-3")).toBe(false);

    const sessionRow = screen.getByRole("button", { name: /^Tune jump physics/ });
    expect(sessionRow.classList.contains("bg-surface-3")).toBe(true);
  });
});

describe("GamesSidebar nav block", () => {
  it("has no Open folder row — the New game dialog covers existing folders", () => {
    renderSidebar();

    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "New game" })).toBeTruthy();
  });

  it("exposes an Assets Library row that calls its handler", () => {
    const onOpenAssetsLibrary = vi.fn();
    renderSidebar({ onOpenAssetsLibrary });

    fireEvent.click(screen.getByRole("button", { name: "Assets Library" }));
    expect(onOpenAssetsLibrary).toHaveBeenCalledTimes(1);
  });

  it("marks the Assets Library row selected when the library view is active", () => {
    renderSidebar({ assetsLibraryActive: true });

    const row = screen.getByRole("button", { name: "Assets Library" });
    expect(row.classList.contains("bg-surface-3")).toBe(true);
  });

  it("no longer renders the Assets repo section at the bottom", () => {
    renderSidebar();

    expect(screen.queryByRole("region", { name: "Asset library" })).toBeNull();
    expect(screen.queryByText("Assets")).toBeNull();
  });
});

describe("GamesSidebar search dialog", () => {
  const session: SessionSummary = {
    id: "sess-1",
    title: "Tune jump physics",
    projectSlug: "starter",
    provider: null,
    model: null,
    workspaceRoot: null,
    worktreeId: null,
    branch: null,
    createdAt: Math.floor(Date.now() / 1000) - 600,
    updatedAt: Math.floor(Date.now() / 1000) - 120,
    messageCount: 4,
  };

  function renderWithSessions(onSelectSession = vi.fn()) {
    return renderSidebar({ sessions: { starter: [session] }, onSelectSession });
  }

  it("opens from the header icon with a focusable search input", async () => {
    renderWithSessions();

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));

    const input = await screen.findByLabelText<HTMLInputElement>("Search games");
    fireEvent.change(input, { target: { value: "cali" } });
    expect(input.value).toBe("cali");
  });

  it("matches session titles and selects a session, then closes", async () => {
    const onSelectSession = vi.fn();
    renderWithSessions(onSelectSession);

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    const input = await screen.findByLabelText("Search games");
    fireEvent.change(input, { target: { value: "jump" } });

    fireEvent.click(await screen.findByRole("button", { name: /Tune jump physics/ }));
    expect(onSelectSession).toHaveBeenCalledWith("starter", "sess-1");
    expect(screen.queryByLabelText("Search games")).toBeNull();
  });

  it("closes on Escape", async () => {
    renderWithSessions();

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    const input = await screen.findByLabelText("Search games");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Search games")).toBeNull();
  });
});

describe("GamesSidebar running indicator", () => {
  const sessionRunning: SessionSummary = {
    id: "sess-running",
    title: "Running chat",
    projectSlug: "starter",
    provider: null,
    model: null,
    workspaceRoot: null,
    worktreeId: null,
    branch: null,
    createdAt: Math.floor(Date.now() / 1000) - 600,
    updatedAt: Math.floor(Date.now() / 1000) - 30,
    messageCount: 4,
  };
  const sessionIdle: SessionSummary = {
    ...sessionRunning,
    id: "sess-idle",
    title: "Idle chat",
  };

  it("renders a spinner on the row whose session id is in the running set", () => {
    renderSidebar({
      sessions: { starter: [sessionRunning, sessionIdle] },
      runningSessionIds: new Set([sessionRunning.id]),
    });

    const [spinner] = screen.getAllByTestId("session-running-spinner");
    expect(spinner).toBeTruthy();
    const row = screen.getByRole("button", { name: "Running chat (agent running)" });
    expect(row.contains(spinner)).toBe(true);
    expect(screen.getByText("Agent is running on this chat")).toBeTruthy();
  });

  it("does not render the spinner on rows whose session id is not running", () => {
    renderSidebar({
      sessions: { starter: [sessionRunning, sessionIdle] },
      runningSessionIds: new Set([sessionRunning.id]),
    });

    const idleRow = screen.getByRole("button", { name: /^Idle chat/ });
    expect(idleRow.querySelector('[data-testid="session-running-spinner"]')).toBeNull();
  });

  it("clears the spinner when the running set no longer contains the session id", () => {
    const { rerender } = renderSidebar({
      sessions: { starter: [sessionRunning] },
      runningSessionIds: new Set([sessionRunning.id]),
    });
    expect(screen.getByTestId("session-running-spinner")).toBeTruthy();

    rerender(
      <GamesSidebar
        projects={[project]}
        activeSlug={project.slug}
        sessions={{ starter: [sessionRunning] }}
        activeSessionId={null}
        runningSessionIds={new Set()}
        onOpenProject={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onNewGame={() => {}}
        onOpenAssetsLibrary={() => {}}
      />,
    );
    expect(screen.queryByTestId("session-running-spinner")).toBeNull();
    expect(screen.queryByText("Agent is running on this chat")).toBeNull();
  });

  it("does not show the spinner on any row when the running set is empty", () => {
    renderSidebar({
      sessions: { starter: [sessionRunning, sessionIdle] },
      runningSessionIds: new Set(),
    });
    expect(screen.queryByTestId("session-running-spinner")).toBeNull();
  });
});

describe("GamesSidebar empty states", () => {
  it("explains the empty list and offers the action that fills it", () => {
    const onNewGame = vi.fn();
    renderSidebar({ projects: [], onNewGame });

    expect(screen.getByText(/A game holds its chats, scene, and assets/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create your first game/ }));
    expect(onNewGame).toHaveBeenCalledTimes(1);
  });

  it("blames an offline core when that is why the list is empty", () => {
    renderSidebar({ projects: [], coreStatus: "offline" });
    expect(screen.getByText(/Core is offline/)).toBeTruthy();
  });

  it("stays quiet about the core while it is reachable", () => {
    renderSidebar({ projects: [], coreStatus: "ready" });
    expect(screen.queryByText(/Core is offline/)).toBeNull();
  });

  it("offers a first chat inside a game that has none", () => {
    const onNewSession = vi.fn();
    renderSidebar({ sessions: {}, onNewSession });

    fireEvent.click(screen.getByRole("button", { name: "Start a chat in CaliCode Starter" }));
    expect(onNewSession).toHaveBeenCalledWith("starter");
  });

  it("does not offer the first-chat row once the game has chats", () => {
    const session: SessionSummary = {
      id: "sess-1",
      title: "Tune jump physics",
      projectSlug: "starter",
      provider: null,
      model: null,
      workspaceRoot: null,
      worktreeId: null,
      branch: null,
      createdAt: Math.floor(Date.now() / 1000) - 600,
      updatedAt: Math.floor(Date.now() / 1000) - 120,
      messageCount: 4,
    };
    renderSidebar({ sessions: { starter: [session] } });

    expect(screen.queryByRole("button", { name: /Start a chat in/ })).toBeNull();
  });
});
