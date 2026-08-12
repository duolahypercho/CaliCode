import { describe, expect, it } from "vitest";
import { isSafeReportPath, preferredLoopReport, type LoopReportSummary } from "./loopReports";

const summary = (loopId: string, status: LoopReportSummary["status"]): LoopReportSummary => ({
  loopId,
  objective: loopId,
  status,
  startedAtMs: 1,
  updatedAtMs: 1,
  totals: {
    iterations: 0,
    workedDurationMs: 0,
    elapsedDurationMs: 0,
    agents: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksSkipped: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  },
});

describe("loop report helpers", () => {
  it("prefers an active report over a newer terminal report", () => {
    expect(preferredLoopReport([summary("newest", "completed"), summary("active", "running")])?.loopId).toBe(
      "active",
    );
    expect(preferredLoopReport([summary("newest", "completed")])?.loopId).toBe("newest");
  });

  it("accepts project-relative report paths and rejects unsafe paths", () => {
    expect(isSafeReportPath("reports/loops/loop-1/report.json")).toBe(true);
    expect(isSafeReportPath("evidence/frame 001.png")).toBe(true);
    for (const path of ["../report.json", "reports/../secret", "/tmp/report", "C:\\report", "report?raw=1", ""]) {
      expect(isSafeReportPath(path)).toBe(false);
    }
  });
});

