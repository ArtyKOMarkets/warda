import { hash, toHex, fromHex, utf8 } from "@warda_protocol/core";

/**
 * A service listing, as its operator publishes it.
 *
 * This is a claim BY the operator ABOUT their own service, and the registry
 * says so on every page that renders one. Two things about it are not claims:
 * the signature, which proves control of the key the service is paid at, and
 * where it was fetched from, which proves control of the domain it runs on.
 * Everything else — the price, the description, what it says it can do — is
 * the operator's word and is presented as their word.
 */
export interface ServiceManifest {
  /** Schema version. Present so a reader can refuse a shape it does not know
   *  rather than silently ignore fields it has never heard of. */
  version: 1;
  name: string;
  description: string;
  /** Where an agent pays and is served. MUST be on the same host as the
   *  manifest — see `HOST_MISMATCH` in verify.ts for why that is the binding
   *  and not a formality. */
  endpoint: string;
  capabilities: string[];
  pricing: { asset: string; amount: string; unit: string };
  payment: { protocol: string; network: string; warda: boolean };
  /** The x-only public key the service is paid at, 64 hex characters. */
  payee: string;
}

/** A manifest as it is actually published: the terms, plus the signature. */
export interface SignedServiceManifest extends ServiceManifest {
  /** BIP340 over `digest(manifest)`, by the key in `payee`. 128 hex chars.
   *
   *  Exactly 64 BYTES, and deliberately not the 65-byte shape a Warda
   *  transaction signature carries. A spend signature appends a sighash-type
   *  byte that names which digest the script engine should recompute; a
   *  listing has no sighash and no engine. Keeping the two shapes different
   *  lengths means neither verifier can ever be handed the other's signature
   *  and accept it, on top of the domain separation in the digest. */
  signature: string;
}

/**
 * The bytes a listing signature commits to.
 *
 * Domain-separated with its own tag, exactly as the covenant separates
 * `warda:grant:v1` from `warda:state:v1`. Without it, a signature made over
 * some other Warda structure that happened to serialise the same way would
 * verify here, and a signature made here would be replayable there. The tag
 * is what makes "this key signed a listing" a different statement from "this
 * key signed anything at all".
 *
 * ## Why this is a field encoding and not canonical JSON
 *
 * JSON canonicalisation (RFC 8785 and friends) is a specification about
 * Unicode escapes, number formatting and key ordering, and every
 * implementation of it is a chance for two languages to disagree about bytes
 * nobody looked at. A signature that verifies in one language and not another
 * is the worst failure this could have, because it strands an honest operator
 * with a listing that is invalid for reasons they cannot see.
 *
 * So: explicit order, explicit lengths, no optional fields, the same
 * discipline `encodeGrant` uses. A Python or Rust implementation of this is a
 * loop over a list, not a study of a standard.
 *
 * Strings are length-prefixed rather than delimited, because a delimiter is a
 * thing an attacker can put INSIDE a field: with `name|description` joined by
 * a pipe, a name of `a|b` and a description of `c` produce the same bytes as
 * a name of `a` and a description of `b|c`, and one signature covers both.
 */
export const LISTING_TAG = "warda:service:v1";

function lengthPrefixed(s: string): Uint8Array {
  const body = utf8(s);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

export function encodeListing(m: ServiceManifest): Uint8Array {
  if (m.version !== 1) throw new Error(`unknown manifest version: ${m.version}`);

  const parts: Uint8Array[] = [
    lengthPrefixed(String(m.version)),
    lengthPrefixed(m.name),
    lengthPrefixed(m.description),
    lengthPrefixed(m.endpoint),
  ];

  /* Capabilities are sorted before signing, so the same SET always produces
     the same bytes. An operator who reorders their list has not changed what
     they are offering and should not have to re-sign — and a reader who sorts
     them for display should not thereby invalidate the signature. */
  const caps = [...m.capabilities].sort();
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, caps.length, false);
  parts.push(count);
  for (const c of caps) parts.push(lengthPrefixed(c));

  parts.push(
    lengthPrefixed(m.pricing.asset),
    lengthPrefixed(m.pricing.amount),
    lengthPrefixed(m.pricing.unit),
    lengthPrefixed(m.payment.protocol),
    lengthPrefixed(m.payment.network),
    lengthPrefixed(m.payment.warda ? "true" : "false"),
    fromHex(m.payee),
  );

  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** What a listing signature is made over. */
export function listingDigest(m: ServiceManifest): Uint8Array {
  return hash(utf8(LISTING_TAG), encodeListing(m));
}

export function listingDigestHex(m: ServiceManifest): string {
  return toHex(listingDigest(m));
}
