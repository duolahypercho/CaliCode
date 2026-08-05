import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:5199";
const OUT = "/tmp/cali-shots";
const browser = await chromium.launch();

async function capture(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator('canvas').first().waitFor({ state: "visible" });
  await page.waitForTimeout(1400);

  const issues = await page.evaluate(() => {
    const doc = document.documentElement;
    const out = {
      pageOverflowX: doc.scrollWidth > doc.clientWidth,
      pageOverflowY: doc.scrollHeight > doc.clientHeight,
      offscreen: [],
      clipped: [],
      visibleText: document.body.innerText.slice(0, 300),
    };
    for (const el of Array.from(document.querySelectorAll("button, [role=tab], input, textarea, select, h1, h2, h3, span"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const label = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || el.tagName;
      if (rect.left < -1 || rect.right > doc.clientWidth + 1) {
        out.offscreen.push(`${label} ${Math.round(rect.left)},${Math.round(rect.right)}`);
      }
      if (el.scrollWidth > el.clientWidth + 2 && el.scrollHeight > el.clientHeight + 2) {
        out.clipped.push(`${label} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
      }
    }
    return out;
  });

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`${name}: overflowX=${issues.pageOverflowX} overflowY=${issues.pageOverflowY}`);
  if (issues.offscreen.length) console.log(`  offscreen: ${issues.offscreen.slice(0, 8).join(" | ")}`);
  if (issues.clipped.length) console.log(`  clipped: ${issues.clipped.slice(0, 8).join(" | ")}`);
}

const desktop = await browser.newPage();
await capture(desktop, "desktop-shell", 1440, 900);

await desktop.getByRole("tab", { name: "Workbench" }).click();
await desktop.waitForTimeout(800);
await desktop.screenshot({ path: `${OUT}/workbench.png` });

await desktop.getByRole("tab", { name: "Assets" }).click();
await desktop.waitForTimeout(800);
await desktop.screenshot({ path: `${OUT}/assets.png` });

await desktop.getByRole("button", { name: "Play" }).click();
await desktop.waitForTimeout(1200);
await desktop.getByRole("button", { name: "Pause" }).click();
await desktop.getByRole("tab", { name: "Filmstrip" }).click();
await desktop.waitForTimeout(600);
await desktop.screenshot({ path: `${OUT}/filmstrip.png` });

await desktop.getByRole("button", { name: "Run tests" }).click();
await desktop.waitForTimeout(2500);
await desktop.getByRole("tab", { name: "Tests" }).click();
await desktop.waitForTimeout(600);
await desktop.screenshot({ path: `${OUT}/tests.png` });

await capture(desktop, "desktop-after", 1440, 900);

const mobile = await browser.newPage();
await capture(mobile, "mobile-shell", 390, 844);
await mobile.screenshot({ path: `${OUT}/mobile-full.png`, fullPage: true });

await browser.close();
