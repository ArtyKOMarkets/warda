import { defineConfig } from "wxt";

/**
 * Warda Console — the principal's half of the protocol, in a browser.
 *
 * The agent's key is not here and never will be. What lives in this extension
 * is the key that ISSUES and ENDS authority, which is the one thing in Warda
 * that a human has to hold and that the protocol itself does not bound. The
 * repo's own state doc names it: "the principal key is the unbounded thing and
 * it is a file". A file in a project directory is a worse place for it than an
 * encrypted vault behind a passphrase, and neither is as good as hardware —
 * which is why the signer seam exists and why this is built to grow one.
 *
 * Deliberately minimal permissions. `storage` for the vault and the grant
 * manifests, `alarms` for the auto-lock. No tabs, no scripting, no content
 * script, no host permissions: this extension reads the chain over a WebSocket
 * and touches no page the user visits. A console that could read pages would
 * be asking for trust it does not need.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Warda Console",
    description: "Give an agent a budget the network enforces. Watch it spend. End it.",
    version: "0.0.1",
    permissions: ["storage", "alarms"],
    // MV3's default CSP already forbids remote code. Stated anyway, because a
    // wallet's reviewers should not have to infer it, and because the day
    // someone adds a CDN font this line is what refuses.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
