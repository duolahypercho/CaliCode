import { describe, expect, it } from "vitest";
import {
  checkpointTakenAtMs,
  formatCheckpointAge,
  formatCheckpointList,
  parseRestoreArgs,
  restoreWarning,
} from "./checkpoints";

describe("checkpoint ids", () => {
  it("reads timestamps from project and git ids, including collision suffixes", () => {
    expect(checkpointTakenAtMs("cp-1700000000000")).toBe(1_700_000_000_000);
    expect(checkpointTakenAtMs("git-1700000000000-3")).toBe(1_700_000_000_000);
  });

  it("refuses to invent an age for an id it cannot read", () => {
    expect(checkpointTakenAtMs("checkpoint-1")).toBeNull();
    expect(checkpointTakenAtMs("cp-abc")).toBeNull();
  });

  it("formats ages by the coarsest useful unit", () => {
    expect(formatCheckpointAge(5_000)).toBe("just now");
    expect(formatCheckpointAge(12 * 60_000)).toBe("12m ago");
    expect(formatCheckpointAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatCheckpointAge(50 * 3_600_000)).toBe("2d ago");
  });
});

describe("/restore arguments", () => {
  it("treats a bare id as unconfirmed and `confirm` as the go-ahead", () => {
    expect(parseRestoreArgs(" cp-1 ")).toEqual({ id: "cp-1", confirmed: false });
    expect(parseRestoreArgs("cp-1 confirm")).toEqual({ id: "cp-1", confirmed: true });
    expect(parseRestoreArgs("cp-1 CONFIRM")).toEqual({ id: "cp-1", confirmed: true });
  });

  it("rejects anything it would have to guess at", () => {
    expect(parseRestoreArgs("")).toBeNull();
    expect(parseRestoreArgs("cp-1 yes")).toBeNull();
    expect(parseRestoreArgs("cp-1 confirm now")).toBeNull();
  });
});

describe("the /checkpoints listing", () => {
  it("names each core-owned restore point with its age and kind", () => {
    const now = 1_700_000_000_000;
    const text = formatCheckpointList(
      [
        { id: "git-a", createdAtMs: now - 5 * 60_000, kind: "git" },
        { id: "cp-b", createdAtMs: now - 3 * 3_600_000, kind: "project" },
      ],
      now,
    );

    expect(text).toContain("git-a — 5m ago, git snapshot");
    expect(text).toContain("cp-b — 3h ago, project snapshot");
    expect(text).toContain("/restore <id> confirm");
  });

  it("explains when the core inventory is empty", () => {
    expect(formatCheckpointList([], Date.now())).toContain("A /loop takes one before its first iteration");
  });
});

describe("restoreWarning", () => {
  it("tells a git restore point apart from a project copy", () => {
    const git = restoreWarning("cp-git-1", "2m ago", true, "git");
    expect(git).toContain("tracked files");
    expect(git).toContain("HEAD and your branch do not move");
    expect(git).toContain("does NOT restore untracked files");
    expect(git).toContain("project.json");

    const copy = restoreWarning("cp-1700000000000", "2m ago", true, "project");
    expect(copy).toContain("will overwrite this game's project.json");
    expect(copy).toContain("does NOT restore the attached workspace folder");
    expect(copy).not.toContain("HEAD");
  });

  it("defaults to the more conservative project wording", () => {
    expect(restoreWarning("cp-1", null, true)).toContain("does NOT restore the attached workspace folder");
  });

  it("always ends by naming the confirm step", () => {
    for (const kind of ["git", "project"] as const) {
      expect(restoreWarning("cp-x", null, true, kind)).toContain("/restore cp-x confirm");
    }
  });
});
