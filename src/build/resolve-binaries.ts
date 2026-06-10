/**
 * Build-sourcing entry point — validate the spec, dispatch to the mode
 * resolver.
 *
 * One front door keeps the driver (and future topology orchestrator)
 * ignorant of mode internals: hand in a {@link BuildSourceSpec}, get
 * back paths + provenance. Spec-shape errors are caught HERE, before
 * any mode logic runs, so a typo'd spec fails with "what's wrong with
 * the spec" rather than a download / git error three layers deep.
 */

import { resolveCustom } from "./custom-mode.js";
import { resolveRelease } from "./release-mode.js";
import { resolveSha } from "./sha-mode.js";
import type { BuildSeams } from "./seams.js";
import type { BuildSourceSpec, ResolvedBinaries } from "./types.js";

/**
 * Resolve the binaries described by `spec`.
 *
 * @param spec  Discriminated over `mode`: `"release" | "custom" | "sha"`.
 * @param seams Test seams. Production callers omit this (or pass just `log`).
 * @throws Error on an invalid spec, failed verification, or failed build.
 */
export async function resolveBinaries(
  spec: BuildSourceSpec,
  seams: BuildSeams = {},
): Promise<ResolvedBinaries> {
  validateSpec(spec);
  switch (spec.mode) {
    case "release":
      return resolveRelease(spec, seams);
    case "custom":
      return resolveCustom(spec, seams);
    case "sha":
      return resolveSha(spec, seams);
  }
}

function validateSpec(spec: BuildSourceSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new Error("resolveBinaries: spec must be an object.");
  }
  switch (spec.mode) {
    case "release":
      if (!nonEmpty(spec.rskjVersion)) {
        throw new Error('resolveBinaries: release mode requires "rskjVersion".');
      }
      return;
    case "custom":
      if (!nonEmpty(spec.rskjJar)) {
        throw new Error('resolveBinaries: custom mode requires "rskjJar".');
      }
      return;
    case "sha":
      if (!nonEmpty(spec.rskjRef) && !nonEmpty(spec.powpegRef)) {
        throw new Error(
          'resolveBinaries: sha mode requires at least one of "rskjRef" / "powpegRef".',
        );
      }
      return;
    default:
      throw new Error(
        `resolveBinaries: unknown mode "${(spec as { mode?: unknown }).mode}" — ` +
          `expected "release", "custom", or "sha".`,
      );
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}
