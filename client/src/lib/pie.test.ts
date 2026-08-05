import { describe, expect, it } from "vitest";
import { shouldCaptureFrame } from "./pie";

describe("frame capture cadence", () => {
  it("captures every 3rd frame", () => {
    expect(shouldCaptureFrame(3, 3)).toBe(true);
    expect(shouldCaptureFrame(6, 3)).toBe(true);
    expect(shouldCaptureFrame(4, 3)).toBe(false);
  });

  it("captures every 4th frame", () => {
    expect(shouldCaptureFrame(4, 4)).toBe(true);
    expect(shouldCaptureFrame(8, 4)).toBe(true);
    expect(shouldCaptureFrame(3, 4)).toBe(false);
  });
});

