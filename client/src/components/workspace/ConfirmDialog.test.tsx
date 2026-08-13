import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

/**
 * The shape both callers have: a trigger that is destroyed by the very action
 * it confirms, next to a container that outlives it.
 */
function Harness() {
  const panelRef = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <div ref={panelRef} tabIndex={-1} data-testid="panel">
      {removed ? (
        <p>Nothing selected.</p>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Remove drone-1
        </button>
      )}
      <ConfirmDialog
        open={open}
        title="Remove drone-1?"
        description="Nothing in the scene uses it. This cannot be undone."
        confirmLabel="Remove asset"
        onConfirm={() => {
          setOpen(false);
          setRemoved(true);
        }}
        onOpenChange={setOpen}
        returnFocusRef={panelRef}
      />
    </div>
  );
}

function openFromTrigger() {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Remove drone-1" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe("ConfirmDialog focus return", () => {
  it("names the dialog so it does not announce as an unnamed dialog", async () => {
    openFromTrigger();

    expect(await screen.findByRole("dialog", { name: "Remove drone-1?" })).toBeTruthy();
  });

  it("returns focus to the trigger when the action is cancelled", async () => {
    const trigger = openFromTrigger();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("returns focus to the surviving container when confirming destroys the trigger", async () => {
    const trigger = openFromTrigger();

    fireEvent.click(await screen.findByRole("button", { name: "Remove asset" }));

    expect(trigger.isConnected).toBe(false);
    // Radix would hand focus back to a DialogTrigger; this dialog is opened
    // from state, so without the fallback focus lands on <body> and a keyboard
    // user restarts at the top of the document.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("panel")));
    expect(document.activeElement).not.toBe(document.body);
  });
});
