/**
 * A batch: one unit of work, one grant tree, one settlement stack.
 *
 * ## Why a batch rather than a standing account
 *
 * Settlement is LIFO, so a tree with four long-lived children settled whenever
 * each finishes cannot be run. A batch fixes that by bounding the tree in
 * TIME: children are hired and settled inside one job, and a batch that ends
 * badly does not need settling at all — every child carries a window and
 * closes on its own with nobody online. A standing account has neither
 * property.
 *
 * The parent expires too, which means the worst case of an abandoned batch is
 * coin returning to the principal, not authority outliving the work.
 *
 * ## Why this spawns the SDK's tools instead of calling the SDK
 *
 * `build-delegation.ts` and `build-settlement.ts` carry more than a call to
 * the builder: fee correction against a live node, manifest advancement,
 * refusal to overwrite a child that already exists. Re-implementing any of
 * that here is the failure this repo has paid for five times —
 * extracted-then-copied — so the orchestrator spawns exactly what the CLI
 * spawns, and there is one implementation of each operation.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Outstanding } from "./hiring.ts";

export interface BatchRecord {
  /** A label. Batches are named so a log can say which one paid for what. */
  name: string;
  network: string;
  /** The parent grant's manifest. Everything else is derived from it. */
  manifest: string;
  openedAt: string;
  closedAt: string | null;
  /** Newest last. Settlement pops from the end — see `checkSettle`. */
  outstanding: Outstanding[];
  /** Everything that happened, in order, with what it cost. */
  log: Entry[];
}

export interface Entry {
  at: string;
  what: "open" | "hire" | "spend" | "settle" | "expire" | "close";
  who: string;
  txid?: string;
  sompi?: string;
  detail?: string;
}

export function load(path: string): BatchRecord {
  if (!existsSync(path)) throw new Error(`no batch at ${path}. Open one first.`);
  return JSON.parse(readFileSync(path, "utf8")) as BatchRecord;
}

export function save(path: string, batch: BatchRecord): void {
  writeFileSync(path, JSON.stringify(batch, null, 2) + "\n");
}

export function note(batch: BatchRecord, entry: Omit<Entry, "at">): void {
  batch.log.push({ at: new Date().toISOString(), ...entry });
}

/**
 * Where `build-delegation.ts` writes a child's manifest.
 *
 * Derived the same way the tool derives it, and stated here rather than
 * guessed: the orchestrator has to record the path to settle the child later,
 * and a path guessed differently from the one written is a child that cannot
 * be settled and must be left to expire.
 */
export function childManifestPath(parentManifest: string, childKey: string): string {
  return join(dirname(resolve(parentManifest)), `grant-child-${childKey.slice(0, 8)}.json`);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one of the SDK's tools, inheriting the environment that already carries
 * WARDA_SK and WARDA_RPC_JSON. Nothing about a key passes through here.
 */
export function runTool(toolPath: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", toolPath, ...args],
      { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    /* Streamed as well as captured: these tools print their reasoning to
       stderr as they go, and a delegation that takes four blocks to confirm
       should not look like a hang. */
    child.stderr.on("data", (d) => {
      stderr += String(d);
      process.stderr.write(d);
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** The transaction id a tool reports, or null if it did not broadcast one. */
export function txidFrom(result: RunResult): string | null {
  /* The SDK tools print keys, covenant ids and addresses' hashes before the
     transaction id — all 64 hex characters. The first such run in stderr was
     the agent key, and the first real week recorded three keys as txids. The
     id is the one after SUBMITTED:. */
  const submitted = /SUBMITTED:\s*([0-9a-f]{64})\b/.exec(result.stderr) ?? /SUBMITTED:\s*([0-9a-f]{64})\b/.exec(result.stdout);
  if (submitted) return submitted[1]!;
  const m = /\btxid\s*:?\s*([0-9a-f]{64})\b/i.exec(result.stderr);
  return m?.[1] ?? null;
}
