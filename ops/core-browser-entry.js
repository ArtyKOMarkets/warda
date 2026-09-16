/**
 * What the sandbox needs, and nothing else.
 *
 * A narrow entry rather than re-exporting the package: the browser bundle is
 * downloaded by anyone who opens a page, and shipping the delegation and
 * reabsorption machinery to teach somebody what a budget is would be paying
 * for weight nobody on that page uses.
 */
export {
  validateSpend,
  epochIndexAt,
  epochSpentAt,
  available,
  initialState,
  createGrant,
  /* The allowlist. A sandbox that could not demonstrate "that payee is not on
     it" would be missing the refusal people remember. */
  RecipientSet,
  /* Revocation is not a limit, and the sandbox needs the one refusal that is
     not arithmetic. It is a one-field state change and could trivially be
     written on the page instead — which is exactly the second copy of the
     rules this bundle exists to prevent, at the smallest size where that
     argument still holds. */
  revoke,
  formatKas,
  kas,
  toHex,
} from "../src/index.ts";
