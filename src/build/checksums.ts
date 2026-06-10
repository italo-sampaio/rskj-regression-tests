/**
 * Checksum-text parsing for release verification.
 *
 * Two documents publish the expected sha256 of a release jar, and both
 * happen to use the same `sha256sum`-style line format
 * (`<64 hex chars><whitespace><filename>`):
 *
 *   1. The reproducible-builds repo's per-version `README.md` — the
 *      hashes appear INLINE in a "Verify" code fence (the release dirs
 *      contain only `Dockerfile` + `README.md`, no checksum files):
 *
 *          f120a63d…c94c8a8f  rskj-core-9.0.0-VETIVER-all.jar
 *
 *   2. The GitHub release's `SHA256SUMS.asc` — a clear-signed PGP
 *      message whose body is plain sha256sum lines. We only parse the
 *      sha line for the asset we care about; signature verification is
 *      out of scope for v1 (the reproducible-builds path is the
 *      primary trust anchor, and the fallback is flagged in
 *      provenance + warnings).
 *
 * One line-oriented parser covers both. It scans every line for the
 * exact asset name so surrounding prose, fences, and PGP armor are
 * ignored for free.
 */

/** `sha256sum` line shape: hash, whitespace, filename. */
const SUM_LINE = /^([0-9a-f]{64})\s+(\S+)\s*$/;

/**
 * Find the sha256 for `assetName` in a sha256sum-style document
 * (reproducible-builds README or SHA256SUMS.asc).
 *
 * @returns the lowercase hex digest, or `null` when no line names the asset.
 */
export function extractSha256ForAsset(text: string, assetName: string): string | null {
  for (const rawLine of text.split("\n")) {
    const match = SUM_LINE.exec(rawLine.trim());
    if (match && match[2] === assetName) {
      return match[1]!;
    }
  }
  return null;
}
