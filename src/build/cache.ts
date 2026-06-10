/**
 * Shared cache plumbing for the release and sha modes.
 *
 * Layout under one cache root (default `~/.cache/rskj-regression`,
 * overridable via spec field, `--cache-dir`, or
 * `RSKJ_REGRESSION_CACHE_DIR`):
 *
 *   <cacheDir>/
 *     releases/<component>/<tag>/        ← release mode
 *       <asset>-all.jar
 *       jar.sha256                       ← "<sha256>  <jarName>"
 *       source.json                      ← where it came from + how it was verified
 *       SHA256SUMS.asc                   ← only when the fallback verification ran
 *       .complete                        ← sentinel, written LAST
 *     src/<component>.git/               ← sha mode: cached bare clones
 *     builds/<component>/<sha>/          ← sha mode: one dir per 40-char commit
 *       <jarName>-all.jar
 *       jar.sha256
 *       build.json                       ← repo, ref-as-given, sha, version, jdk, timings
 *       .complete                        ← sentinel, written LAST
 *
 * Entry validity is two-factor: the `.complete` sentinel must exist
 * AND the jar's recomputed sha256 must match `jar.sha256` (the
 * in-process equivalent of `sha256sum -c`). Anything less — missing
 * sentinel (interrupted download/build), hash mismatch (corruption) —
 * deletes the entry so the caller re-fetches / rebuilds. Writers
 * populate `<entry>.tmp.<pid>/` and atomically rename into place, so
 * a crashed writer can never leave a directory that passes validation.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { MaterializedSeams } from "./seams.js";

/** Name of the entry-is-fully-written sentinel file. */
export const COMPLETE_SENTINEL = ".complete";

/** Name of the recorded-checksum file inside every cache entry. */
export const JAR_SHA256_FILE = "jar.sha256";

/**
 * Resolve the effective cache root: explicit value → env
 * `RSKJ_REGRESSION_CACHE_DIR` → XDG cache home → `~/.cache/rskj-regression`.
 */
export function defaultCacheDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit) return explicit;
  if (env.RSKJ_REGRESSION_CACHE_DIR) return env.RSKJ_REGRESSION_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".cache"), "rskj-regression");
}

/** Outcome of {@link validateCacheEntry}. */
export interface CacheEntryValidation {
  valid: boolean;
  /** Absolute jar path inside the entry — set only when valid. */
  jarPath?: string;
  /** The jar's sha256 — set only when valid. */
  sha256?: string;
  /** The jar's file name — set only when valid. */
  jarName?: string;
}

/**
 * Validate one cache entry directory; invalid entries are deleted so
 * the caller can unconditionally re-populate.
 *
 * Valid means: `.complete` exists, `jar.sha256` parses, the jar file it
 * names exists, the recomputed sha256 matches the recorded one, and —
 * when the caller knows the expected sha256 (release mode with a
 * reproducible-builds entry) — matches that too.
 */
export async function validateCacheEntry(
  entryDir: string,
  expectedSha256: string | null,
  s: MaterializedSeams,
): Promise<CacheEntryValidation> {
  if (!s.existsFn(entryDir)) {
    return { valid: false };
  }
  const invalidate = (reason: string): CacheEntryValidation => {
    s.log(`[build-cache] invalidating ${entryDir}: ${reason}`);
    s.rmFn(entryDir);
    return { valid: false };
  };

  if (!s.existsFn(join(entryDir, COMPLETE_SENTINEL))) {
    return invalidate("missing .complete sentinel (interrupted write?)");
  }
  let recordedSha: string;
  let jarName: string;
  try {
    const recorded = s.readFileFn(join(entryDir, JAR_SHA256_FILE));
    const match = /^([0-9a-f]{64})\s+(\S+)/.exec(recorded.trim());
    if (!match) return invalidate("jar.sha256 is unparseable");
    recordedSha = match[1]!;
    jarName = match[2]!;
  } catch {
    return invalidate("jar.sha256 is missing or unreadable");
  }
  const jarPath = join(entryDir, jarName);
  if (!s.existsFn(jarPath)) {
    return invalidate(`recorded jar ${jarName} is missing`);
  }
  const computed = await s.sha256FileFn(jarPath);
  if (computed !== recordedSha) {
    return invalidate(`sha256 mismatch: recorded ${recordedSha}, computed ${computed}`);
  }
  if (expectedSha256 !== null && computed !== expectedSha256) {
    return invalidate(`sha256 ${computed} no longer matches the expected ${expectedSha256}`);
  }
  return { valid: true, jarPath, sha256: computed, jarName };
}

/**
 * Write the entry checksum + sentinel and atomically promote
 * `tmpDir` to `entryDir`. The sentinel is written LAST so a crash at
 * any earlier point leaves a directory that fails validation.
 */
export function finalizeCacheEntry(
  tmpDir: string,
  entryDir: string,
  jarName: string,
  sha256: string,
  s: MaterializedSeams,
): void {
  s.writeFileFn(join(tmpDir, JAR_SHA256_FILE), `${sha256}  ${jarName}\n`);
  s.writeFileFn(join(tmpDir, COMPLETE_SENTINEL), "");
  if (s.existsFn(entryDir)) {
    // A stale (already-invalidated) leftover; clear the way for rename.
    s.rmFn(entryDir);
  }
  s.renameFn(tmpDir, entryDir);
}
