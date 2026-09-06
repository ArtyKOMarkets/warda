/**
 * @warda_protocol/verify — an HTTP endpoint that answers a counterparty's
 * question about a Warda grant.
 *
 * What it does NOT do, deliberately:
 *
 *   It does not decide anything. The covenant decides, on chain. Every answer
 *   here re-derives what the covenant would check, so that a caller learns
 *   WHICH rule binds instead of paying a fee to find out.
 *
 *   It does not hold a key, sign, or broadcast. There is nothing here to
 *   compromise beyond the node it reads.
 *
 *   It does not accept a covenant template from the caller. The template
 *   decides how an address derives, so letting the party being verified choose
 *   it would make the verification meaningless.
 */
export { materialise, parseRecipients, prefixFor, ManifestError } from "./manifest.ts";
export type { Assumption, Materialised, MaterialiseInput } from "./manifest.ts";
export { NodeSource, NodeUnusable, readFrom } from "./node.ts";
export type { ChainReader, ChainSource, Live, NodeOptions } from "./node.ts";
export { amount, envelope, reportJson, ENFORCEMENT } from "./report.ts";
export type { Amount, Envelope, ReadFrom, ReportJson } from "./report.ts";
export { authority, grantAt, health, locate, verify, RequestError } from "./routes.ts";
export type { AuthorityAnswer, Reply } from "./routes.ts";
export { handler, serve } from "./server.ts";
export type { Running, ServeOptions } from "./server.ts";
export { loadTemplate } from "./template.ts";
