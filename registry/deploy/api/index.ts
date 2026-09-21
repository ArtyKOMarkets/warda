/**
 * The Warda service registry, reachable at a URL.
 *
 * ## Why this file is in `api/`, which took three deploys to learn
 *
 * A serverless function on this Vercel version is a file in `api/`. That is the
 * whole rule, and the two ways of trying to say it some other way both failed:
 *
 *   1. `vercel.json` with `{"functions": {"index.ts": …}}`, copied from
 *      mcp/deploy, was rejected outright — those patterns are resolved INSIDE
 *      `api/`, so the pattern matched nothing.
 *
 *   2. Removing that block deployed successfully and was WORSE. With nothing
 *      declaring a function, Vercel served the directory statically: a GET of
 *      `/` returned this file's own TypeScript source, and `/verify` was 404.
 *      A green deploy serving its own source is the shape of failure this repo
 *      keeps meeting — it succeeded, it answered, and everything it said was
 *      wrong.
 *
 * A guess that was WRONG, recorded because it was written down before it was
 * checked: that `mcp/deploy`'s root `index.ts` was dead and being served as
 * static source, the way this one was. It is not.
 * `curl https://mcp.wardaprotocol.com/index.ts` returns the MCP server's own
 * JSON greeting, so every path there really does reach one entrypoint and that
 * header's account of itself is accurate.
 *
 * So the two projects behave differently under configuration that looks the
 * same in the repo, and the difference is in the Vercel project settings rather
 * than in any file here. Which is the actual lesson: what a directory deploys
 * as is not fully determined by its contents, so it has to be OBSERVED after
 * deploying rather than reasoned about from the tree.
 *
 * So: the function lives in `api/`, and `vercel.json` rewrites every path onto
 * it, which is how `/` and `/verify` both arrive here.
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

/**
 * The curated index, as a STATIC IMPORT rather than a file read at runtime.
 *
 * It was `readFileSync(new URL("sources.json", import.meta.url))`, which is the
 * shape the MCP endpoint's covenant template uses. That shape is a gamble: a
 * runtime resolution is invisible to the bundler tracing this function's
 * imports, so whether the file is uploaded depends on the bundler noticing a
 * pattern it is not obliged to notice. When it does not, the failure is a path
 * under /var/task that no local checkout has.
 *
 * A static import is not a gamble — a module the function imports is a module
 * the bundler must include. ops/build-registry-sources.mjs generates it from
 * site/src/services.json, so it is still one list with one source of truth.
 *
 * The specifier says `./sources.js` and the file on disk is `sources.ts`. That
 * is the ordinary TypeScript-for-ESM idiom, and writing it the way the rest of
 * this repo writes imports — `./sources.ts` — is what broke the first attempt:
 *
 *     TS5097: An import path can only end with a '.ts' extension when
 *             'allowImportingTsExtensions' is enabled.
 *
 * Every workspace here sets that flag, so `.ts` specifiers are the house style.
 * This directory is not a workspace and has no tsconfig of its own, so it got
 * the defaults and the house style did not survive the trip. There is a
 * tsconfig.json beside this file now saying so out loud.
 *
 * These are POINTERS, not claims. Each URL is fetched from the operator's own
 * domain and its signature checked before it becomes a listing, so an entry
 * here that has been tampered with does not produce a bad listing — it produces
 * a `dropped` line.
 */
/* BEGIN GENERATED sources — ops/build-registry-sources.mjs from site/src/services.json */
const sources: string[] = [
  "https://warda-demo-api.vercel.app/.well-known/warda-service.json",
  "https://warda-growth.vercel.app/.well-known/warda-service.json"
];
/* END GENERATED sources */

/**
 * The package is imported INSIDE the handler, and that is not stylistic.
 *
 * An import that fails at module load takes the whole function down before any
 * code of ours runs, and the only thing anybody sees is
 * FUNCTION_INVOCATION_FAILED with a request id. Two deploys were spent on that
 * screen with no way to tell a missing module from a broken one, because
 * `vercel logs` had nothing to show either.
 *
 * Inside a try/catch it becomes a sentence. The cost is one resolution on a
 * cold start, which is what a cold start already is.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let handle: typeof import("@warda_protocol/registry").handle;
  try {
    ({ handle } = await import("@warda_protocol/registry"));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      error: "registry_package_unavailable",
      detail: e instanceof Error ? e.message : String(e),
      note: "The endpoint could not load @warda_protocol/registry. This is a deployment fault, " +
            "not a fault in any listing.",
    }, null, 2) + "\n");
    return;
  }

  const host = req.headers.host ?? "registry.wardaprotocol.com";
  const request = new Request(`https://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]],
    ),
    /* No body is read. Every route is a GET, and a handler that never reads a
       body cannot be made to wait on one that never arrives. */
  });

  try {
    const response = await handle(request, { sources, maxAgeSeconds: 60 });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      error: "registry_failed",
      detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
    }, null, 2) + "\n");
  }
}
