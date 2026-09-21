/**
 * What the console's funding planner needs from `@warda_protocol/router`.
 *
 * The planner at /app renders the same `planFunding` the router's tests
 * exercise — the steps, what each one still needs, what the world refuses —
 * rather than a second description of the rail written for a page. The day the
 * two disagreed, the page would be teaching a route the router does not build.
 */
export {
  quote,
  planFunding,
  missingFrom,
  verdict,
  zoneOf,
  MIN_EXIT_SOMPI,
  GALLEON_TESTNET,
  IGRA_MAINNET,
} from "../router/src/index.ts";

/* The console's wallet connection reads a connected wallet's address and its
   public key separately and refuses to proceed unless they agree. That check
   needs the real decoder — the one the router already bundles for the payout
   address — not a second one written on the page. */
export { decodeAddress } from "../sdk/src/address.ts";
