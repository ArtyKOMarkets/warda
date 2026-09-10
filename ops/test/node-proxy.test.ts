/**
 * The proxy's job is refusing, so that is what this tests.
 *
 * A forwarding proxy that forwards everything passes any test written around
 * the happy path, and that proxy is the bug: kaspad's wRPC has no auth and
 * carries Shutdown, Ban and AddPeer. The interesting assertions below are all
 * about calls that must NOT reach the node.
 *
 * A fake kaspad stands in for the real one — it records what arrives, which is
 * the only way to prove a refusal never left the proxy.
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

const PROXY_PORT = 18499;
const FAKE_PORT = 18498;

const reached: string[] = [];
let fake: WebSocketServer;
let proxy: ChildProcess;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fake = new WebSocketServer({ port: FAKE_PORT });
  fake.on("connection", (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data));
      reached.push(msg.method);
      socket.send(JSON.stringify({ id: msg.id, params: { ok: true, saw: msg.method } }));
    });
  });

  proxy = spawn(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("../node-proxy.ts", import.meta.url)),
    "--upstream", `ws://127.0.0.1:${FAKE_PORT}`,
    "--port", String(PROXY_PORT),
  ], { stdio: ["ignore", "ignore", "ignore"] });
  await wait(1200);
});

after(() => { proxy?.kill(); fake?.close(); });

/** One call, one reply, through the proxy. */
function call(method: string, id = 1): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${method}: no reply`)); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ id, method, params: {} })));
    ws.on("message", (d) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(d)));
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

test("the four Warda needs are forwarded", async () => {
  for (const m of ["getInfo", "getBlockDagInfo", "getUtxosByAddresses", "submitTransaction"]) {
    const reply = await call(m);
    assert.equal((reply.params as { saw?: string })?.saw, m, `${m} did not reach the node`);
  }
});

test("Shutdown is refused, and never reaches the node", async () => {
  reached.length = 0;
  const reply = await call("shutdown", 7);
  assert.equal(reply.id, 7, "a refusal must carry the id or the caller waits for its timeout");
  assert.match(String(reply.error), /forwards only/);
  await wait(200);
  assert.deepEqual(reached, [], "shutdown reached the node");
});

test("so are the other node-control methods", async () => {
  reached.length = 0;
  for (const m of ["addPeer", "ban", "unban", "resolveFinalityConflict", "getConnectedPeerInfo"]) {
    const reply = await call(m);
    assert.ok(reply.error, `${m} was not refused`);
  }
  await wait(200);
  assert.deepEqual(reached, [], "a node-control method reached the node");
});

test("a refusal names the method, so the caller knows what to change", async () => {
  const reply = await call("stopNotifyingUtxosChanged");
  assert.match(String(reply.error), /stopNotifyingUtxosChanged/);
});

test("garbage is refused rather than forwarded", async () => {
  reached.length = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
  const got = await new Promise<string>((resolve) => {
    ws.on("open", () => ws.send("not json at all"));
    ws.on("message", (d) => { ws.close(); resolve(String(d)); });
  });
  assert.match(got, /not JSON/);
  await wait(200);
  assert.deepEqual(reached, []);
});

test("health reports what it is willing to do", async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  const body = (await res.json()) as { ok: boolean; allowed: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.allowed.sort(), [
    "getBlockDagInfo", "getInfo", "getUtxosByAddresses", "submitTransaction",
  ]);
});

test("health asks the node rather than reporting it was configured", async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  const body = (await res.json()) as { ok: boolean; detail: string };
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.detail, /answered getInfo/, "health must prove it spoke to the node");
});

test("and reports 503 when the node is gone — the case that matters", async () => {
  // The whole point: a health check that cannot fail tells a stranger to go
  // ahead and pay while the node behind it is dead.
  fake.close();
  await wait(6200); // outlive the health cache
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  const body = (await res.json()) as { ok: boolean; detail: string };
  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.ok(body.detail.length > 0, "a failure with no reason is not a report");
});

test("robots.txt tells crawlers to leave the node alone", async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/robots.txt`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Disallow: \//);
});
