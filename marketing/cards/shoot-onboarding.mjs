/* One card, 1600x900 at 2x. Same shape as shoot.mjs and shoot-atomic.mjs.
 *
 * The browser path is the pre-installed Chromium rather than a downloaded one:
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set in this environment, so a launch that
 * expects to fetch its own build fails with a message about a missing executable
 * and nothing about why.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await p.goto("file://" + here + "onboarding.html");
/* The fonts are local woff2 files, so this is not a network wait — it is the
 * layout settling after they swap in. A card screenshotted before that is a card
 * rendered in Helvetica, which is the bug the comment in cards.html is about. */
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(600);
const el = await p.$("#onboarding");
if (!el) throw new Error("no #onboarding in onboarding.html — the id moved");
await el.screenshot({ path: here + "warda-onboarding.png" });
console.log("rendered " + here + "warda-onboarding.png");
await b.close();
