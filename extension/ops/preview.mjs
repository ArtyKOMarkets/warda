/**
 * Photograph every screen the popup can show, without Chrome and without a key.
 *
 * The popup is a renderer: every state it can be in is an object it was handed
 * across the message boundary. So the screens can be photographed by answering
 * its messages with canned ones — no extension loaded, no vault, no node, no
 * money. That is a property of the boundary rather than a trick, and the day
 * it stops working the reason will be that the popup started reaching for
 * something itself.
 *
 *   node ops/preview.mjs   ->  ops/preview/*.png
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../build/chrome-mv3/", import.meta.url).pathname;
const OUT = new URL("./preview/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const SETTINGS = { nodeUrl: "wss://warda-node.tailc0c0ec.ts.net", network: "testnet-10", lockMinutes: 15 };
const ADDRESS = "kaspatest:qq7xj0mpl0p8k4pn3w2l0mz6q9s5vd2nqr6t8j4xkm3h7yfz0wqc2v5n8dxlr";
const GRANT = "kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr";
const PUB = "3c693f61" + "7a".repeat(28);

const HAS_KEY = { hasVault: true, publicKey: PUB, address: ADDRESS, settings: SETTINGS };
const NODE = { url: SETTINGS.nodeUrl, reachable: true, detail: "synced, indexed, right network",
               network: "kaspa-testnet-10", daaScore: "567634976" };

const GRANTS = [
  {
    record: {
      id: "aa".repeat(32), label: "research agent", covenant: "b3e5eeefacf2021f", network: "testnet-10",
      authority: { principalKey: PUB, revocationKey: PUB },
      state: { budgetTotal: "200000000", maxPerSpend: "10000000" },
      recipients: ["x", "y"], grantValue: "200000000",
      createdAt: "2026-09-13T09:00:00Z", genesisTxid: "bb".repeat(32), endedBy: null,
    },
    address: GRANT, balanceSompi: "173400000", detail: "funded, at the address this state derives",
  },
  {
    record: {
      id: "cc".repeat(32), label: "digest buyer", covenant: "b3e5eeefacf2021f", network: "testnet-10",
      authority: { principalKey: PUB, revocationKey: PUB },
      state: { budgetTotal: "50000000", maxPerSpend: "4000000" },
      recipients: ["z"], grantValue: "50000000",
      createdAt: "2026-09-11T09:00:00Z", genesisTxid: "dd".repeat(32), endedBy: null,
    },
    address: GRANT, balanceSompi: null,
    detail: "nothing at this address — it has spent and moved, or it was drained, revoked or never " +
            "funded. This console cannot yet tell those apart.",
  },
];

const ISSUED = {
  record: GRANTS[0].record,
  agentSecretHex: "9fccfb0842d1c7e6b35a0f21d4e98c7530bb61af2c4d90e7185f36ac0b2d74e9",
  address: GRANT,
  txid: "ee".repeat(32),
};

/** name -> [status, extra setup] */
const SHOTS = {
  "1-setup": { status: { hasVault: false, unlocked: false, publicKey: null, address: null, settings: SETTINGS } },
  "2-locked": { status: { ...HAS_KEY, unlocked: false }, grants: [] },
  "3-grants": { status: { ...HAS_KEY, unlocked: true }, grants: GRANTS, height: 760 },
  "4-revoke": { status: { ...HAS_KEY, unlocked: true }, grants: GRANTS, height: 820, click: "Revoke" },
  "5-issue": { status: { ...HAS_KEY, unlocked: true }, grants: [], height: 700, click: "Issue a grant" },
  "6-handoff": { status: { ...HAS_KEY, unlocked: true }, grants: [], height: 700, handoff: true },
};

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const path = join(ROOT, rel === "/" ? "popup.html" : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, shot] of Object.entries(SHOTS)) {
  const page = await browser.newPage({
    viewport: { width: 380, height: shot.height ?? 500 },
    deviceScaleFactor: 2,
  });
  await page.addInitScript(
    ([status, node, grants, issued]) => {
      globalThis.chrome = {
        runtime: {
          sendMessage: async (m) => {
            if (m.kind === "nodeStatus") return { ok: true, value: node };
            if (m.kind === "grants") return { ok: true, value: grants };
            if (m.kind === "issue") return { ok: true, value: issued };
            return { ok: true, value: status };
          },
        },
      };
    },
    [shot.status, NODE, shot.grants ?? [], ISSUED],
  );
  await page.goto(`http://127.0.0.1:${port}/popup.html`);
  await page.waitForSelector("h1", { timeout: 5000 });
  if (shot.click) await page.getByRole("button", { name: shot.click }).first().click();
  if (shot.handoff) {
    await page.getByRole("button", { name: "Issue a grant" }).click();
    await page.getByLabel("May pay — addresses or x-only keys").fill("kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4");
    await page.getByRole("button", { name: "Create it" }).click();
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`${name.padEnd(12)} ${await page.locator("h1").first().innerText()}`);
  await page.close();
}
await browser.close();
server.close();
