/*
 * The hosted runner's one function. Bundled by build.mjs into api/index.js
 * with the runner's source and the unpublished agent wallet; see README.md
 * for why this deploy is bundled rather than installed from npm.
 */
import { boot, nodeHandler } from "../src/boot.ts";

let ready = null;

export default async function handler(req, res) {
  ready ??= boot(process.env, {
    baseUrl: `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? "localhost"}`,
  }).then((r) => nodeHandler(r.api, r.baseUrl));
  try {
    return await (await ready)(req, res);
  } catch (e) {
    ready = null; // a failed boot is retried on the next request, not cached
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `the runner could not start: ${e.message}` }));
  }
}
