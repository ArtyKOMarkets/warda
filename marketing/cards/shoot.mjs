import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:2 });
await p.goto("file:///home/claude/posts/cards.html");
await p.waitForTimeout(1200);
for (let i=1;i<=5;i++){
  const el = await p.$(`#c${i}`);
  await el.screenshot({ path:`/home/claude/posts/warda-post-${i}.png` });
}
console.log("rendered 5");
await b.close();
