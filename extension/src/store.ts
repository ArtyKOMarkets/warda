/**
 * Settings and the grant manifests, in `storage.local`.
 *
 * Never `storage.sync`. A grant manifest is not secret, but it is the record
 * that says where a grant currently lives, and sync would put it on every
 * machine signed into the browser — including ones the principal key is not
 * on. Nothing here is worth that.
 */
import { DEFAULT_SETTINGS, type Settings } from "./messages.ts";

const SETTINGS = "settings";

export async function settings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS);
  return { ...DEFAULT_SETTINGS, ...((got[SETTINGS] as Partial<Settings> | undefined) ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await settings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}
