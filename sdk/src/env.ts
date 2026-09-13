/**
 * Reading configuration from the environment, where there may not be one.
 *
 * This package now runs in three places. In Node, `process.env` is the
 * configuration surface and always exists. In a browser extension it does
 * not, and touching a bare `process` there is a ReferenceError rather than an
 * undefined — so a single unguarded read takes down the whole module at
 * import time, not at the moment the variable was wanted. And in a bundler's
 * output, a literal `process.env.X` is frequently substituted at build time,
 * which silently freezes whatever the build machine happened to have.
 *
 * Reading it off `globalThis` answers all three: absent is absent, and the
 * expression is not the shape bundlers rewrite.
 */
export function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}
