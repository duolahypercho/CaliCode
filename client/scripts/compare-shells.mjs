/**
 * Surface-by-surface proof that the Electron shell renders the same editor as
 * a plain browser.
 *
 * Both shells load the identical React bundle from the identical Rust core over
 * HTTP, so any pixel difference is the shell's doing — a missing drag region, a
 * traffic-light inset that leaked into the wrong build, a font the OS webview
 * resolved differently. Eyeballing ten tabs twice does not catch that.
 *
 * Usage, from `client/`:
 *
 *   CALI_PORT=8799 npx electron dist-electron/main.js   # shell + core, in another terminal
 *   node scripts/compare-shells.mjs [--port=8799] [--out=.shell-compare] [--cdp=URL]
 *
 * The Electron side is reached over CDP (the shell exposes 9222); the browser
 * side is a fresh Playwright Chromium on core's own origin, which is what the
 * committed visual baselines render with.
 */

import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function opt(name, fallback) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const CORE_PORT = Number(opt("port", process.env.CALI_PORT ?? "8799"));
const CDP_URL = opt("cdp", process.env.CALI_CDP_URL ?? "http://127.0.0.1:9222");
const OUT_DIR = path.resolve(opt("out", process.env.CALI_SHELL_COMPARE_OUT ?? ".shell-compare"));
const BASE_URL = `http://127.0.0.1:${CORE_PORT}/`;

/** Matches the visual baselines, so a diff here is comparable with those. */
const VIEWPORT = { width: 1440, height: 900 };

/** App.tsx persists the active tab here; clearing it makes both sides start equal. */
const VIEW_KEY = "calicode-view";

const TABS = ["play", "code", "art", "build", "scene", "test", "terminal", "browser", "sidechat", "reports"];

/**
 * Absolute pixel budget. Set from measurement, not estimate.
 *
 * The two sides are different Chromium builds — Electron's bundled one against
 * Playwright's — and cross-build text antialiasing is the noise floor. That
 * floor was guessed at "a few hundred"; measured across all eleven surfaces it
 * is **2,666-3,023 differing pixels**, scattered over the whole frame (x
 * 21-1393, y 13-891) rather than clustered, which is the signature of text
 * rasterising differently rather than anything moving.
 *
 * So this budget cannot separate a small regression from that noise, and it is
 * dishonest to pretend otherwise: a clipped tab strip measured ~1,400 pixels in
 * `visual.spec.ts`, i.e. *below* the floor here. What this comparison reliably
 * catches is gross layout breakage — an element appearing, vanishing, or moving
 * — which shifts whole blocks and costs tens of thousands (a 300x60 element was
 * ~18,000). Anything subtler needs a human looking at the `.diff.png`, which is
 * why every run writes them.
 */
const MAX_DIFF_PIXELS = 6_000;

/** Coarse mode only: PNG byte size is a weak proxy for content, so allow slack. */
const MAX_COARSE_SIZE_DRIFT = 0.1;

/** Regions that differ for reasons other than the shell, and would drown the signal. */
function unstable(page) {
  return [
    // WebGL: GPU- and driver-dependent, and the PLAY scene animates.
    page.locator("canvas"),
    // fps, frame time, load time — new numbers every run.
    page.locator("[data-live-stats]"),
    page.locator("[data-active-model]"),
    // Project list contents depend on what is on disk, not on the shell.
    page.locator("[data-games-list]"),
    // The BROWSER tab paints remote pages into an <img>; whatever it loaded is
    // live content, not our chrome.
    page.locator("img"),
    // The window-controls row is the one place the shells are *supposed* to
    // differ: only a desktop shell reserves 72px for native traffic lights, and
    // the browser draws three decorative dots instead. Masking the row (via its
    // toggle button's parent — AGENTS.md guarantees exactly one such button)
    // keeps that intended difference from failing every single surface.
    page.getByRole("button", { name: "Toggle games sidebar" }).locator(".."),
  ];
}

/** Width and height straight from the IHDR, so dimensions are known even coarse. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Image comparison without adding a dependency.
 *
 * `@playwright/test` ships pixelmatch, but not as an importable module:
 * `playwright-core`'s export map stops at `lib/coreBundle`, so the only handle
 * on it is `utils.getComparator` — Playwright's own screenshot comparator,
 * pixelmatch plus its antialias handling. It reports the count in prose, hence
 * the regex. The bundle resolves from `@playwright/test`'s directory rather
 * than ours because pnpm does not hoist it.
 */
async function loadDiffEngine() {
  try {
    const pixelmatch = (await import("pixelmatch")).default;
    const { PNG } = await import("pngjs");
    return {
      label: "pixelmatch",
      coarse: false,
      compare(a, b) {
        const left = PNG.sync.read(a);
        const right = PNG.sync.read(b);
        if (left.width !== right.width || left.height !== right.height) return { pixels: null, diff: null };
        const out = new PNG({ width: left.width, height: left.height });
        const pixels = pixelmatch(left.data, right.data, out.data, left.width, left.height, { threshold: 0.2 });
        return { pixels, diff: pixels ? PNG.sync.write(out) : null };
      },
    };
  } catch {} // not installed here

  try {
    const req = createRequire(import.meta.resolve("@playwright/test"));
    const { utils } = req("playwright-core/lib/coreBundle");
    const comparator = utils.getComparator("image/png");
    return {
      label: "playwright's bundled pixelmatch",
      coarse: false,
      compare(a, b) {
        const result = comparator(a, b, { threshold: 0.2 });
        if (!result) return { pixels: 0, diff: null };
        const count = /(\d+) pixels/.exec(result.errorMessage ?? "");
        return { pixels: count ? Number(count[1]) : null, diff: result.diff ?? null };
      },
    };
  } catch {} // no comparator reachable

  return { label: "byte size + dimensions (COARSE)", coarse: true, compare: () => ({ pixels: null, diff: null }) };
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Let the editor finish its first project load and layout pass.
  await page.waitForTimeout(600);
}

/** Captures every surface from one page, in place, and returns surface -> PNG. */
async function captureAll(page, source) {
  const shots = new Map();
  // Clearing the persisted tab is what makes the two sides start equal.
  await page.evaluate((key) => localStorage.removeItem(key), VIEW_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page);
  const shoot = async (surface) => {
    // `scale: "css"` on both sides. Playwright captures at the device pixel
    // ratio by default, so the shell's window on a retina display came back
    // 2880x1800 against the reference browser's 1440x900 and every surface
    // read as "dimensions differ" — a comparison that can never pass, for a
    // reason that has nothing to do with the shells.
    shots.set(
      surface,
      await page.screenshot({
        mask: unstable(page),
        animations: "disabled",
        fullPage: false,
        scale: "css",
      }),
    );
  };
  await shoot("default");

  for (const tab of TABS) {
    const handle = page.getByRole("tab", { name: tab, exact: true }).first();
    if (!(await handle.isVisible().catch(() => false))) {
      console.log(`  ${source}: tab "${tab}" is not open — skipped`);
      continue;
    }
    await handle.click({ timeout: 5000 });
    await settle(page);
    await shoot(tab);
  }
  return shots;
}

async function electronPage() {
  const browser = await chromium.connectOverCDP(CDP_URL).catch((error) => {
    console.error(`Cannot reach the Electron shell on ${CDP_URL}: ${error.message}`);
    console.error(`Start it with: cd client && CALI_PORT=${CORE_PORT} npx electron dist-electron/main.js`);
    process.exit(2);
  });
  const pages = browser.contexts().flatMap((context) => context.pages());
  // The shell also owns the BROWSER panel's WebContentsView, which is a page
  // target too — the editor is the one served from core's port.
  const page = pages.find((candidate) => candidate.url().includes(`:${CORE_PORT}`));
  if (!page) {
    console.error(`Attached to ${CDP_URL} but no page is on :${CORE_PORT}. Saw: ${pages.map((p) => p.url()).join(", ") || "no pages"}`);
    process.exit(2);
  }
  // Forced through CDP rather than page.setViewportSize: a CDP-attached page
  // has a null viewport (it is a real window), and only the emulation override
  // makes both sides capture at the same size.
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  return { browser, page };
}

const engine = await loadDiffEngine();
mkdirSync(OUT_DIR, { recursive: true });

console.log(`core      ${BASE_URL}\nelectron  ${CDP_URL}\noutput    ${OUT_DIR}\ncompare   ${engine.label}\n`);
if (engine.coarse) {
  console.log("!! Neither pixelmatch nor Playwright's bundled comparator could be loaded.");
  console.log("!! This run compares PNG byte size and dimensions only. It can prove two");
  console.log("!! surfaces have different geometry; it CANNOT prove they render the same.\n");
}

const { browser: electronBrowser, page: shellPage } = await electronPage();
const electronShots = await captureAll(shellPage, "electron");
await electronBrowser.close();

const reference = await chromium.launch();
const referencePage = await reference.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await referencePage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
const browserShots = await captureAll(referencePage, "browser");
await reference.close();

const surfaces = [...new Set([...electronShots.keys(), ...browserShots.keys()])];
const rows = [];
let failed = false;

for (const surface of surfaces) {
  const left = electronShots.get(surface);
  const right = browserShots.get(surface);
  if (left) writeFileSync(path.join(OUT_DIR, `${surface}.electron.png`), left);
  if (right) writeFileSync(path.join(OUT_DIR, `${surface}.browser.png`), right);

  if (!left || !right) {
    failed = true;
    rows.push([surface, left ? `${left.length}B` : "-", right ? `${right.length}B` : "-", "-", "MISSING on one side"]);
    continue;
  }

  const a = pngSize(left);
  const b = pngSize(right);
  const sizes = [`${a.width}x${a.height} ${Math.round(left.length / 1024)}K`, `${b.width}x${b.height} ${Math.round(right.length / 1024)}K`];

  if (a.width !== b.width || a.height !== b.height) {
    failed = true;
    rows.push([surface, ...sizes, "-", "DIMENSIONS DIFFER"]);
  } else if (engine.coarse) {
    const drift = Math.abs(left.length - right.length) / Math.max(left.length, right.length);
    failed ||= drift > MAX_COARSE_SIZE_DRIFT;
    const verdict = drift > MAX_COARSE_SIZE_DRIFT ? "SIZE DRIFT (coarse)" : "same size (coarse)";
    rows.push([surface, ...sizes, `~${(drift * 100).toFixed(1)}%`, verdict]);
  } else {
    const { pixels, diff } = engine.compare(left, right);
    if (diff) writeFileSync(path.join(OUT_DIR, `${surface}.diff.png`), diff);
    failed ||= pixels === null || pixels > MAX_DIFF_PIXELS;
    if (pixels === null) rows.push([surface, ...sizes, "?", "DIFFERS, count unavailable"]);
    else rows.push([surface, ...sizes, String(pixels), pixels > MAX_DIFF_PIXELS ? `DIFFERS (> ${MAX_DIFF_PIXELS})` : "match"]);
  }
}

const header = ["surface", "electron", "browser", "diff px", "verdict"];
const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => String(row[column]).length)));
const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");
console.log(`\n${line(header)}\n${line(widths.map((width) => "-".repeat(width)))}`);
for (const row of rows) console.log(line(row));

console.log(`\n${rows.length} surfaces compared. Images in ${OUT_DIR}`);
console.log(failed ? "FAIL — see the rows above and their .diff.png" : "PASS — both shells render the same editor");
process.exit(failed ? 1 : 0);
