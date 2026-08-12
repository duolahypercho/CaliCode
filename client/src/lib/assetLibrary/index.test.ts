import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import { assetRepos, attachRepo, attachedRepos, detachRepo, getRepo, setRepoSetting } from "./index";

const project: Project = {
  schemaVersion: 1,
  slug: "starter",
  title: "Starter",
  entities: [],
  scripts: [],
  assets: [],
  tests: [],
  settings: {},
};

describe("asset library registry", () => {
  it("has at least the VFX starter entry", () => {
    expect(getRepo("linear-ability-casting")?.category).toBe("vfx");
  });

  it("keeps ids unique and well-formed", () => {
    const ids = assetRepos.map((repo) => repo.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("gives every entry a URL and consistent setting defaults", () => {
    for (const repo of assetRepos) {
      expect(repo.url).toMatch(/^https:\/\//);
      const keys = repo.settings.map((setting) => setting.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const setting of repo.settings) {
        const expected = setting.type === "number" ? "number" : setting.type === "boolean" ? "boolean" : "string";
        expect(typeof setting.default).toBe(expected);
        if (setting.type === "select") expect(setting.options).toContain(setting.default);
      }
    }
  });
});

describe("repo attachments", () => {
  it("attaches with defaults, updates a setting, and detaches", () => {
    const attached = attachRepo(project, "linear-ability-casting");
    expect(attachedRepos(attached)["linear-ability-casting"].settings.impactGlow).toBe(true);

    const tuned = setRepoSetting(attached, "linear-ability-casting", "projectileSpeed", 30);
    expect(attachedRepos(tuned)["linear-ability-casting"].settings.projectileSpeed).toBe(30);
    // Other settings survive the update.
    expect(attachedRepos(tuned)["linear-ability-casting"].settings.impactGlow).toBe(true);

    const detached = detachRepo(tuned, "linear-ability-casting");
    expect(attachedRepos(detached)).toEqual({});
  });

  it("ignores unknown repos and leaves the project untouched", () => {
    expect(attachRepo(project, "no-such-repo")).toBe(project);
    expect(detachRepo(project, "no-such-repo")).toBe(project);
    expect(setRepoSetting(project, "no-such-repo", "x", 1)).toBe(project);
  });

  it("does not mutate the original project", () => {
    const attached = attachRepo(project, "linear-ability-casting");
    expect(attached).not.toBe(project);
    expect(project.settings).toEqual({});
    expect(attachedRepos(attached)["linear-ability-casting"]).toBeTruthy();
  });
});
