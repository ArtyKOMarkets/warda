/**
 * `@warda_protocol/borsh` declared, so that it need not be installed.
 *
 * This package loads the transport with a dynamic import, and TypeScript
 * resolves that specifier whatever you cast the result to — so building
 * required the optional peer's type declarations to be present, which is a
 * contradiction in terms. Worse, borsh imports this package's siblings, so on
 * a clean checkout neither could be built first.
 *
 * It survived every local run because a tree that has already built both
 * compiles perfectly. The first CI job on a fresh clone found it in three
 * packages at once — sdk, vendor and verify — which is precisely the class of
 * thing a green suite on a warm machine cannot tell you.
 *
 * Identical declarations live in `sdk/src` and the other package named above.
 * Three copies of four lines, each beside the import that needs it, because
 * the alternative is a shared package existing only to hold a shim.
 */
declare module "@warda_protocol/borsh" {
  export const BorshReader: {
    open(options: { networkId?: string; url?: string }): Promise<unknown>;
  };
}
