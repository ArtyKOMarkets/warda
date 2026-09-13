/**
 * The demo vendor, offered as a one-click payee.
 *
 * A grant's allowlist is fixed at genesis, so the first thing a new tester
 * needs is an address they are willing to commit to forever — and they do not
 * have one. This is `covenant/deploy/demo-vendor.key.pub` as a pay-to-pubkey
 * address, and it is what warda-demo-api.vercel.app quotes for /weather,
 * /fact and /inference. It is published on the site's own quickstart; it is
 * not a secret and not a placeholder.
 *
 * It lives in its own module because the POPUP needs it and the popup must not
 * import `grants.ts` — that module opens sockets and reads the vault, and the
 * whole claim about the message boundary is that the renderer cannot reach
 * either. A constant is not a reason to break it.
 */
export const DEMO_VENDOR = {
  address: "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
  label: "the Warda demo API",
  detail: "a real 402 endpoint at warda-demo-api.vercel.app",
} as const;
