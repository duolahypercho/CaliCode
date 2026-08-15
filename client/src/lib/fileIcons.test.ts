import { describe, expect, it } from "vitest";
import { fileGlyph, folderGlyph, toneClass } from "./fileIcons";

describe("fileGlyph", () => {
  it("tints by extension, case-insensitively", () => {
    expect(fileGlyph("App.tsx").tone).toBe("blue");
    expect(fileGlyph("MAIN.JS").tone).toBe("yellow");
    expect(fileGlyph("browser.rs").tone).toBe("orange");
  });

  it("lets a whole-name match beat the extension", () => {
    // Both end in .json, and only one of them is a manifest.
    expect(fileGlyph("package.json").Icon).not.toBe(fileGlyph("tsconfig.json").Icon);
    expect(fileGlyph("pnpm-lock.yaml").Icon).toBe(fileGlyph("Cargo.lock").Icon);
  });

  it("reads a dotfile as a name, not as an extension", () => {
    // ".gitignore" must not resolve through the "gitignore" extension table,
    // and an unknown dotfile falls back rather than borrowing a tint.
    expect(fileGlyph(".gitignore").tone).toBe("orange");
    expect(fileGlyph(".unknownrc").tone).toBe("muted");
  });

  it("falls back for anything unrecognised", () => {
    expect(fileGlyph("notes").tone).toBe("muted");
    expect(fileGlyph("blob.qqq").tone).toBe("muted");
  });

  it("opens the folder icon only when expanded", () => {
    expect(folderGlyph(true).Icon).not.toBe(folderGlyph(false).Icon);
  });

  it("maps every tone to a token class", () => {
    expect(toneClass(fileGlyph("hero.png").tone)).toBe("text-file-purple");
    expect(toneClass(fileGlyph("notes").tone)).toBe("text-ink-faint");
  });
});
