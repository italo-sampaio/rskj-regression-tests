/**
 * Build-sourcing types — the public contract for "where do the binaries
 * come from?".
 *
 * The driver (and, later, the full-topology orchestrator) needs up to
 * three artifacts per run: the rskj fat JAR, the powpeg-node fat JAR,
 * and a tcpsigner binary. {@link BuildSourceSpec} is a discriminated
 * union over the three supported sourcing modes:
 *
 *   - `"release"` — pin a published GitHub release tag. Jars are
 *     downloaded once into a local cache and verified against the
 *     sha256 published in the reproducible-builds repo (or, when the
 *     local reproducible-builds clone is stale, against the release's
 *     own `SHA256SUMS.asc`).
 *   - `"custom"`  — point at prebuilt files on disk. No downloads, no
 *     builds; we only validate the paths and record size + sha256 so
 *     the report says exactly what ran.
 *   - `"sha"`     — build from an arbitrary git ref of rsksmart/rskj
 *     and/or rsksmart/powpeg-node. Clones are cached as bare repos,
 *     refs are normalized to 40-char commit SHAs, and finished jars
 *     are cached per-SHA so re-running the same ref never rebuilds.
 *
 * v1 scope (keyfile-only): build-from-SHA covers rskj + powpeg-node
 * ONLY. tcpsigner is never built — it is exclusively a user-supplied
 * path in custom mode. rsk-powhsm builds are out of scope.
 *
 * Every resolved component carries a {@link BinaryProvenance} record so
 * the unified report can label runs with the exact binary identity
 * (mode, version/tag/commit, sha256). Reproducibility-by-record is the
 * whole point: two reports with the same `rskjSha256` ran the same
 * code, whatever mode produced it.
 */

/** The three supported sourcing modes. */
export type BuildMode = "release" | "custom" | "sha";

/** Components the resolver knows about. */
export type BuildComponent = "rskj" | "powpeg" | "tcpsigner";

/**
 * Mode 1 — pin a published release.
 *
 * Versions are accepted in three spellings and normalized internally:
 * plain (`"9.0.1"`), tag form (`"VETIVER-9.0.1"`), or
 * reproducible-builds dir form (`"9.0.1-vetiver"`). Plain versions
 * infer the codename from the major number (9 → VETIVER, 8 → REED,
 * ...); for majors the harness doesn't know, pass the tag form.
 */
export interface ReleaseBuildSpec {
  mode: "release";
  /** rskj release version, e.g. `"9.0.1"` or `"VETIVER-9.0.1"`. */
  rskjVersion: string;
  /** Optional powpeg-node release version, e.g. `"9.0.0.0"` or `"VETIVER-9.0.0.0"`. */
  powpegVersion?: string;
  /**
   * Local clone of rsksmart/reproducible-builds — the authoritative
   * source for expected sha256s. Defaults to
   * `~/workspace/reproducible-builds` (the team-convention checkout
   * location). When the per-version dir is missing there (stale
   * clone), the resolver falls back to the release's published
   * `SHA256SUMS.asc` and warns loudly.
   */
  reproducibleBuildsPath?: string;
  /** Download cache root. Default: see {@link defaultCacheDir}. */
  cacheDir?: string;
}

/**
 * Mode 2 — user-supplied prebuilt binaries.
 *
 * The only mode that can provide a tcpsigner. Paths are validated to
 * exist and be regular files; size + sha256 land in provenance.
 */
export interface CustomBuildSpec {
  mode: "custom";
  /** Path to a prebuilt rskj fat JAR (launched `java -cp <jar> co.rsk.Start`). */
  rskjJar: string;
  /**
   * Path to a prebuilt powpeg fat JAR (launched
   * `java -cp <jar> co.rsk.federate.FederateRunner`). Release jars
   * match `/federate-node.+-all\.jar$/`; local builds may not, so a
   * mismatch only warns — it never fails the resolution.
   */
  powpegJar?: string;
  /** Path to a tcpsigner binary. */
  tcpsigner?: string;
}

/**
 * Mode 3 — build from a git ref.
 *
 * At least one of `rskjRef` / `powpegRef` is required. Refs may be
 * branches, tags, or (short) SHAs; they are normalized via
 * `git rev-parse <ref>^{commit}` so every spelling of the same commit
 * shares one cache entry. Cache keys are never branch names.
 */
export interface ShaBuildSpec {
  mode: "sha";
  /** Git ref of rsksmart/rskj to build. */
  rskjRef?: string;
  /** Git ref of rsksmart/powpeg-node to build. */
  powpegRef?: string;
  /** Clone + build cache root. Default: see {@link defaultCacheDir}. */
  cacheDir?: string;
}

/** Discriminated union over the three sourcing modes. */
export type BuildSourceSpec = ReleaseBuildSpec | CustomBuildSpec | ShaBuildSpec;

/** How the sha256 of a downloaded release jar was cross-checked. */
export type ReleaseVerificationSource =
  /** Matched the sha256 published in the reproducible-builds repo README. */
  | "reproducible-builds"
  /** reproducible-builds had no entry; matched the release's own SHA256SUMS.asc. */
  | "release-sha256sums";

/** Identity record for one resolved binary. */
export interface BinaryProvenance {
  component: BuildComponent;
  mode: BuildMode;
  /** Absolute path of the binary that will be used. */
  path: string;
  /** sha256 (hex) of the file at `path`. */
  sha256: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Human version string (release version, or version baked into the built jar name). */
  version?: string;
  /** Release mode: the GitHub release tag the jar came from. */
  releaseTag?: string;
  /** Release mode: where the expected sha256 came from. */
  verification?: ReleaseVerificationSource;
  /** Sha mode: the ref exactly as the caller gave it. */
  ref?: string;
  /** Sha mode: the normalized 40-char commit SHA actually built. */
  commitSha?: string;
  /** Release / sha modes: true when served from the cache without re-fetching / rebuilding. */
  cacheHit?: boolean;
}

/** What {@link resolveBinaries} hands back to the driver / orchestrator. */
export interface ResolvedBinaries {
  /**
   * Absolute path to the rskj fat JAR. Optional only because a
   * sha-mode spec may build powpeg alone; the driver's `--auto-node`
   * path requires it and errors when absent.
   */
  rskjJarPath?: string;
  /** Absolute path to the powpeg fat JAR, when the spec produced one. */
  powpegJarPath?: string;
  /** Absolute path to the tcpsigner binary, when the spec supplied one. */
  tcpsignerPath?: string;
  /** Per-component identity records. */
  provenance: {
    rskj?: BinaryProvenance;
    powpeg?: BinaryProvenance;
    tcpsigner?: BinaryProvenance;
  };
  /**
   * Non-fatal findings (stale reproducible-builds clone, odd powpeg
   * jar name, ...). The driver logs these; they never fail a run.
   */
  warnings: string[];
}
