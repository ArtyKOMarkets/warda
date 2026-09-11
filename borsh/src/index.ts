/**
 * Read Kaspa over borsh, so a seller does not need a node.
 *
 * One export. See `reader.ts` for why `submitTransaction` is not among them.
 */
export {
  BorshReader,
  CovenantUnanswerable,
  WriteNotSupported,
  type BorshOptions,
  type WasmRpc,
} from "./reader.ts";
