/**
 * Public surface of the build-sourcing library.
 *
 * Consumers should import from this barrel rather than reaching into
 * individual files — the mode internals may shuffle as the
 * full-topology task starts consuming powpeg + tcpsigner.
 *
 * The one call that matters:
 *
 *   const resolved = await resolveBinaries({ mode: "release", rskjVersion: "9.0.1" });
 *   // resolved.rskjJarPath, resolved.provenance.rskj.sha256, ...
 *
 * See `docs/build-sourcing-modes.md` for the full reference.
 */

export { resolveBinaries } from "./resolve-binaries.js";
export { resolveCustom } from "./custom-mode.js";
export { resolveRelease, defaultReproducibleBuildsPath } from "./release-mode.js";
export { resolveSha } from "./sha-mode.js";
export { defaultCacheDir } from "./cache.js";
export { extractSha256ForAsset } from "./checksums.js";
export { powpegReleaseCoordinates, rskjReleaseCoordinates } from "./versions.js";
export type { ReleaseCoordinates } from "./versions.js";
export type { BuildSeams, FileStat } from "./seams.js";
export type {
  BinaryProvenance,
  BuildComponent,
  BuildMode,
  BuildSourceSpec,
  CustomBuildSpec,
  ReleaseBuildSpec,
  ReleaseVerificationSource,
  ResolvedBinaries,
  ShaBuildSpec,
} from "./types.js";
