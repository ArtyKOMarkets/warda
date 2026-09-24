import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await p.goto(`file://${process.cwd()}/atomic.html`);
await p.waitForTimeout(1200);
await (await p.$("#c1")).screenshot({ path: "post-atomic-delegation.png" });
console.log("rendered post-atomic-delegation.png");
await b.close();
