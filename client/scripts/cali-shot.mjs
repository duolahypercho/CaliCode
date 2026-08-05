import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:5199";
const OUT = "/tmp/cali-shots";
const SIZES = [
  { name: "phone-small", width: 320, height: 700 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const browser = await chromium.launch();

async function audit(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const out = {
      overflowX: doc.scrollWidth > doc.clientWidth,
      overflowY: doc.scrollHeight > doc.clientHeight,
      offscreen: [],
      multiline: [],
    };
    for (const el of Array.from(document.querySelectorAll("button, [role=tab], [role=combobox], input, textarea, h1, h2, h3"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let node = el.parentElement;
      let insideScrollable = false;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        const scrollableX = (style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollWidth > node.clientWidth + 2;
        const scrollableY = (style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 2;
        if (scrollableX || scrollableY) {
          insideScrollable = true;
          break;
        }
        node = node.parentElement;
      }
      const label = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || el.tagName;
      if (!insideScrollable && (rect.left < -1 || rect.right > doc.clientWidth + 1 || rect.top < -1 || rect.bottom > doc.clientHeight + 1)) {
        out.offscreen.push(`${label} [${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}]`);
      }
      const style = getComputedStyle(el);
      if (style.whiteSpace !== "nowrap" && el.scrollHeight > el.clientHeight + 2 && el.scrollWidth > el.clientWidth + 2) {
        out.multiline.push(`${label} ${el.scrollHeight}/${el.clientHeight}`);
      }
    }
    for (const el of Array.from(document.querySelectorAll("[role=tab]"))) {
      if (el.scrollWidth > el.clientWidth + 2) {
        out.multiline.push(`tab ${el.textContent?.trim()} ${el.scrollWidth}/${el.clientWidth}`);
      }
    }
    out.multiline = [...new Set(out.multiline)].slice(0, 10);
    out.offscreen = [...new Set(out.offscreen)].slice(0, 10);
    return out;
  });
}

async function clickTab(page, name) {
  const locator = page.getByRole("tab", { name, exact: true }).first();
  if (await locator.isVisible().catch(() => false)) {
    await locator.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

let failed = false;
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("canvas").first().waitFor({ state: "visible" });
  await page.waitForTimeout(900);
  await clickTab(page, "Assets");
  await clickTab(page, "Workbench");
  await clickTab(page, "Tests");
  const auditResult = await audit(page);
  console.log(`${size.name}: ${JSON.stringify({ overflowX: auditResult.overflowX, overflowY: auditResult.overflowY, offscreen: auditResult.offscreen.length, multiline: auditResult.multiline.length })}`);
  if (auditResult.offscreen.length) console.log(`  offscreen: ${auditResult.offscreen.join(" | ")}`);
  if (auditResult.multiline.length) console.log(`  multiline: ${auditResult.multiline.join(" | ")}`);
  failed ||= auditResult.overflowX || auditResult.overflowY || auditResult.offscreen.length > 0 || auditResult.multiline.length > 0;
  if (["phone", "tablet", "desktop"].includes(size.name)) {
    await clickTab(page, "Inspector");
    await page.screenshot({ path: `${OUT}/${size.name}.png`, fullPage: false });
  }
  await page.close();
}

const showcase = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await showcase.goto(BASE, { waitUntil: "networkidle" });
await showcase.locator("canvas").first().waitFor({ state: "visible" });
await showcase.waitForTimeout(1000);
await clickTab(showcase, "Agent");
await showcase.screenshot({ path: `${OUT}/agent-harness.png` });
await showcase.close();

await browser.close();
process.exit(failed ? 1 : 0);
