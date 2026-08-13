import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestResult } from "../../lib/types";
import { TestTab } from "./TestTab";

afterEach(cleanup);

const results: TestResult[] = [
  { id: "t1", name: "Player spawns", pass: false, logs: [], error: "TypeError: undefined" },
  { id: "t2", name: "Arena renders", pass: false, logs: [], baselineDistance: 12 },
  { id: "t3", name: "Score ticks", pass: false, logs: [] },
];

function renderTab() {
  return render(
    <TestTab results={results} frames={[]} running={false} canRun onRun={vi.fn()} onFixAll={vi.fn()} />,
  );
}

/** Severity has to survive a theme swap, so the tint is a token reference, not a baked hex. */
describe("TestTab severity tint", () => {
  const tint = (label: string) => (screen.getByText(label) as HTMLElement).style.color;

  it("colours each severity from the theme token ramp", () => {
    renderTab();
    expect(tint("HIGH")).toBe("var(--danger-soft)");
    expect(tint("MED")).toBe("var(--ink)");
    expect(tint("LOW")).toBe("var(--ink-subtle)");
  });

  it("gives HIGH a tint distinct from the two it outranks", () => {
    renderTab();
    expect(tint("HIGH")).not.toBe(tint("MED"));
    expect(tint("HIGH")).not.toBe(tint("LOW"));
    expect(tint("MED")).not.toBe(tint("LOW"));
  });

  it("carries the tint onto the card's left rule", () => {
    renderTab();
    const card = screen.getByText("Player spawns").closest("div.rounded-lg") as HTMLElement | null;
    expect(card?.style.borderLeftColor).toBe("var(--danger-soft)");
  });
});
