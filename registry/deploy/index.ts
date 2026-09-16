/**
 * The Warda service registry, reachable at a URL.
 *
 * ## Why this is its own directory, and why the file is called index.ts
 *
 * Everything in this header was paid for by `mcp/deploy`, and it is repeated
 * rather than referenced because the next person deploying a third thing will
 * be reading this file, not that one.
 *
 * This Vercel version picks ONE root entrypoint per project and routes every
 * path to it — `/`, `/verify` and `/favicon.ico` all arrive at this function.
 * It finds that entrypoint by looking for `src/index.ts`, `index.ts` or a
 * `main` field. So this directory contains exactly one candidate: no `src/`,
 * no `main`, no build script, no `api/`. Whatever it picks here, it can only
 * pick this.
 *
 * It depends on the PUBLISHED `@warda_protocol/registry` rather than on the
 * working tree, so the endpoint serves a released version by construction. It
 * cannot run unreleased code, and it exercises the package the way an
 * installing user does.
 *
 * ## Linking this directory to its own project
 *
 * This repo is in Vercel's REPO-LINKED mode: `.vercel/repo.json` at the root
 * maps directories to projects, and it knows exactly one — `mcp/deploy` ->
 * `warda_mcp`. So the first `vercel --prod` from here offered `warda_mcp` as
 * the only choice, and taking it would have deployed the registry OVER the
 * live MCP endpoint. That is a one-keystroke way to lose a production service,
 * and the prompt gives no hint of it.
 *
 * The two deploys that have never had this problem — `verify/deploy` and
 * `site/web` — do not use the repo link at all. Each has its own
 * `.vercel/project.json`, which pins the directory to one project and makes
 * the wrong one unreachable:
 *
 *     vercel project add warda-registry
 *     vercel link --yes --project warda-registry
 *     vercel --prod
 *
 * ## Why vercel.json declares no `functions`
 *
 * It did, with `{"functions": {"index.ts": {"maxDuration": 15}}}`, copied from
 * mcp/deploy — and the deploy failed with
 *
 *     The pattern "index.ts" defined in `functions` doesn't match any
 *     Serverless Functions inside the `api` directory.
 *
 * `functions` patterns are resolved inside `api/`, and this handler is the ROOT
 * entrypoint, which is a different mechanism. The two cannot both be used to
 * describe the same file. Zero-config finds `index.ts` on its own and routes
 * every path to it, which is exactly what is wanted here, so the declaration
 * was the only thing standing in the way.
 *
 * The cost is that maxDuration takes its default. That is acceptable: every
 * request is a handful of parallel fetches with a five-second timeout each, and
 * a registry that cannot answer in ten seconds should fail rather than hold the
 * caller.
 *
 * ## Why a Node signature wraps a Web handler
 *
 * Vercel's Node runtime calls a function with `(IncomingMessage,
 * ServerResponse)`. The package's `handle` is web-standard — Request in,
 * Response out — because that shape is what lets the tests exercise the
 * deployed code rather than a paraphrase of it. So the adaptation happens
 * HERE, in the twenty lines that are specific to one host, instead of in the
 * package, where it would have made every test a lie about production.
 *
 * ## What it can and cannot do
 *
 * It holds no key, takes no writes, and stores nothing but a list of URLs. The
 * worst a compromise of this host achieves is a wrong ANSWER about who sells
 * what — it cannot make a bad listing verify, because every manifest is
 * re-fetched from the operator's own domain and re-checked on every request.
 *
 * It is also never in anybody's payment path. An agent that already knows an
 * endpoint pays without asking this anything.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { handle, type RegistryConfig } from "@warda_protocol/registry";

/**
 * The curated index, as a file beside this one.
 *
 * Read from source rather than resolved through a dependency, for the reason
 * the MCP endpoint's covenant template is copied here too: a runtime
 * resolution is invisible to the bundler that traces this function's imports,
 * so the file is never uploaded and the failure appears as a path under
 * /var/task that no local checkout has.
 *
 * These are POINTERS, not claims. Nothing in this file is served to anyone —
 * each URL is fetched from the operator's own domain and its signature checked
 * before it becomes a listing. An entry here that has been tampered with does
 * not produce a bad listing; it produces a `dropped` line.
 */
const sources: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("sources.json", import.meta.url)), "utf8"),
).sources;

const config: RegistryConfig = { sources, maxAgeSeconds: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? "registry.wardaprotocol.com";
  const request = new Request(`https://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]],
    ),
    /* No body is read. Every route is a GET, and a handler that never reads a
       body cannot be made to wait on one that never arrives. */
  });

  const response = await handle(request, config);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(await response.text());
}
