/* The router that plans a crossing through Igra. It is the same
   `@warda_protocol/router` the tests exercise, served by this site as
   /router-browser.js, and it builds steps nobody here can sign: every one
   that moves value is handed to you unsigned. */
declare global {
  interface Window { WardaRouter?: any }
}
let p: Promise<any> | null = null;
export function router(): Promise<any> {
  p ??= new Promise((ok, no) => {
    if (window.WardaRouter) return ok(window.WardaRouter);
    const s = document.createElement("script");
    s.src = "/router-browser.js";
    s.onload = () => (window.WardaRouter ? ok(window.WardaRouter) : no(new Error("the router loaded but did not start")));
    s.onerror = () => { p = null; no(new Error("the router did not load from this site")); };
    document.head.appendChild(s);
  });
  return p;
}

export interface PlanStep { describe: string; action: string; hop?: string; blockers?: string[]; missing?: string[]; counterparty?: string | null }
export interface Plan { executable: boolean; steps: PlanStep[]; missing?: string[]; sompi?: bigint; minSompi?: bigint }

/** A plan for this amount, or the reason there is none. */
export async function planIgra(opts: { usd: string; rate: number; slippagePct: string; payoutAddress: string; source: string }): Promise<{ plan: Plan; quote: any } | { error: string }> {
  try {
    const R = await router();
    const bps = Math.round(parseFloat(opts.slippagePct) * 100);
    const quote = R.quote({
      price: { asset: "USD", amount: String(opts.usd) },
      rate: { perKas: String(opts.rate), asset: "USD", source: opts.source, observedAt: Date.now() },
      slippageBps: Number.isFinite(bps) ? bps : 50,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    const plan = R.planFunding({
      quote, from: { asset: "USDC", layer: "igra" },
      payoutAddress: opts.payoutAddress || undefined,
      expectPrefix: opts.payoutAddress.startsWith("kaspa:") ? "kaspa" : "kaspatest",
    });
    return { plan, quote };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const ACTION: Record<string, string> = { "sign-and-submit": "you sign", "await-confirmation": "you wait", "off-protocol": "happens elsewhere" };
