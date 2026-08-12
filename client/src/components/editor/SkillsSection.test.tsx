import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/extensions", () => ({
  listSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
}));

import { listSkills, setSkillEnabled, type SkillInfo } from "../../lib/extensions";
import { SkillsSection } from "./SkillsSection";

const mockList = vi.mocked(listSkills);
const mockSet = vi.mocked(setSkillEnabled);

const skill = (patch: Partial<SkillInfo>): SkillInfo => ({
  name: "blockout-standards",
  description: "How to build blockout geometry",
  scope: "global",
  path: "/home/u/.cali/skills/blockout-standards.md",
  enabled: true,
  ...patch,
});

afterEach(cleanup);
beforeEach(() => {
  mockList.mockReset();
  mockSet.mockReset();
});

describe("SkillsSection", () => {
  it("lists skills with scope badges and toggles one through skill_set_enabled", async () => {
    mockList.mockResolvedValue([
      skill({}),
      skill({ name: "enemy-ai", scope: "project", enabled: false, description: "AI patterns" }),
    ]);
    mockSet.mockResolvedValue(undefined);

    render(<SkillsSection projectSlug="demo" />);
    expect(await screen.findByText("blockout-standards")).toBeTruthy();
    expect(mockList).toHaveBeenCalledWith("demo");
    expect(screen.getByText("global")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Enable skill enemy-ai"));
    expect(mockSet).toHaveBeenCalledWith("project", "enemy-ai", true);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("disables the toggle and shows the message for a broken skill", async () => {
    mockList.mockResolvedValue([skill({ name: "broken", error: "missing frontmatter", enabled: false })]);
    render(<SkillsSection />);

    expect(await screen.findByText("missing frontmatter")).toBeTruthy();
    const toggle = screen.getByLabelText("Enable skill broken") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(mockList).toHaveBeenCalledWith(undefined);
  });

  it("shows the watched paths when no skills exist", async () => {
    mockList.mockResolvedValue([]);
    render(<SkillsSection />);
    expect(await screen.findByText("~/.cali/skills/*.md")).toBeTruthy();
  });

  it("surfaces listing failures", async () => {
    mockList.mockRejectedValue(new Error("core offline"));
    render(<SkillsSection />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "core offline");
  });
});
