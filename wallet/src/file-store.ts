/**
 * The ordinary case: a JSON file on disk.
 *
 * Separate from `store.ts` so that importing the interface does not import
 * `node:fs`. A browser extension holding a grant is a real caller — the
 * console already runs the whole covenant engine in one — and a package that
 * cannot be loaded there because of an unused filesystem import is a package
 * that has quietly chosen its deployment targets.
 *
 * The write is atomic: a JSON file truncated by a crash mid-write is a grant
 * whose record cannot be parsed, which is the same outcome as losing it. Write
 * a sibling, then rename, because rename within a directory is the one
 * filesystem operation that is atomic nearly everywhere.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Manifest, Store } from "./store.ts";

export function fileStore(path: string): Store {
  return {
    async load(): Promise<Manifest> {
      const raw = readFileSync(path, "utf8");
      try {
        return JSON.parse(raw) as Manifest;
      } catch (e) {
        throw new Error(
          `${path} is not readable as a grant manifest: ${(e as Error).message}\n\n` +
            `This file is how the grant is found: its address is a hash of its state, so a ` +
            `record that cannot be parsed is a coin that cannot be located. Restore it from ` +
            `a backup rather than recreating it by hand — a manifest guessed at derives a ` +
            `different address, which reads as an empty grant.`,
        );
      }
    },
    async save(manifest: Manifest): Promise<void> {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(manifest, null, 1) + "\n");
      renameSync(tmp, path);
    },
  };
}
