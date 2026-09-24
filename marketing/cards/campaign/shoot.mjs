import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await p.goto("file:///home/claude/cards/cards.html");
await p.waitForTimeout(1500);
/* A card that silently rendered in Helvetica is the bug this whole file's
   header is about, so it is checked rather than assumed. */
const fonts = await p.evaluate(() => document.fonts.status);
/* scrollHeight on .card is useless here: the decorative ::after circle is
   deliberately outside the box, so it reported all 14 cards as overflowing and
   the check was ignored. Measure the real children against the card instead. */
const overflow = await p.evaluate(() => [...document.querySelectorAll(".card")]
  .map((c, i) => {
    const b = c.getBoundingClientRect();
    const over = [...c.querySelectorAll(".eye,h1,.body *,.foot *")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > b.bottom - 1 || r.right > b.right - 1 || r.left < b.left - 1;
    });
    return { i: i + 1, over };
  })
  .filter((x) => x.over).map((x) => x.i));
const count = await p.evaluate(() => document.querySelectorAll(".card").length);
for (let i = 1; i <= count; i++) {
  const el = await p.$(`#c${i}`);
  await el.screenshot({ path: `/home/claude/cards/out/warda-${String(i).padStart(2, "0")}.png` });
}
console.log(JSON.stringify({ fonts, overflowing: overflow }));
await b.close();
