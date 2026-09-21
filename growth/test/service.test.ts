/**
 * The hosted and the local Researcher are one function. These pin the parts
 * that decide whether a buyer is charged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayAllowed } from "@warda_protocol/vendor";
import { research, type ResearcherConfig } from "../src/service.ts";

const cfg = (status: number): ResearcherConfig => ({
  payTo: "kaspatest:qqj58pd2qw47lg2wn97srt27dwxp8jj2hfasxrt8tjjeytpelzh5sa2mpucwy",
  sompi: 5_000_000n,
  network: "testnet-10",
  secret: "test-secret",
  spent: replayAllowed(),
  fetcher: async () => ({ status, body: "{}" }),
  openNode: async () => { throw new Error("no node in a test"); },
});
const u = (s: string) => new URL(s, "https://growth.example");

test("the index says what is sold, for how much, and who runs it", async () => {
  const r = await research(u("/"), null, cfg(200));
  assert.equal(r.status, 200);
  assert.match(JSON.stringify(r.body), /0.05 KAS per record/);
  assert.match(JSON.stringify(r.body), /not an independent vendor/);
});

test("a request that cannot be served is refused before any quote", async () => {
  assert.equal((await research(u("/verify"), null, cfg(200))).status, 400);
  assert.equal((await research(u("/verify?url=javascript:alert(1)"), null, cfg(200))).status, 400);
  assert.equal((await research(u("/other"), null, cfg(200))).status, 404);
});

test("a servable request is quoted with the price and the address", async () => {
  const r = await research(u("/verify?url=https://github.com/acme/paybot"), null, cfg(200));
  assert.equal(r.status, 402);
  const a = (r.body as { accepts: { payTo: string; amountSompi: string }[] }).accepts[0]!;
  assert.equal(a.amountSompi, "5000000");
  assert.equal(a.payTo, cfg(200).payTo);
});

test("GitHub refusing means no quote, so nobody pays for an empty record", async () => {
  const r = await research(u("/verify?url=https://github.com/acme/paybot"), null, cfg(403));
  assert.equal(r.status, 503);
  assert.equal((r.body as { charged: boolean }).charged, false);
});

test("a project that does not exist is still sold — absence is a finding", async () => {
  const r = await research(u("/verify?url=https://github.com/acme/gone"), null, cfg(404));
  assert.equal(r.status, 402);
});

test("a browser gets a page, with the price and the address", async () => {
  const { describeHtml } = await import("../src/service.ts");
  const html = describeHtml({ ...cfg(200), origin: "https://growth.example" });
  assert.match(html, /<title>Warda Growth · Researcher<\/title>/);
  assert.match(html, /0.05 KAS \/ record/);
  assert.ok(html.includes(cfg(200).payTo));
  assert.match(html, /not an independent vendor/);
});
