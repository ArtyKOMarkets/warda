import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
for (const [file, sel, name] of [
  ["site/web/start.html", ".qs", "start"],
  ["site/web/index.html", "#build", "index"],
]) {
  await p.goto("file://" + process.cwd() + "/" + file);
  await p.waitForTimeout(700);
  const el = await p.$(sel === ".qs" ? "section:has(.qs)" : sel);
  await el.screenshot({ path: `/tmp/qs-${name}.png` });
}
await b.close();
console.log("ok");
