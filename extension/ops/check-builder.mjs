/**
 * Can this machine actually build the extension?
 *
 * WXT reports every failure to load its bundler as one line — "Builder not
 * found. Make sure vite is installed." — because it does
 * `await import("vite").catch(...)` and sends the real error to a debug log
 * nobody has turned on. Vite was installed. What was missing was one native
 * binding, and the message pointed at the wrong thing entirely.
 *
 * The cause is structural and will recur: `node_modules/` lives in a folder
 * shared between machines, and npm installs only the platform binding of
 * whichever machine ran the install, leaving EMPTY directories for the other
 * fourteen — which is npm/cli#4828, and which makes npm believe on the next
 * run that they are already there.
 *
 * So this runs before the build and says the true thing, naming the package
 * this platform needs and the command that installs it.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  await import("vite");
} catch (cause) {
  const chain = [];
  for (let e = cause; e; e = e.cause) chain.push(e.message?.split("\n")[0] ?? String(e));

  /* Whether vite is ABSENT or merely unloadable, because the advice differs
     and claiming "vite is installed" when it is not would repeat WXT's
     mistake in the other direction. */
  let present = true;
  try { require.resolve("vite/package.json"); } catch { present = false; }

  let fix = "npm install";
  try {
    const version = require("rolldown/package.json").version;
    const platform = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform] ?? process.platform;
    const suffix = platform === "linux" ? `${process.arch}-gnu` : platform === "win32" ? `${process.arch}-msvc` : process.arch;
    /* `npm run bindings`, not an npm install: installing one platform's
       binding is what EVICTED the other machine's, which is how this became a
       loop rather than a fix. The script unpacks the tarball directly so both
       can sit there at once. */
    void `@rolldown/binding-${platform}-${suffix}@${version}`;
    fix = "npm run bindings";
  } catch { /* rolldown is not the cause; the generic advice stands */ }

  console.error(
    `\nThis machine cannot build the extension. WXT would have said "Builder not ` +
      `found. Make sure vite is installed."` +
      (present ? ` Vite IS installed — that is not the problem.` : ``) +
      `\n\nWhat actually failed:\n` +
      chain.map((m, i) => `  ${"  ".repeat(i)}${m}`).join("\n") +
      (present
        ? `\n\nnode_modules is shared between machines, and npm unpacks only the native ` +
          `binding of whoever ran the install — leaving empty directories for every other ` +
          `platform, which it then believes are installed (npm/cli#4828).`
        : `\n\nNothing is installed for this workspace yet.`) +
      `\n\n` +
      `On this machine (${process.platform}-${process.arch}):\n\n  ${fix}\n\n` +
      `If that is not enough, remove node_modules and package-lock.json at the repo ` +
      `root and install again from here.\n`,
  );
  process.exit(1);
}
