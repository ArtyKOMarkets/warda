import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await p.goto("file:///home/claude/cards/cards.html");
await p.waitForTimeout(1500);
/* A card that silently rendered in Helvetica is the bug this whole file's
   header is about, so it is checked rather than assumed. */
const fonts = await p.evaluate(() => document.fonts.status);
const overflow = await p.evaluate(() => [...document.querySelectorAll(".card")]
  .map((c, i) => ({ i: i + 1, over: c.scrollHeight > c.clientHeight || c.scrollWidth > c.clientWidth }))
  .filter((x) => x.over).map((x) => x.i));
for (let i = 1; i <= 14; i++) {
  const el = await p.$(`#c${i}`);
  await el.screenshot({ path: `/home/claude/cards/out/warda-${String(i).padStart(2, "0")}.png` });
}
console.log(JSON.stringify({ fonts, overflowing: overflow }));
await b.close();
