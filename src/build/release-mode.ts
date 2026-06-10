/**
 * Mode 1 — pinned GitHub releases.
 *
 * Why downloads and not local Docker reproducible builds: the
 * reproducible-builds repo publishes the EXPECTED sha256 of every
 * release jar inline in its per-version `README.md` "Verify" section
 * (the release dirs hold only `Dockerfile` + `README.md` — no jars, no
 * checksum files). The actual bytes live as assets on the GitHub
 * release (verified: each release ships exactly the `-all.jar` fat jar
 * plus `SHA256SUMS.asc`). So the cheap-and-trustworthy recipe is:
 * download the release asset once, hash it, and demand the hash match
 * what reproducible-builds says it must be.
 *
 * Verification ladder:
 *
 *   1. `<reproducibleBuildsPath>/<versionDir>/README.md` — primary.
 *      Independent repo, reviewed hashes; provenance says
 *      `"reproducible-builds"`.
 *   2. When the local reproducible-builds clone is stale (no dir for
 *      the pinned version — at the time of writing the newest rskj dir
 *      is 9.0.0-vetiver), fall back to the release's own
 *      `SHA256SUMS.asc` (sha line only; PGP signature checking is out
 *      of scope for v1). Provenance says `"release-sha256sums"` and a
 *      LOUD warning lands in the result + log, because at that point
 *      the checksum and the jar share a publisher.
 *
 * Cache: `<cacheDir>/releases/<component>/<tag>/` with the jar,
 * `jar.sha256`, `source.json`, and a `.complete` sentinel written
 * last. We deviate from a flat `releases/<tag>/` by namespacing per
 * component, mirroring `builds/<component>/<sha>/` — rskj and powpeg
 * tags are distinguishable today (3- vs 4-part versions) but the
 * namespacing makes that a non-assumption. A cache hit with a valid
 * entry costs one local hash; no network. Offline runs therefore work
 * once the cache is warm, even when reproducible-builds is stale
 * (the original verification source is recorded in `source.json`).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { extractSha256ForAsset } from "./checksums.js";
import { defaultCacheDir, finalizeCacheEntry, validateCacheEntry } from "./cache.js";
import { materializeSeams, type BuildSeams, type MaterializedSeams } from "./seams.js";
import {
  powpegReleaseCoordinates,
  rskjReleaseCoordinates,
  type ReleaseCoordinates,
} from "./versions.js";
import type {
  BinaryProvenance,
  ReleaseBuildSpec,
  ReleaseVerificationSource,
  ResolvedBinaries,
} from "./types.js";

/** Checksums asset name on every rsksmart release. */
const SHA256SUMS_ASSET = "SHA256SUMS.asc";

/**
 * Team-convention location of the reproducible-builds checkout. Kept
 * as a convention (like the peer-directory rule for the test-suite
 * repos) rather than auto-cloning: the value of that repo is that a
 * human pulled and reviewed it.
 */
export function defaultReproducibleBuildsPath(): string {
  return join(homedir(), "workspace", "reproducible-builds");
}

/** Resolve a {@link ReleaseBuildSpec}: download (or reuse) + verify pinned release jars. */
export async function resolveRelease(
  spec: ReleaseBuildSpec,
  seams: BuildSeams = {},
): Promise<ResolvedBinaries> {
  const s = materializeSeams(seams);
  const warnings: string[] = [];
  const cacheDir = defaultCacheDir(spec.cacheDir, s.env);
  const reproPath = spec.reproducibleBuildsPath ?? defaultReproducibleBuildsPath();

  const rskj = await resolveOneRelease(
    "rskj",
    rskjReleaseCoordinates(spec.rskjVersion),
    { cacheDir, reproPath, warnings },
    s,
  );
  const result: ResolvedBinaries = {
    rskjJarPath: rskj.path,
    provenance: { rskj },
    warnings,
  };

  if (spec.powpegVersion) {
    const powpeg = await resolveOneRelease(
      "powpeg",
      powpegReleaseCoordinates(spec.powpegVersion),
      { cacheDir, reproPath, warnings },
      s,
    );
    result.powpegJarPath = powpeg.path;
    result.provenance.powpeg = powpeg;
  }

  return result;
}

/* -------------------------------------------------------------------------- *
 * Per-component resolution
 * -------------------------------------------------------------------------- */

interface ReleaseContext {
  cacheDir: string;
  reproPath: string;
  warnings: string[];
}

async function resolveOneRelease(
  component: "rskj" | "powpeg",
  coords: ReleaseCoordinates,
  ctx: ReleaseContext,
  s: MaterializedSeams,
): Promise<BinaryProvenance> {
  const entryDir = join(ctx.cacheDir, "releases", component, coords.tag);

  // 1. Primary verification source: the local reproducible-builds clone.
  const expected = readExpectedFromReproducibleBuilds(coords, ctx, s);

  // 2. Cache check. With a known expected sha the entry must match it;
  //    without one (stale repro clone) a self-consistent entry is
  //    accepted as-is so warm-cache runs stay offline.
  const cached = await validateCacheEntry(entryDir, expected?.sha256 ?? null, s);
  if (cached.valid) {
    s.log(`[build:release] ${component} ${coords.tag}: cache hit at ${cached.jarPath}`);
    return {
      component,
      mode: "release",
      path: cached.jarPath!,
      sha256: cached.sha256!,
      version: coords.version,
      releaseTag: coords.tag,
      verification: expected?.source ?? recordedVerification(entryDir, s),
      cacheHit: true,
    };
  }

  // 3. Cache miss — download into a tmp dir and promote atomically.
  const tmpDir = `${entryDir}.tmp.${s.pid}`;
  s.mkdirFn(tmpDir);
  try {
    let expectedSha = expected?.sha256;
    let verification: ReleaseVerificationSource = "reproducible-builds";
    if (!expectedSha) {
      // Stale local reproducible-builds clone → fall back to the
      // release's own checksum file, and say so loudly.
      const warning =
        `reproducible-builds has no entry for ${component} ${coords.tag} ` +
        `(looked in ${join(ctx.reproPath, coords.reproducibleDir)}); ` +
        `falling back to the GitHub release's ${SHA256SUMS_ASSET}. ` +
        `Pull the reproducible-builds repo to restore independent verification.`;
      ctx.warnings.push(warning);
      s.log(`[build:release] WARNING: ${warning}`);
      const sumsPath = join(tmpDir, SHA256SUMS_ASSET);
      await s.downloadFn(releaseAssetUrl(coords, SHA256SUMS_ASSET), sumsPath);
      const fromSums = extractSha256ForAsset(s.readFileFn(sumsPath), coords.assetName);
      if (!fromSums) {
        throw new Error(
          `${SHA256SUMS_ASSET} for ${coords.tag} has no line for ${coords.assetName} — ` +
            `cannot verify the download; refusing to continue.`,
        );
      }
      expectedSha = fromSums;
      verification = "release-sha256sums";
    }

    const jarUrl = releaseAssetUrl(coords, coords.assetName);
    const jarTmpPath = join(tmpDir, coords.assetName);
    s.log(`[build:release] ${component} ${coords.tag}: downloading ${jarUrl}`);
    await s.downloadFn(jarUrl, jarTmpPath);

    const actualSha = await s.sha256FileFn(jarTmpPath);
    if (actualSha !== expectedSha) {
      throw new Error(
        `sha256 mismatch for ${coords.assetName}: expected ${expectedSha} ` +
          `(${verification}), downloaded file hashes to ${actualSha}. ` +
          `Refusing to cache a jar that fails verification.`,
      );
    }

    s.writeFileFn(
      join(tmpDir, "source.json"),
      JSON.stringify(
        {
          component,
          repo: coords.repo,
          tag: coords.tag,
          version: coords.version,
          assetName: coords.assetName,
          url: jarUrl,
          sha256: actualSha,
          verification,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    finalizeCacheEntry(tmpDir, entryDir, coords.assetName, actualSha, s);

    const jarPath = join(entryDir, coords.assetName);
    s.log(`[build:release] ${component} ${coords.tag}: verified (${verification}) → ${jarPath}`);
    return {
      component,
      mode: "release",
      path: jarPath,
      sha256: actualSha,
      version: coords.version,
      releaseTag: coords.tag,
      verification,
      cacheHit: false,
    };
  } catch (err) {
    // Never leave a half-written tmp dir behind.
    try {
      s.rmFn(tmpDir);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function releaseAssetUrl(coords: ReleaseCoordinates, assetName: string): string {
  return `https://github.com/${coords.repo}/releases/download/${coords.tag}/${assetName}`;
}

function readExpectedFromReproducibleBuilds(
  coords: ReleaseCoordinates,
  ctx: ReleaseContext,
  s: MaterializedSeams,
): { sha256: string; source: ReleaseVerificationSource } | null {
  const readmePath = join(ctx.reproPath, coords.reproducibleDir, "README.md");
  if (!s.existsFn(readmePath)) {
    return null;
  }
  let text: string;
  try {
    text = s.readFileFn(readmePath);
  } catch {
    return null;
  }
  const sha256 = extractSha256ForAsset(text, coords.assetName);
  if (!sha256) {
    const warning =
      `${readmePath} exists but has no sha256 line for ${coords.assetName}; ` +
      `treating the reproducible-builds entry as unusable.`;
    ctx.warnings.push(warning);
    s.log(`[build:release] WARNING: ${warning}`);
    return null;
  }
  return { sha256, source: "reproducible-builds" };
}

/**
 * On a cache hit with no live reproducible-builds entry, surface the
 * verification source recorded at download time instead of guessing.
 */
function recordedVerification(
  entryDir: string,
  s: MaterializedSeams,
): ReleaseVerificationSource | undefined {
  try {
    const source = JSON.parse(s.readFileFn(join(entryDir, "source.json"))) as {
      verification?: ReleaseVerificationSource;
    };
    return source.verification;
  } catch {
    return undefined;
  }
}
