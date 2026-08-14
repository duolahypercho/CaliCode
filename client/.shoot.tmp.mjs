import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await page.goto("http://127.0.0.1:5199/");
const composer = page.getByLabel("Agent prompt");
await composer.waitFor();

const cases = ["/compact", "/clear", "/goal", "/loop", "/usage"];
for (const cmd of cases) {
  await composer.fill(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  console.log(`${cmd.padEnd(10)} -> composer=${JSON.stringify(await composer.inputValue())}`);
}
// /side is the documented exception.
await composer.fill("/side");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
console.log(`/side      -> composer=${JSON.stringify(await composer.inputValue())} sideChatOpen=${await page.getByLabel("Side chat prompt").count() > 0}`);
await page.screenshot({ path: ".shoot.png" });
await browser.close();
