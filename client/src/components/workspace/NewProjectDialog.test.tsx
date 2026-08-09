import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewProjectDialog } from "./NewProjectDialog";

afterEach(cleanup);

function renderDialog(onCreate = vi.fn()) {
  render(
    <NewProjectDialog open busy={false} error="" onOpenChange={() => undefined} onCreate={onCreate} />,
  );
  return onCreate;
}

describe("NewProjectDialog", () => {
  it("requires a template before showing project details", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();

    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Starter scene/ }));
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);

    expect(screen.getByRole("heading", { name: "Name your game" })).toBeTruthy();
    expect(screen.getByText("Starter scene")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("creates the project with the chosen template", async () => {
    const onCreate = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Showcase scene/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Orbital Gallery  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Orbital Gallery", "showcase"));
  });

  it("shows a field error when the project name is empty", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Starter scene/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a project name.");
  });

  it("can return to the template step without losing the selection", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Blank scene/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Blank scene/ }).getAttribute("aria-pressed")).toBe("true");
  });
});
