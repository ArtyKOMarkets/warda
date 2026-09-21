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
