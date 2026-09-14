/**
 * Kaspa over borsh — the encoding the public resolvers actually serve.
 *
 * Reading needs any WASM build. Submitting needs one that can express a
 * covenant, and `submit.ts` explains why that is checked by construction
 * rather than by version number.
 */
export {
  BorshReader,
  CovenantUnanswerable,
  WriteNotSupported,
  loadWasm,
  type BorshOptions,
  type WasmRpc,
} from "./reader.ts";

export {
  CovenantsUnsupported,
  SerialisationDisagreement,
  encodeForSubmit,
  supportsCovenants,
  toWasmTransaction,
  type WasmModule,
} from "./submit.ts";
