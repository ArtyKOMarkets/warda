/* The auditor, sold.
 *
 * What is free and what is paid is decided by what a machine can honestly do
 * for a covenant it has never seen:
 *
 *   POST /v1/scan    free.  The analysis — ABI, state layout, the refusal
 *                    surface taken from the AST, and which constructor
 *                    arguments move the script size. Needs no builder, so it
 *                    runs on anybody's .sil.
 *
 *   POST /v1/report  402.   The same analysis as a dated, self-contained
 *                    report you can send to somebody. That is the thing an
 *                    audit is actually bought for, and it is the only thing
 *                    here worth charging for today.
 *
 * What is NOT sold here, and the README says so: the claims suite and the
 * oracle. Both need a builder for the covenant's entrypoints, which is code a
 * person writes (PORTING.md). Charging for them per-upload would be selling
 * something this service cannot deliver.
 */
import { priced } from "@warda_protocol/vendor";
import { fileSpent } from "./spent.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const run = promisify(execFile);
const SCAN = process.env.SCAN_BIN ?? "../harness/target/release/scan";
const MAX_BYTES = 256 * 1024;
const PRICE_SOMPI = BigInt(process.env.PRICE_SOMPI ?? "4000000");

/* The signed listing, served from this origin because that is the binding:
   the registry checks that a manifest naming this endpoint was fetched from
   this endpoint's host, which is what makes it a claim by whoever controls
   the domain rather than by whoever typed it. */
const MANIFEST = process.env.MANIFEST_FILE ?? "./public/.well-known/warda-service.json";

/* One payment, one report. See spent.mjs — the default this would otherwise
   take forgets every sale on restart. */
const SPENT = fileSpent(process.env.SPENT_FILE ?? "./spent.log");

/* Refused at startup rather than at the first sale. Without PAY_TO the quote
   names no address, so a buyer pays nobody and the failure surfaces after
   their money has moved. `priced` already refuses to invent a quote secret
   for the same reason; the address deserves the same treatment. */
if (!process.env.PAY_TO) {
  console.error("PAY_TO is not set. It is the address every quote tells a buyer to pay,\n" +
                "and there is no sensible default for where somebody else's money goes.");
  process.exit(2);
}

/** The covenant is somebody else's text. It is never executed, only compiled
 *  by the Silverscript compiler in a subprocess with no arguments it did not
 *  come with, and the file is removed whether or not that succeeds. */
async function analyse(source) {
  const dir = await mkdtemp(join(tmpdir(), "scan-"));
  const file = join(dir, "covenant.sil");
  try {
    await writeFile(file, source, "utf8");
    const { stdout } = await run(SCAN, [file], { timeout: 60_000, maxBuffer: 4 << 20 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const body = (req) =>
  new Promise((ok, no) => {
    let n = 0, buf = "";
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BYTES) { no(new Error(`covenant larger than ${MAX_BYTES} bytes`)); req.destroy(); return; }
      buf += c;
    });
    req.on("end", () => ok(buf));
    req.on("error", no);
  });

const report = (text, when) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Covenant analysis</title>
<style>
  :root{--bg:#08090b;--surface:#0e1013;--line:#1f242b;--ink:#eceef1;--mid:#a4abb4;--dim:#6b737d;--accent:#14d7c1}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .page{max-width:56rem;margin:0 auto;padding:52px 40px 72px}
  h1{font-size:32px;letter-spacing:-.03em;margin:0 0 8px}
  .sub{color:var(--dim);font-size:13px;margin:0 0 22px}
  .note{border:1px solid var(--line);border-left:2px solid var(--accent);background:var(--surface);
    padding:15px 17px;border-radius:0 10px 10px 0;color:var(--mid);font-size:14px;max-width:44rem}
  pre{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px;
    overflow-x:auto;font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--mid);
    white-space:pre-wrap;word-break:break-word}
  footer{margin-top:36px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
  @page{size:A4;margin:14mm 12mm}
</style></head><body><div class="page">
<p class="sub">${when}</p>
<h1>Covenant analysis</h1>
<div class="note"><b>This is not a statement that the covenant is secure.</b> It reports what is
true of the compiled artefact and what conditions the source refuses on. Whether those
conditions are the right ones, and whether each is where its author thinks it is, needs a
transaction the engine will accept — and that needs a builder written for this covenant's
entrypoints.</div>
<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>
<footer>Produced by the Warda covenant auditor. The analysis is reproducible from the same
source with <code>cargo run --bin scan</code>; this document adds a date and a shape you can send.</footer>
</div></body></html>`;

/** What this sells, for anyone who arrives without a registry. */
const terms = () => ({
  name: "Covenant auditor",
  free: {
    "POST /v1/scan":
      "The analysis: ABI, state layout, script size against the consensus ceiling, which " +
      "constructor arguments move that size, and every condition the covenant refuses on, " +
      "grouped by the entrypoint that enforces it. Needs no builder, so it runs on any .sil.",
  },
  paid: {
    "POST /v1/report": "The same analysis, dated and rendered as a self-contained document.",
    price: { asset: "KAS", amount: (Number(PRICE_SOMPI) / 1e8).toFixed(2), unit: "request" },
    protocol: "x402",
    network: process.env.WARDA_NETWORK ?? "testnet-10",
    payTo: process.env.PAY_TO,
  },
  notSold:
    "The claims suite and the conservation oracle. Both need a builder for this covenant's " +
    "entrypoints — a function that constructs a transaction the engine accepts — which is code " +
    "a person writes, not a parameter. See covenant/harness/PORTING.md.",
  notAnAudit:
    "Nothing here is a statement that a covenant is secure. It reports what is true of the " +
    "compiled artefact and what the source refuses on; whether those are the right conditions, " +
    "and whether each sits where its author thinks it does, needs a transaction the engine accepts.",
  yourFile:
    "Written to a temporary file, compiled in a subprocess with a 60-second limit, and deleted " +
    "whether or not that succeeds. It is never executed — a covenant is a script for the Kaspa " +
    "engine, not for this machine. Bodies over 256 KB are refused.",
  operator: "Run by the Warda project. This is the project's own service, not an independent vendor.",
  listing: "/.well-known/warda-service.json",
});

const paid = priced(
  {
    payTo: process.env.PAY_TO,
    sompi: PRICE_SOMPI,
    network: process.env.WARDA_NETWORK ?? "testnet-10",
    secret: process.env.QUOTE_SECRET,
    spent: SPENT,
  },
  async (req) => {
    const text = await analyse(req.__source);
    return { html: report(text, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC") };
  },
);

http
  .createServer(async (req, res) => {
    const send = (code, type, payload) => { res.writeHead(code, { "content-type": type }); res.end(payload); };
    try {
      const path = (req.url ?? "/").split("?")[0];

      if (req.method === "GET") {
        /* Free, and on this host on purpose: an agent that has found this
           endpoint can read its terms without paying, and the registry can
           re-fetch the listing from the domain it describes. */
        if (path === "/.well-known/warda-service.json") {
          let listing;
          try {
            listing = await readFile(MANIFEST, "utf8");
          } catch {
            return send(404, "text/plain",
              "no signed listing on this host yet.\n" +
              "  node --experimental-strip-types registry/tools/sign-listing.ts \\\n" +
              "    covenant/auditor-service/listing.json --key <the payee's key> \\\n" +
              `    > ${MANIFEST}\n`);
          }
          return send(200, "application/json; charset=utf-8", listing);
        }
        if (path === "/") return send(200, "application/json; charset=utf-8", JSON.stringify(terms(), null, 2) + "\n");
        return send(404, "text/plain", "GET / or /.well-known/warda-service.json\n");
      }

      if (req.method !== "POST") return send(405, "text/plain", "POST a .sil body\n");
      const source = await body(req);
      if (!source.trim()) return send(400, "text/plain", "empty body\n");

      if (req.url.startsWith("/v1/scan")) {
        return send(200, "text/plain; charset=utf-8", await analyse(source));
      }
      if (req.url.startsWith("/v1/report")) {
        req.__source = source;
        // `priced` answers 402 with a quote when there is no payment header,
        // and looks the claimed transaction up in the UTXO set when there is.
        // It never reads the header as truth.
        const out = await paid(req, res);
        if (out && out.html) return send(200, "text/html; charset=utf-8", out.html);
        return;
      }
      send(404, "text/plain", "POST /v1/scan or /v1/report\n");
    } catch (e) {
      send(400, "text/plain", `${e.message}\n`);
    }
  })
  .listen(process.env.PORT ?? 8787, () => {
    console.log(`auditor on :${process.env.PORT ?? 8787}`);
    console.log(`  POST /v1/scan     free`);
    console.log(`  POST /v1/report   402, ${PRICE_SOMPI} sompi to ${process.env.PAY_TO}`);
    console.log(`  GET  /            free, the terms above as JSON`);
    console.log(`  GET  /.well-known/warda-service.json`);
    console.log(`  replay protection ${process.env.SPENT_FILE ?? "./spent.log"}, ${SPENT.count()} payments already served`);
  });
