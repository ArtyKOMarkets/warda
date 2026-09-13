/**
 * KAS in, sompi out.
 *
 * The CLI made this switch deliberately and the reason holds here: a budget
 * off by a factor of ten is invisible in sompi and is a grant ten times more
 * permissive than intended. Humans type KAS; the covenant counts sompi; the
 * conversion happens in exactly one place.
 *
 * Parsed as a decimal STRING rather than through a float. 0.1 KAS is
 * 10,000,000 sompi, and `0.1 * 1e8` in IEEE-754 is 10000000.000000002 — which
 * truncates correctly today and is the sort of thing that stops doing so at
 * the third decimal place, in a number that decides how much money an agent
 * may spend.
 */
export const SOMPI = 100_000_000n;

export function toSompi(kas: string): bigint {
  const t = kas.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not an amount in KAS: "${kas}"`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > 8) throw new Error(`KAS has eight decimal places; "${kas}" has ${frac.length}`);
  return BigInt(whole!) * SOMPI + BigInt(frac.padEnd(8, "0") || "0");
}

export function toKas(sompi: string | bigint, places = 8): string {
  const v = BigInt(sompi);
  const whole = v / SOMPI;
  const frac = (v % SOMPI).toString().padStart(8, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
