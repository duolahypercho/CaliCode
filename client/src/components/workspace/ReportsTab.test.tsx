import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopReport, LoopReportSummary, OpenLoopReport } from "../../lib/loopReports";
import { ReportsTab, summaryLabel } from "./ReportsTab";

const { mockList, mockOpen } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockOpen: vi.fn(),
}));

vi.mock("../../lib/loopReports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/loopReports")>();
  return { ...actual, listLoopReports: mockList, openLoopReport: mockOpen };
});

const totals = {
  iterations: 1,
  workedDurationMs: 65_000,
  elapsedDurationMs: 80_000,
  agents: 1,
  checksPassed: 1,
  checksFailed: 1,
  checksSkipped: 0,
  filesChanged: 1,
  additions: 41,
  deletions: 7,
  latestScorePercent: 82,
};

function summary(status: LoopReport["status"]): LoopReportSummary {
  return {
    loopId: "loop-1",
    objective: "Polish the arena loop",
    status,
    startedAtMs: 1_786_406_400_000,
    updatedAtMs: 1_786_406_480_000,
    totals,
  };
}

function opened(status: LoopReport["status"]): OpenLoopReport {
  return {
    projectRoot: "/project",
    jsonPath: "reports/loops/loop-1/report.json",
    markdownPath: "reports/loops/loop-1/report.md",
    htmlPath: "reports/loops/loop-1/report.html",
    report: {
      schemaVersion: 1,
      projectSlug: "demo",
      loopId: "loop-1",
      objective: "Polish the arena loop",
      status,
      createdAtMs: 1_786_406_400_000,
      updatedAtMs: 1_786_406_480_000,
      startedAtMs: 1_786_406_400_000,
      completedAtMs: status === "running" ? null : 1_786_406_480_000,
      summary: "The combat loop is playable. Telegraphs still need polish.",
      punchList: [],
      nextIterationMemory: { observations: [], decisions: [], risks: [], nextActions: [] },
      totals,
      iterations: [
        {
          iteration: 1,
          startedAtMs: 1_786_406_401_000,
          completedAtMs: 1_786_406_466_000,
          durationMs: 65_000,
          outcome: "needs-work",
          summary: "Core movement works. Increase the dodge cue.",
          agents: [
            {
              role: "gameplay-engineer",
              agentId: "agent-1",
              task: "Build the encounter",
              outcome: "passed",
              summary: "Movement and combat are wired.",
              durationMs: 60_000,
            },
          ],
          checks: [
            {
              kind: "build",
              name: "Production build",
              command: "pnpm build",
              status: "passed",
              durationMs: 4_200,
              details: "No warnings",
            },
          ],
          changedFiles: [{ path: "src/player.ts", additions: 41, deletions: 7 }],
          evidence: [
            {
              kind: "screenshot",
              path: "evidence/frame.png",
              caption: "Arena after the first wave",
              capturedAtMs: 1_786_406_430_000,
            },
          ],
          scores: [
            {
              criterion: "Combat readability",
              score: 82,
              maximum: 100,
              passThreshold: 90,
              rationale: "Telegraphs need another pass.",
            },
          ],
          punchList: [{ priority: "high", item: "Increase the dodge cue", source: "critic", resolved: false }],
          nextIterationMemory: {
            observations: ["Players miss the wind-up."],
            decisions: [],
            risks: ["More particles could hurt frame time."],
            nextActions: ["Tune the cue, then replay."],
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockOpen.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ReportsTab", () => {
  it("renders an empty state when the project has no reports", async () => {
    mockList.mockResolvedValue({ reports: [] });
    render(<ReportsTab projectSlug="demo" coreStatus="ready" canOpenFiles={false} onOpenFile={() => {}} />);

    expect(await screen.findByText("No loop reports yet")).toBeTruthy();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("renders structured report evidence and opens safe workspace files", async () => {
    mockList.mockResolvedValue({ reports: [summary("completed")] });
    mockOpen.mockResolvedValue(opened("completed"));
    const onOpenFile = vi.fn();
    render(
      <ReportsTab
        projectSlug="demo"
        coreStatus="ready"
        canOpenFiles
        workspaceRoot="/workspace"
        onOpenFile={onOpenFile}
      />,
    );

    expect(await screen.findByText("Polish the arena loop")).toBeTruthy();
    expect(screen.getByText("Combat readability")).toBeTruthy();
    expect(screen.getByText("Production build")).toBeTruthy();
    expect(screen.getByText("gameplay-engineer")).toBeTruthy();
    expect(screen.getByText("Arena after the first wave")).toBeTruthy();
    expect(screen.getByText("Tune the cue, then replay.")).toBeTruthy();

    // A cited frame shows as the frame, not just its filename — that is the
    // reason to read a loop report inside the editor at all.
    const frame = screen.getByRole("img", { name: "Arena after the first wave" });
    expect(frame.getAttribute("src")).toBe("/projects/demo/evidence/frame.png");

    fireEvent.click(screen.getByRole("button", { name: /player\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("src/player.ts");
    expect(screen.getByRole("button", { name: /report\.json/ }).hasAttribute("disabled")).toBe(true);
  });

  it("labels each past loop with when it ran and how far it got", () => {
    // Two soak days on the same objective are indistinguishable without the
    // date and the totals — which is the whole point of a multi-day report list.
    const label = summaryLabel({
      loopId: "loop-1",
      objective: "Neon arena slice",
      status: "completed",
      startedAtMs: Date.UTC(2026, 7, 12, 18, 0),
      updatedAtMs: Date.UTC(2026, 7, 12, 19, 0),
      totals: {
        iterations: 3, workedDurationMs: 0, elapsedDurationMs: 0, agents: 6,
        checksPassed: 9, checksFailed: 0, checksSkipped: 0,
        filesChanged: 4, additions: 120, deletions: 8, latestScorePercent: 95,
      },
    });

    expect(label).toContain("95%");
    expect(label).toContain("Neon arena slice");
    expect(label).toContain("3 iter");
    expect(label).toContain("4 files");
    expect(label).toMatch(/Aug\s*1[23]/);
  });

  it("shows no tile for evidence that is not a displayable image", async () => {
    const report = opened("completed");
    report.report.iterations[0].evidence = [
      { kind: "log", path: "evidence/run.log", caption: "Console output" },
      { kind: "screenshot", path: "../secrets/frame.png", caption: "Traversal attempt" },
    ];
    mockList.mockResolvedValue({ reports: [summary("completed")] });
    mockOpen.mockResolvedValue(report);
    render(<ReportsTab projectSlug="demo" coreStatus="ready" canOpenFiles onOpenFile={() => {}} />);

    expect(await screen.findByText("Console output")).toBeTruthy();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("polls a running report and stops after it completes", async () => {
    vi.useFakeTimers();
    mockList
      .mockResolvedValueOnce({ reports: [summary("running")] })
      .mockResolvedValueOnce({ reports: [summary("completed")] });
    mockOpen.mockResolvedValueOnce(opened("running")).mockResolvedValueOnce(opened("completed"));
    render(<ReportsTab projectSlug="demo" coreStatus="ready" canOpenFiles={false} onOpenFile={() => {}} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Live")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(mockList).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("does not request report data while core is offline", async () => {
    render(<ReportsTab projectSlug="demo" coreStatus="offline" canOpenFiles={false} onOpenFile={() => {}} />);

    expect(await screen.findByText("Reports are offline")).toBeTruthy();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("shows multi-hour worked totals in hours instead of unbounded minutes", async () => {
    const long = opened("completed");
    long.report.totals.workedDurationMs = 9_300_000;
    mockList.mockResolvedValue({ reports: [summary("completed")] });
    mockOpen.mockResolvedValue(long);

    render(<ReportsTab projectSlug="demo" coreStatus="ready" canOpenFiles={false} onOpenFile={() => {}} />);

    expect(await screen.findByText("2h 35m")).toBeTruthy();
  });
});
