/**
 * Release-version → tag / asset / reproducible-builds-dir mapping.
 *
 * The naming conventions differ per artifact and were verified against
 * the real repos (`gh release list` / `gh release view`, 2026-06):
 *
 *   rskj (3-component versions, e.g. 9.0.1):
 *     - release tag:        `VETIVER-9.0.1`            (CODENAME-x.y.z, uppercase)
 *     - fat-jar asset:      `rskj-core-9.0.1-VETIVER-all.jar`
 *     - checksums asset:    `SHA256SUMS.asc`
 *     - reproducible dir:   `rskj/9.0.1-vetiver`       (x.y.z-codename, lowercase)
 *
 *   powpeg-node (4-component versions, e.g. 9.0.0.0):
 *     - release tag:        `VETIVER-9.0.0.0`          (CODENAME-x.y.z.w, uppercase)
 *     - fat-jar asset:      `federate-node-VETIVER-9.0.0.0-all.jar`
 *     - checksums asset:    `SHA256SUMS.asc`
 *     - reproducible dir:   `powpeg-node/VETIVER-9.0.0.0` (same as the tag, uppercase)
 *
 * Codenames are alphabetical per major version. The map below covers
 * every release line the harness can meaningfully test against; for an
 * unknown major, callers must spell the codename out (tag or dir form)
 * rather than have us guess.
 */

/** Major version → release codename, as used in tags and asset names. */
const CODENAME_BY_MAJOR: Record<number, string> = {
  2: "PAPYRUS",
  3: "IRIS",
  4: "HOP",
  5: "FINGERROOT",
  6: "ARROWHEAD",
  7: "LOVELL",
  8: "REED",
  9: "VETIVER",
};

/** Everything release mode needs to locate + verify one component. */
export interface ReleaseCoordinates {
  /** Plain dotted version, e.g. `"9.0.1"`. */
  version: string;
  /** Uppercase codename, e.g. `"VETIVER"`. */
  codename: string;
  /** GitHub release tag, e.g. `"VETIVER-9.0.1"`. */
  tag: string;
  /** Fat-jar asset name on the release. */
  assetName: string;
  /** Path of the per-version dir inside the reproducible-builds repo. */
  reproducibleDir: string;
  /** GitHub `owner/repo` the release lives in. */
  repo: string;
}

/**
 * Resolve rskj release coordinates from any accepted spelling:
 * `"9.0.1"`, `"VETIVER-9.0.1"`, or `"9.0.1-vetiver"`.
 */
export function rskjReleaseCoordinates(input: string): ReleaseCoordinates {
  const { version, codename } = parseVersionInput(input, 3, "rskj");
  return {
    version,
    codename,
    tag: `${codename}-${version}`,
    assetName: `rskj-core-${version}-${codename}-all.jar`,
    reproducibleDir: `rskj/${version}-${codename.toLowerCase()}`,
    repo: "rsksmart/rskj",
  };
}

/**
 * Resolve powpeg-node release coordinates from any accepted spelling:
 * `"9.0.0.0"` or `"VETIVER-9.0.0.0"`.
 */
export function powpegReleaseCoordinates(input: string): ReleaseCoordinates {
  const { version, codename } = parseVersionInput(input, 4, "powpeg-node");
  const tag = `${codename}-${version}`;
  return {
    version,
    codename,
    tag,
    assetName: `federate-node-${tag}-all.jar`,
    // powpeg reproducible dirs are named exactly like the tag (uppercase).
    reproducibleDir: `powpeg-node/${tag}`,
    repo: "rsksmart/powpeg-node",
  };
}

/* -------------------------------------------------------------------------- *
 * Parsing
 * -------------------------------------------------------------------------- */

interface ParsedVersion {
  version: string;
  codename: string;
}

function parseVersionInput(input: string, components: number, label: string): ParsedVersion {
  const trimmed = input.trim();
  const versionPattern = `\\d+(?:\\.\\d+){${components - 1}}`;

  // Tag form: CODENAME-x.y.z (any case accepted, normalized to upper).
  const tagForm = new RegExp(`^([A-Za-z]+)-(${versionPattern})$`).exec(trimmed);
  if (tagForm) {
    return { version: tagForm[2]!, codename: tagForm[1]!.toUpperCase() };
  }

  // Reproducible-dir form: x.y.z-codename.
  const dirForm = new RegExp(`^(${versionPattern})-([A-Za-z]+)$`).exec(trimmed);
  if (dirForm) {
    return { version: dirForm[1]!, codename: dirForm[2]!.toUpperCase() };
  }

  // Plain form: x.y.z — infer the codename from the major number.
  const plainForm = new RegExp(`^(${versionPattern})$`).exec(trimmed);
  if (plainForm) {
    const version = plainForm[1]!;
    const major = Number(version.split(".")[0]);
    const codename = CODENAME_BY_MAJOR[major];
    if (!codename) {
      throw new Error(
        `Unknown ${label} major version ${major} in "${input}" — pass the full tag form ` +
          `(e.g. "CODENAME-${version}") so the codename doesn't have to be guessed.`,
      );
    }
    return { version, codename };
  }

  throw new Error(
    `Unrecognized ${label} release version "${input}". Expected ${components}-component ` +
      `forms like "9.0.1", "VETIVER-9.0.1", or "9.0.1-vetiver".`,
  );
}
