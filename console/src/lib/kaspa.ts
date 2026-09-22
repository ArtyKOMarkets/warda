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
