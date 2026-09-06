#!/usr/bin/env node
/**
 * Run the verification API.
 *
 *   node --experimental-strip-types tools/serve.ts --port 8477 --rpc ws://127.0.0.1:17210
 *
 * With no --rpc it asks the resolver, the same way every other tool here does.
 * The node is checked before the first request is served, and the process
 * exits rather than starting on one that cannot be believed: a verifier that
 * boots on a bad node and reports grants as missing is worse than one that
 * refused to boot.
 */
import { serve } from "./server.ts";
import { formatHealth } from "@warda_protocol/kaspa";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const options = {
  ...(flag("rpc") ? { url: flag("rpc")! } : {}),
  ...(flag("network") ? { networkId: flag("network")! } : {}),
  ...(flag("port") ? { port: Number(flag("port")) } : {}),
  ...(flag("host") ? { host: flag("host")! } : {}),
};

const running = await serve(options);

try {
  const live = await running.source.acquire();
  console.error(formatHealth(live.health));
} catch (e) {
  console.error(`${(e as Error).message}\n`);
  await running.close();
  process.exit(1);
}

console.error(`warda-verify listening on http://${options.host ?? "127.0.0.1"}:${running.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
