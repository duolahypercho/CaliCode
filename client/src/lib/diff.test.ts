import { describe, expect, it } from "vitest";
import { collapseContext, diffLines } from "./diff";

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const result = diffLines("a\nb\nc", "a\nb\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.rows.every((row) => row.type === "context")).toBe(true);
  });

  it("counts an inserted line", () => {
    const result = diffLines("a\nc", "a\nb\nc");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    const added = result.rows.find((row) => row.type === "added");
    expect(added?.text).toBe("b");
    expect(added?.oldLine).toBeNull();
    expect(added?.newLine).toBe(2);
  });

  it("counts a deleted line", () => {
    const result = diffLines("a\nb\nc", "a\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.rows.find((row) => row.type === "removed")?.text).toBe("b");
  });

  it("treats a modified line as one removal plus one addition", () => {
    const result = diffLines("const x = 1;", "const x = 2;");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("numbers old and new sides independently", () => {
    const result = diffLines("a\nb\nc", "a\nX\nY\nc");
    const contexts = result.rows.filter((row) => row.type === "context");
    expect(contexts[0]).toMatchObject({ oldLine: 1, newLine: 1, text: "a" });
    expect(contexts.at(-1)).toMatchObject({ oldLine: 3, newLine: 4, text: "c" });
  });

  it("handles empty sides", () => {
    expect(diffLines("", "a\nb").added).toBe(2);
    expect(diffLines("a\nb", "").removed).toBe(2);
    expect(diffLines("", "").rows).toHaveLength(0);
  });

  it("normalises CRLF so a line-ending change is not a whole-file rewrite", () => {
    const result = diffLines("a\r\nb", "a\nb");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("degrades to whole-file replace rather than hanging on huge inputs", () => {
    const before = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 2500 }, (_, i) => `line ${i} edited`).join("\n");
    const started = performance.now();
    const result = diffLines(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.added + result.removed).toBeGreaterThan(0);
  });
});

describe("collapseContext", () => {
  it("keeps only lines near a change", () => {
    const rows = diffLines(
      Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
      Array.from({ length: 40 }, (_, i) => (i === 20 ? "changed" : `line ${i}`)).join("\n"),
    ).rows;

    const collapsed = collapseContext(rows, 2);
    expect(collapsed.length).toBeLessThan(rows.length);
    expect(collapsed.some((row) => row.text === "changed")).toBe(true);
    expect(collapsed.some((row) => row.text === "line 0")).toBe(false);
  });

  it("returns nothing when there are no changes", () => {
    const rows = diffLines("a\nb", "a\nb").rows;
    expect(collapseContext(rows)).toHaveLength(0);
  });
});
