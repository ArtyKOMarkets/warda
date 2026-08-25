/** Kaspa's smallest unit. All protocol arithmetic is in sompi, never floats. */
export const SOMPI_PER_KAS = 100_000_000n;

export function kas(amount: string | number): bigint {
  const s = String(amount);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid KAS amount: ${s}`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 8) throw new Error(`KAS has 8 decimal places, got ${frac.length}: ${s}`);
  return BigInt(whole) * SOMPI_PER_KAS + BigInt(frac.padEnd(8, "0") || "0");
}

export function formatKas(sompi: bigint): string {
  const neg = sompi < 0n;
  const v = neg ? -sompi : sompi;
  const whole = v / SOMPI_PER_KAS;
  const frac = (v % SOMPI_PER_KAS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
