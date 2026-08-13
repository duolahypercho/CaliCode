import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

afterEach(cleanup);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

function renderDialog() {
  return render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Delete Player?</DialogTitle>
        <DialogDescription>It leaves the scene. This cannot be undone.</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
}

describe("dialog naming", () => {
  it("announces with the title as its accessible name", () => {
    renderDialog();

    // Fails against a plain <h2>: Radix only hands its generated id to
    // DialogPrimitive.Title, so aria-labelledby pointed at nothing and the
    // dialog announced as unnamed.
    expect(screen.getByRole("dialog", { name: "Delete Player?" })).toBeTruthy();
  });

  it("points aria-labelledby and aria-describedby at nodes that actually render", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");

    for (const attribute of ["aria-labelledby", "aria-describedby"] as const) {
      const id = dialog.getAttribute(attribute);
      expect(id, `${attribute} is missing`).toBeTruthy();
      expect(document.getElementById(id as string), `${attribute} is a dangling IDREF -> #${id}`).not.toBeNull();
    }

    expect(document.getElementById(dialog.getAttribute("aria-describedby") as string)?.textContent).toBe(
      "It leaves the scene. This cannot be undone.",
    );
  });

  it("keeps the heading and paragraph markup the styles assume", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Delete Player?" }).tagName).toBe("H2");
    expect(screen.getByText("It leaves the scene. This cannot be undone.").tagName).toBe("P");
  });

  it("is used by every dialog surface in the app", () => {
    // react-dialog 1.1.x ships WarningProvider as a pass-through, so it no
    // longer shouts about a missing title at runtime — a new unnamed dialog
    // would land silently. Check the source instead: any file that renders
    // dialog content must render a dialog title next to it.
    const offenders = sourceFiles(resolve(process.cwd(), "src"))
      .map((path) => [relative(process.cwd(), path), readFileSync(path, "utf8")] as const)
      .filter(([, source]) => /<Dialog(Primitive)?\.?Content[\s>]/.test(source))
      .filter(([, source]) => !/<Dialog(Primitive)?\.?Title[\s>]/.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
