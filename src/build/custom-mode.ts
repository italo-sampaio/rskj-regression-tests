/**
 * Mode 2 — custom prebuilt binaries.
 *
 * The user already has the artifacts (a local `./gradlew fatJar`
 * output, a jar scp'd off a test host, ...). Our job here is NOT to
 * trust-check them — it's to (a) fail fast with a clear message when a
 * path is wrong, and (b) fingerprint what actually ran (size + sha256)
 * so the report's provenance answers "which binary was this?" months
 * later.
 *
 * Validation policy:
 *
 *   - Every supplied path must exist and be a regular file — hard error.
 *   - The powpeg jar SHOULD match the release naming
 *     `/federate-node.+-all\.jar$/` (launched via
 *     `java -cp <jar> co.rsk.federate.FederateRunner`), but local
 *     builds legitimately vary (e.g.
 *     `federate-node-gaslimit-RC1-9.1.0.0-all.jar`), so a mismatch
 *     only WARNS. Same spirit for the rskj jar: the canonical launch is
 *     `java -cp <jar> co.rsk.Start` (the fat-jar manifest is broken,
 *     `-jar` never works), and the orchestrator already does that — no
 *     name check enforced here.
 *   - A tcpsigner without the executable bit gets a warning; the
 *     full-topology task is the actual consumer and will fail louder.
 */

import { basename, isAbsolute, resolve } from "node:path";
import { materializeSeams, type BuildSeams, type MaterializedSeams } from "./seams.js";
import type { BinaryProvenance, CustomBuildSpec, ResolvedBinaries } from "./types.js";

/** Release-style powpeg fat-jar naming. Mismatch warns, never fails. */
const POWPEG_JAR_PATTERN = /federate-node.+-all\.jar$/;

/** Resolve a {@link CustomBuildSpec}: validate paths, fingerprint files. */
export async function resolveCustom(
  spec: CustomBuildSpec,
  seams: BuildSeams = {},
): Promise<ResolvedBinaries> {
  const s = materializeSeams(seams);
  const warnings: string[] = [];

  const rskj = await fingerprint("rskj", spec.rskjJar, "--rskj-jar", s);
  const result: ResolvedBinaries = {
    rskjJarPath: rskj.path,
    provenance: { rskj },
    warnings,
  };

  if (spec.powpegJar) {
    const powpeg = await fingerprint("powpeg", spec.powpegJar, "--powpeg-jar", s);
    if (!POWPEG_JAR_PATTERN.test(basename(powpeg.path))) {
      warnings.push(
        `powpeg jar "${basename(powpeg.path)}" does not match the release naming ` +
          `(federate-node…-all.jar) — make sure it is a fat JAR with ` +
          `co.rsk.federate.FederateRunner on the classpath.`,
      );
    }
    result.powpegJarPath = powpeg.path;
    result.provenance.powpeg = powpeg;
  }

  if (spec.tcpsigner) {
    const tcpsigner = await fingerprint("tcpsigner", spec.tcpsigner, "--tcpsigner", s);
    if ((s.statFn(tcpsigner.path).mode & 0o111) === 0) {
      warnings.push(`tcpsigner "${tcpsigner.path}" is not executable (chmod +x it before use).`);
    }
    result.tcpsignerPath = tcpsigner.path;
    result.provenance.tcpsigner = tcpsigner;
  }

  return result;
}

async function fingerprint(
  component: BinaryProvenance["component"],
  path: string,
  flagLabel: string,
  s: MaterializedSeams,
): Promise<BinaryProvenance> {
  const abs = isAbsolute(path) ? path : resolve(path);
  if (!s.existsFn(abs)) {
    throw new Error(`${flagLabel} path does not exist: ${abs}`);
  }
  const stat = s.statFn(abs);
  if (!stat.isFile()) {
    throw new Error(`${flagLabel} path is not a regular file: ${abs}`);
  }
  const sha256 = await s.sha256FileFn(abs);
  s.log(`[build:custom] ${component}: ${abs} (${stat.size} bytes, sha256 ${sha256})`);
  return {
    component,
    mode: "custom",
    path: abs,
    sha256,
    sizeBytes: stat.size,
  };
}
