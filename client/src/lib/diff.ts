export type DiffRowType = "context" | "added" | "removed";

export interface DiffRow {
  type: DiffRowType;
  /** Line number in the baseline, null for added rows. */
  oldLine: number | null;
  /** Line number in the current text, null for removed rows. */
  newLine: number | null;
  text: string;
}

export interface DiffSummary {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/**
 * Line diff over the longest common subsequence.
 *
 * The CODE tab shows what the agent actually changed, so the counts have to
 * be real: a "+42 −6" badge that is not derived from the text is exactly the
 * kind of decorative UI this editor already had too much of.
 */
export function diffLines(baseline: string, current: string): DiffSummary {
  const before = splitLines(baseline);
  const after = splitLines(current);
  const table = lcsTable(before, after);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ type: "context", oldLine: i + 1, newLine: j + 1, text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: "removed", oldLine: i + 1, newLine: null, text: before[i] });
      i += 1;
    } else {
      rows.push({ type: "added", oldLine: null, newLine: j + 1, text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) {
    rows.push({ type: "removed", oldLine: i + 1, newLine: null, text: before[i] });
    i += 1;
  }
  while (j < after.length) {
    rows.push({ type: "added", oldLine: null, newLine: j + 1, text: after[j] });
    j += 1;
  }

  return {
    rows,
    added: rows.filter((row) => row.type === "added").length,
    removed: rows.filter((row) => row.type === "removed").length,
  };
}

/** Collapses long runs of unchanged lines, keeping `padding` on each side. */
export function collapseContext(rows: DiffRow[], padding = 3): DiffRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.type === "context") return;
    for (let offset = -padding; offset <= padding; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < rows.length) keep.add(target);
    }
  });
  if (keep.size === 0) return [];
  return rows.filter((_, index) => keep.has(index));
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * LCS lengths. Capped because this runs on every keystroke in the editor and
 * the table is O(n*m) — beyond the cap the diff degrades to whole-file
 * replace rather than freezing the UI.
 */
const MAX_LINES = 2000;

function lcsTable(before: string[], after: string[]): number[][] {
  if (before.length > MAX_LINES || after.length > MAX_LINES) {
    // Degenerate table: forces a full replace rather than an O(4M) walk.
    return Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  }
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}
