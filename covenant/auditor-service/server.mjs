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
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const run = promisify(execFile);
const SCAN = process.env.SCAN_BIN ?? "../harness/target/release/scan";
const MAX_BYTES = 256 * 1024;

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

const paid = priced(
  {
    payTo: process.env.PAY_TO,
    sompi: BigInt(process.env.PRICE_SOMPI ?? "4000000"),
    network: process.env.WARDA_NETWORK ?? "testnet-10",
    secret: process.env.QUOTE_SECRET,
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
    console.log(`  POST /v1/report   402, ${process.env.PRICE_SOMPI ?? "4000000"} sompi to ${process.env.PAY_TO ?? "PAY_TO unset"}`);
  });
