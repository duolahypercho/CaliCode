import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Textarea } from "./textarea";

const srcDir = resolve(process.cwd(), "src");

const css = readFileSync(join(srcDir, "index.css"), "utf8");

/** Every hand-written file in the app, App.tsx and index.css included — no
 *  exemptions. A guard that skips the files it found offending is not a guard. */
function sourceFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extensions);
    if (!entry.isFile() || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/** Markup only — the two tests that read JSX (`role="…"`, `tabIndex={-1}`) would be
 *  fooled by CSS that mentions the same strings, so they stay on .tsx. */
const allSources = sourceFiles(srcDir, [".tsx"]);

/** Everything a suppressor could hide in. A className string lives just as happily
 *  in a .ts helper (a shared `const styles = "…"`) or in a .css `@apply`, and the
 *  earlier .tsx-only walk let both through. Test files are excluded because this
 *  very file spells both utilities out to assert on them; nothing they contain
 *  ships to a browser. */
const styleSources = sourceFiles(srcDir, [".tsx", ".ts", ".css"]);

/** CSS comments are inert — index.css names both suppressor spellings in the prose
 *  explaining why they are forbidden. Strip them before scanning for the real thing. */
const scannable = (path: string): string => {
  const source = readFileSync(path, "utf8");
  return path.endsWith(".css") ? source.replace(/\/\*[\s\S]*?\*\//g, "") : source;
};

afterEach(cleanup);

describe("focus ring", () => {
  it("draws no focus outline at all — the product decision this file guards", () => {
    // Rings were removed deliberately: hover tints, active fills and selected
    // backgrounds carry the affordance. Restoring one is a product change, so
    // it should break here first rather than reappear by accident.
    expect(css).not.toMatch(/outline:\s*2px solid/);
    expect(css).not.toMatch(/--focus-ring\s*:/);
    expect(css).toMatch(/\.focus-ring:focus-visible[\s\S]*?outline: none;/);
  });

  it("suppresses the outline in exactly one place, so there is one thing to undo", () => {
    const suppressions = css.match(/outline: none/g) ?? [];
    expect(suppressions).toHaveLength(1);
    expect(css).toMatch(/\[data-no-focus-ring\]:focus-visible\s*\{\s*outline: none;/);
  });

  it("keeps the ring unlayered, which is what beats a *normal* Tailwind utility", () => {
    // Layer order is compared before specificity, and Tailwind v4 emits every
    // utility inside `@layer utilities`. An unlayered rule outranks all of
    // them; move this block into an `@layer` and `focus-visible:outline-none`
    // starts winning again. Guard the property, not the prose.
    //
    // Being unlayered is NOT immunity: an `!important` author declaration wins
    // across every layer, unlayered included, so `focus-visible:!outline-none`
    // suppresses this ring no matter where the block sits. The scan below is
    // what covers that case; this one only pins the layer.
    const ring = css.indexOf(".focus-ring:focus-visible");
    expect(ring).toBeGreaterThan(-1);

    // Walk the braces before the rule: if any are still open, it is nested in
    // an at-rule (a layer, a media query) rather than sitting at the top level.
    const preceding = css.slice(0, ring);
    const depth = (preceding.match(/\{/g) ?? []).length - (preceding.match(/\}/g) ?? []).length;
    expect(depth, "the shared focus ring must stay at the top level, outside @layer").toBe(0);
  });

  it("has no `focus-visible:outline-none` in any .tsx, .ts or .css under src/", () => {
    // Both spellings, every file type that can carry a class name. The plain
    // utility is inert only while the block above stays unlayered; the
    // `!important` spelling (`!outline-none`) beats it outright and blinds the
    // control today.
    expect(styleSources.length).toBeGreaterThan(20);
    expect(styleSources.some((path) => path.endsWith("/App.tsx")), "the walk must reach src/App.tsx").toBe(true);
    expect(styleSources.some((path) => path.endsWith("/index.css")), "the walk must reach src/index.css").toBe(true);
    expect(
      styleSources.filter((path) => path.endsWith(".ts")).length,
      "the walk must reach plain .ts modules, where a shared className string can live",
    ).toBeGreaterThan(0);

    const offenders = styleSources.filter((path) => /focus-visible:!?outline-none/.test(scannable(path)));

    expect(offenders.map((path) => relative(process.cwd(), path))).toEqual([]);
  });

  it("suppresses the ring in no stylesheet but the one sanctioned opt-out", () => {
    // The utility spelling above is only half of it: a stylesheet can write the
    // declaration directly. `[data-no-focus-ring]` is the one blessed opt-out
    // (pinned to a single occurrence by the test above), so drop that rule and
    // nothing else may turn an outline off.
    const offenders = styleSources
      .filter((path) => path.endsWith(".css"))
      .filter((path) =>
        /outline:\s*(none|0)\b/.test(scannable(path).replace(/\[data-no-focus-ring\][^{]*\{[^}]*\}/g, "")),
      );

    expect(offenders.map((path) => relative(process.cwd(), path))).toEqual([]);
  });

  it("draws one indicator per control — never a Tailwind ring beside the app outline", () => {
    // The shared outline covers buttons, inputs and the rest on its own, so a
    // `focus-visible:ring-*` utility on such an element stacks a second, differently
    // coloured indicator on the same node. Controls inside a clipping scroller take
    // `focus-ring-inset` instead — same outline, drawn inside the box.
    const offenders = styleSources.filter((path) => /\bfocus(-visible)?:!?ring-/.test(scannable(path)));

    expect(offenders.map((path) => relative(process.cwd(), path))).toEqual([]);
  });

  it("leaves no outline-offset behind, which would only nudge a ring nothing draws", () => {
    expect(css).not.toMatch(/outline-offset/);
  });

  it("styles no ARIA role the app never renders", () => {
    // A rule for a role nothing carries is dead weight that reads as coverage.
    const markup = allSources.map((path) => readFileSync(path, "utf8")).join("\n");
    for (const role of ["menuitemcheckbox", "menuitemradio"]) {
      if (markup.includes(role)) continue;
      expect(css, `index.css styles [role="${role}"], which src/ never renders`).not.toContain(role);
    }
  });

  it("keeps .focus-ring-inset resolving, so the files spelling it stay honest", () => {
    // The class survives as an inert hook rather than being edited out of
    // every consumer; it must still land in the suppression rule, not dangle.
    expect(css).toMatch(/\.focus-ring-inset:focus-visible[\s\S]*?outline: none;/);
  });

  it("gives every focus-ring-inset target a rule that reaches it", () => {
    // tabindex="-1" nodes are outside the shared selector list, so the class
    // has to stand alone — asserted above. Here: no such node may lean on the
    // shared rule by also carrying plain `focus-ring`.
    for (const path of allSources) {
      const source = readFileSync(path, "utf8");
      if (!/tabIndex=\{-1\}/.test(source)) continue;
      for (const [, className] of source.matchAll(/className="([^"]*focus-ring[^"]*)"/g)) {
        expect(
          className.split(/\s+/).includes("focus-ring-inset"),
          `${relative(process.cwd(), path)}: a tabindex="-1" node may only use focus-ring-inset, which draws its own ring`,
        ).toBe(true);
      }
    }
  });

  it.each([
    ["button", () => render(<Button>Go</Button>), () => screen.getByRole("button", { name: "Go" })],
    ["input", () => render(<Input aria-label="Name" />), () => screen.getByLabelText("Name")],
    ["textarea", () => render(<Textarea aria-label="Notes" />), () => screen.getByLabelText("Notes")],
    [
      "select trigger",
      () =>
        render(
          <Select>
            <SelectTrigger aria-label="Model">
              <SelectValue placeholder="Pick" />
            </SelectTrigger>
          </Select>,
        ),
      () => screen.getByRole("combobox", { name: "Model" }),
    ],
    [
      "tab",
      () =>
        render(
          <Tabs defaultValue="one">
            <TabsList>
              <TabsTrigger value="one">One</TabsTrigger>
            </TabsList>
          </Tabs>,
        ),
      () => screen.getByRole("tab", { name: "One" }),
    ],
    [
      "dialog close",
      () =>
        render(
          <Dialog open>
            <DialogContent>
              <DialogTitle>Title</DialogTitle>
            </DialogContent>
          </Dialog>,
        ),
      () => screen.getByRole("button", { name: "Close" }),
    ],
  ])("carries the shared ring on the %s primitive", (_name, mount, find) => {
    mount();
    const className = find().getAttribute("class") ?? "";

    expect(className.split(" ")).toContain("focus-ring");
    expect(className).not.toContain("outline-none");
  });
});
