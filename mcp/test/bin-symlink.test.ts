/**
 * The server must start when it is run the way every client actually runs it.
 *
 * npm installs a bin as a SYMLINK — node_modules/.bin/warda-mcp points at
 * dist/server.js — and that is what an MCP client config, `npx`, and every
 * quickstart invoke. Node resolves the symlink to its real path for
 * import.meta.url while process.argv[1] keeps the link, so a main-module guard
 * comparing the two never fires.
 *
 * The failure had no symptom. The process started, connected no transport,
 * printed nothing and exited 0 — indistinguishable, from a client's side, from
 * a server that is thinking. @warda_protocol/mcp@0.5.0 shipped like that: the
 * documented entry point did nothing, and the only working route to this
 * server was `warda mcp`, because the CLI resolves the package and spawns
 * dist/server.js by its REAL path.
 *
 * So the test invokes through a symlink on purpose. Testing the real path
 * would have passed against the broken version.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const serverPath = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "symlink-probe", version: "1" },
  },
});

function speakTo(entry: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const done = (fn: () => void) => { clearTimeout(timer); child.kill(); fn(); };
    const timer = setTimeout(() => done(() => resolve(out)), timeoutMs);
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("serverInfo")) done(() => resolve(out));
    });
    child.on("error", (e) => done(() => reject(e)));
    child.stdin.write(INITIALIZE + "\n");
  });
}

test("it answers when started through a symlink, as every client config starts it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warda-mcp-bin-"));
  const link = join(dir, "warda-mcp");
  symlinkSync(serverPath, link);

  const out = await speakTo(link);
  assert.ok(
    out.includes("serverInfo"),
    "the server produced nothing through a symlink — which is exactly how 0.5.0 failed, " +
      "silently, on `npx @warda_protocol/mcp` and on every MCP client config",
  );
  assert.match(out, /"name":"warda"/);
});

test("and when started by its own path, which always worked", async () => {
  const out = await speakTo(serverPath);
  assert.ok(out.includes("serverInfo"));
});
