/**
 * `@warda_protocol/borsh` declared, so that it need not be installed.
 *
 * The transport is an OPTIONAL peer: it ships a wasm binary, and a caller with
 * a node of their own should not download one to decline it. But `chain.ts`
 * names it in a dynamic import, and TypeScript resolves the specifier whatever
 * you cast the result to — so without this, building the SDK required the
 * package's type declarations to exist.
 *
 * That turned out to be a build CYCLE rather than an inconvenience. borsh
 * imports this package's types; this package was importing borsh's. Each could
 * only be built after the other, so a fresh checkout could build neither — and
 * a tree that already had both built compiled perfectly, which is why it
 * survived local runs and failed on the first CI job.
 *
 * Declaring it here breaks the cycle in the correct direction: the SDK stops
 * depending on the peer's types, which is what optional means. The shape is
 * narrow on purpose — two calls — and `chain.ts` casts to its own structural
 * type regardless, so nothing here is load-bearing beyond letting the
 * specifier resolve.
 *
 * The alternative was hiding the specifier behind a variable. Refused: that
 * makes it unresolvable to bundlers as well as to the compiler, which is
 * exactly the failure that shipped a Vercel function without its wasm.
 */
declare module "@warda_protocol/borsh" {
  export const BorshReader: {
    open(options: { networkId: string; url?: string }): Promise<unknown>;
  };
}
