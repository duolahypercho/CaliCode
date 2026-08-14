import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_CHECKPOINT_INTERVAL_MS,
  AUTO_CHECKPOINT_KEEP,
  checkpointTakenAtMs,
  clearAutoCheckpoints,
  dueForCheckpoint,
  formatCheckpointAge,
  formatCheckpointList,
  parseRestoreArgs,
  readAutoCheckpoints,
  recordAutoCheckpoint,
  restoreWarning,
  type AutoCheckpoint,
} from "./checkpoints";

function entry(index: number): AutoCheckpoint {
  return {
    id: `cp-${1_700_000_000_000 + index}`,
    takenAtMs: 1_700_000_000_000 + index,
    reason: "loop",
    objective: "polish the game",
  };
}

beforeEach(clearAutoCheckpoints);

describe("the automatic checkpoint registry", () => {
  it("forgets the oldest ids once retention is reached", () => {
    for (let index = 1; index <= AUTO_CHECKPOINT_KEEP + 5; index += 1) {
      recordAutoCheckpoint("demo", entry(index));
    }
    const kept = readAutoCheckpoints("demo");

    expect(kept).toHaveLength(AUTO_CHECKPOINT_KEEP);
    expect(kept[0].id).toBe(entry(AUTO_CHECKPOINT_KEEP + 5).id);
    expect(kept.map((item) => item.id)).not.toContain(entry(1).id);
  });

  it("keeps games apart", () => {
    recordAutoCheckpoint("demo", entry(1));
    recordAutoCheckpoint("other", entry(2));

    expect(readAutoCheckpoints("demo").map((item) => item.id)).toEqual([entry(1).id]);
    expect(readAutoCheckpoints("other").map((item) => item.id)).toEqual([entry(2).id]);
  });

  it("survives a corrupt store rather than throwing into a run", () => {
    localStorage.setItem("calicode-auto-checkpoints", "{ not json");
    expect(readAutoCheckpoints("demo")).toEqual([]);

    localStorage.setItem("calicode-auto-checkpoints", JSON.stringify({ demo: [{ id: 7 }, entry(1)] }));
    expect(readAutoCheckpoints("demo").map((item) => item.id)).toEqual([entry(1).id]);
  });
});

describe("throttling", () => {
  it("always allows the first checkpoint of a run", () => {
    expect(dueForCheckpoint(null, 1_700_000_000_000)).toBe(true);
  });

  it("suppresses a second checkpoint inside the window and allows one after it", () => {
    const last = 1_700_000_000_000;
    expect(dueForCheckpoint(last, last + AUTO_CHECKPOINT_INTERVAL_MS - 1)).toBe(false);
    expect(dueForCheckpoint(last, last + AUTO_CHECKPOINT_INTERVAL_MS)).toBe(true);
  });
});

describe("checkpoint ids", () => {
  it("reads the timestamp core minted into the id, including the collision suffix", () => {
    expect(checkpointTakenAtMs("cp-1700000000000")).toBe(1_700_000_000_000);
    expect(checkpointTakenAtMs("cp-1700000000000-3")).toBe(1_700_000_000_000);
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
  it("names each id with its age and the run it guarded", () => {
    const now = 1_700_000_000_000;
    const text = formatCheckpointList(
      [
        { id: "cp-a", takenAtMs: now - 5 * 60_000, reason: "loop", objective: "polish the game" },
        { id: "cp-b", takenAtMs: now - 3 * 3_600_000, reason: "goal", objective: "make the tests pass" },
      ],
      now,
    );

    expect(text).toContain("cp-a — 5m ago, before a /loop turn (polish the game)");
    expect(text).toContain("cp-b — 3h ago, before a /goal turn (make the tests pass)");
    expect(text).toContain("/restore <id> confirm");
  });
});

describe("restoreWarning", () => {
  it("tells a git restore point apart from a project copy", () => {
    // The two mechanisms cover opposite halves of the game, so naming the
    // wrong one is how someone approves a rollback that does not do what the
    // confirmation just described.
    const git = restoreWarning("cp-git-1", "2m ago", true, "git");
    expect(git).toContain("tracked files");
    expect(git).toContain("HEAD and your branch do not move");
    expect(git).toContain("does NOT restore untracked files");
    // A git restore point says nothing about the CaliCode project document.
    expect(git).toContain("project.json");

    const copy = restoreWarning("cp-1700000000000", "2m ago", true, "project");
    expect(copy).toContain("will overwrite this game's project.json");
    expect(copy).toContain("does NOT restore the attached workspace folder");
    expect(copy).not.toContain("HEAD");
  });

  it("defaults to the more conservative project wording", () => {
    // An unreachable core must not promise the workspace came back.
    expect(restoreWarning("cp-1", null, true)).toContain("does NOT restore the attached workspace folder");
  });

  it("always ends by naming the confirm step", () => {
    for (const kind of ["git", "project"] as const) {
      expect(restoreWarning("cp-x", null, true, kind)).toContain("/restore cp-x confirm");
    }
  });
});
