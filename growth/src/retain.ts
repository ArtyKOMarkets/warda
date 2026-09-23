/**
 * X content does not sit on this disk indefinitely.
 *
 * X's Developer Policy allows storing Post objects offline only if you "keep
 * it up to date with the current state of that content on X" and "delete or
 * modify any content you have if it is deleted or modified on X … within 24
 * hours". Post IDs have no such condition — they are the thing the policy
 * explicitly lets you keep and share.
 *
 * Refreshing every saved post daily would cost a read per post forever, for
 * files whose whole purpose is a morning of tuning. So the other option: a
 * saved run keeps its text for a day, and after that it keeps the IDs, the
 * URLs and the scores — which are ours, not X's — and drops the rest.
 *
 * ## Why this runs on every pass rather than living in the runbook
 *
 * A retention rule somebody has to remember is a retention rule that holds
 * until the week they are busy. This project has written that sentence about
 * monitors already: a check which cannot fire looks exactly like a check with
 * nothing to report. So pruning is the first thing a pass does, it reports
 * what it changed, and nobody has to have read this file.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Post } from "./listen.ts";

/** Post objects live this long on disk before only their IDs remain. */
export const KEEP_MS = 24 * 3_600_000;

export interface SavedRun {
  at?: string;
  since?: string;
  queries?: string[];
  posts: Post[];
  /** Set once the content has been dropped, so a reader knows why it is thin. */
  pruned?: string;
}

/** What is left of a post once X's content is removed: what we wrote down. */
export function stripped(p: Post): Post {
  return {
    ...p,
    text: "",
    author: { ...p.author, name: null, followers: 0, verified: false },
    likes: 0, replies: 0, reposts: 0,
  };
}

/**
 * True if this run still holds post content past its day.
 *
 * Separate from the rewrite so a test can ask the question without a file, and
 * so a caller can report the count before changing anything.
 */
export function isStale(run: SavedRun, now = Date.now()): boolean {
  if (run.pruned) return false;
  if (!run.at) return true;
  const age = now - new Date(run.at).getTime();
  return !Number.isNaN(age) && age > KEEP_MS;
}

export function prune(run: SavedRun, now = Date.now()): SavedRun {
  return { ...run, posts: run.posts.map(stripped), pruned: new Date(now).toISOString() };
}

/**
 * Walk a directory of saved runs and prune the ones past their day.
 *
 * Returns what it did, so the caller can say so. A silent prune and a
 * directory with nothing to prune look the same from outside, and one of
 * those means the rule is working.
 */
export function pruneDir(dir: string, now = Date.now()): { file: string; posts: number }[] {
  if (!existsSync(dir)) return [];
  const done: { file: string; posts: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let run: SavedRun;
    try {
      run = JSON.parse(readFileSync(path, "utf8")) as SavedRun;
    } catch {
      continue;
    }
    if (!Array.isArray(run.posts) || !isStale(run, now)) continue;
    writeFileSync(path, `${JSON.stringify(prune(run, now), null, 2)}\n`);
    done.push({ file: name, posts: run.posts.length });
  }
  return done;
}
