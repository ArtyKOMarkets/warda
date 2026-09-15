/**
 * @warda_protocol/agent — a wallet an autonomous agent can hold.
 *
 * What makes it different from every other wallet is not a feature. Every
 * wallet you have used protects you by asking before it signs, and that
 * protection does not exist for an agent: the entire point of one is that it
 * runs when nobody is there. So this wallet does not ask. It can be fully
 * compromised — key stolen, process owned — and the limit still holds, because
 * the limit is not in this code. It is compiled into the script that unlocks
 * the coin, and every node on the network applies it.
 *
 * What this package is responsible for is the part that is nobody else's job:
 * the grant's record. Its address is a hash of its state, so it moves on every
 * spend, and a record that falls behind points at an address holding nothing.
 */
export { Agent, type AgentOptions, type Purchase } from "./agent.ts";
export { toGrant, toRecipientSet, type LoadedGrant } from "./grant.ts";
export { advanced, memoryStore, type Manifest, type Store } from "./store.ts";
export { fileStore } from "./file-store.ts";
