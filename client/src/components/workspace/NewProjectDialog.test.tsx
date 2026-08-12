import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewProjectDialog } from "./NewProjectDialog";

vi.mock("../../lib/workspace", () => ({
  browseFolders: vi.fn(async (path?: string) =>
    path === "/Users/dev/code"
      ? {
          path: "/Users/dev/code",
          parent: "/Users/dev",
          dirs: [{ name: "my-game", path: "/Users/dev/code/my-game", isProject: true }],
        }
      : {
          path: "/Users/dev",
          parent: "/Users",
          dirs: [
            { name: "code", path: "/Users/dev/code", isProject: false },
            { name: "notes", path: "/Users/dev/notes", isProject: false },
          ],
        },
  ),
}));

afterEach(cleanup);

function renderDialog(onCreate = vi.fn(), onOpenFolder = vi.fn()) {
  render(
    <NewProjectDialog
      open
      busy={false}
      error=""
      onOpenChange={() => undefined}
      onCreate={onCreate}
      onOpenFolder={onOpenFolder}
    />,
  );
  return { onCreate, onOpenFolder };
}

describe("NewProjectDialog", () => {
  it("starts on the details step and requires a name or a folder", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Create project" })).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Skyline" } });
    expect(continueButton.disabled).toBe(false);
  });

  it("moves to the template step and creates the game", async () => {
    const { onCreate } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "  Orbital Gallery  " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    const createButton = screen.getByRole("button", { name: "Create game" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Showcase scene/ }));
    fireEvent.click(createButton);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Orbital Gallery", "showcase"));
  });

  it("can return to the details step without losing the name", () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Skyline" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect((screen.getByPlaceholderText("Project name") as HTMLInputElement).value).toBe("Skyline");
  });

  it("browses real folders and opens the selected one directly", async () => {
    const { onCreate, onOpenFolder } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));
    await screen.findByText("code");

    // Navigate into a folder, then select the project inside it.
    fireEvent.click(screen.getByRole("button", { name: /^code$/ }));
    await screen.findByText("my-game");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    // The selected folder is shown and the template step is skipped.
    expect(screen.getByText("/Users/dev/code/my-game")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith("/Users/dev/code/my-game", undefined));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("passes the typed name along with the selected folder", async () => {
    const { onOpenFolder } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Custom Name" } });
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^code$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith("/Users/dev/code/my-game", "Custom Name"));
  });
});
