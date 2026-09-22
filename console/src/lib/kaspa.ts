/**
 * Kaspa address encoding (cashaddr: 5-bit base32 with a 40-bit polymod
 * checksum), enough to name a 32-byte Schnorr key as its pay-to-pubkey
 * address. Used to match the registry's payee keys to a grant's payees.
 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i]!;
  }
  return c ^ 1n;
}

function to5(bytes: number[]): number[] {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function pubkeyToAddress(hex: string, prefix = "kaspatest"): string | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const payload = [0, ...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16))];
  const data = to5(payload);
  const pre = [...prefix].map((c) => c.charCodeAt(0) & 31);
  const mod = polymod([...pre, 0, ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  const check: number[] = [];
  for (let i = 0; i < 8; i++) check.push(Number((mod >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...data, ...check].map((d) => CHARSET[d]).join("")}`;
}

export const explorerTx = (txid: string, net = "testnet-10") =>
  net === "mainnet" ? `https://explorer.kaspa.org/txs/${txid}` : `https://explorer-tn10.kaspa.org/txs/${txid}`;
export const explorerAddress = (a: string, net = "testnet-10") =>
  net === "mainnet" ? `https://explorer.kaspa.org/addresses/${a}` : `https://explorer-tn10.kaspa.org/addresses/${a}`;

/** A Kaspa address → { prefix, version, payload }, or null if the checksum fails. */
export function decodeAddress(addr: string): { prefix: string; version: number; payload: number[] } | null {
  const s = addr.trim().toLowerCase();
  const i = s.indexOf(":");
  if (i < 1) return null;
  const prefix = s.slice(0, i);
  const data: number[] = [];
  for (const c of s.slice(i + 1)) { const v = CHARSET.indexOf(c); if (v < 0) return null; data.push(v); }
  if (data.length < 9) return null;
  const pre = [...prefix].map((c) => c.charCodeAt(0) & 31);
  if (polymod([...pre, 0, ...data]) !== 0n) return null;
  const body = data.slice(0, -8);
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  for (const d of body) { acc = (acc << 5) | d; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
  return { prefix, version: bytes[0]!, payload: bytes.slice(1) };
}

export function isAddress(a: string, prefix?: string): boolean {
  const d = decodeAddress(a);
  return !!d && (!prefix || d.prefix === prefix) && (d.version === 0 ? d.payload.length === 32 : d.version === 1 ? d.payload.length === 33 : d.version === 8 && d.payload.length === 32);
}

/** The owner's key, from a Kaspa address (P2PK) or a hex public key. */
export function ownerKey(v: string): string | null {
  v = v.trim();
  if (v.includes(":")) {
    const d = decodeAddress(v);
    return d && d.version === 0 && d.payload.length === 32 ? d.payload.map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  }
  const h = v.toLowerCase();
  return /^(0[23])?[0-9a-f]{64}$/.test(h) ? h.slice(-64) : null;
}
