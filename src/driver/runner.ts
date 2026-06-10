/**
 * Driver orchestrator — resolves a preset, runs each suite in order,
 * aggregates outputs via the existing adapters, and writes the unified
 * report bundle to disk.
 *
 * Pipeline (per invocation):
 *
 *   1. Lookup the preset by name → list of suite runs.
 *   2. Create the output directory.
 *   3. For each suite run, hand it to its runner. The runner shells out
 *      to the underlying tool, captures the suite's native output, and
 *      returns a {@link UnifiedSuite}.
 *   4. If `failFast` is on AND a suite produced `passed_overall: false`,
 *      stop iterating. Subsequent suites are skipped (and excluded from
 *      the report — they didn't run).
 *   5. Aggregate all completed suites via {@link buildUnifiedReport}.
 *   6. Emit:
 *        - `report.json` — the canonical UnifiedReport
 *        - `report.xml`  — JUnit XML projection (for CI gating)
 *        - `report.md`   — Markdown summary (for humans)
 *   7. Return the report so the CLI can derive an exit code from
 *      `overall.passed_overall`.
 *
 * Failure policy is intentionally minimal for the POC: `failFast` only
 * looks at the suite verdict, not at the runner's exit code. That keeps
 * the contract single-axis: the report's overall verdict is the source
 * of truth, both for fail-fast skips and for the driver's exit code.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { adaptHardhatJUnit } from "../adapters/junit-xml.js";
import { adaptK6Summary } from "../adapters/k6.js";
import { resolveBinaries } from "../build/resolve-binaries.js";
import type { ResolvedBinaries } from "../build/types.js";
import { startRskjNode } from "../orchestrator/start-rskj-node.js";
import { startFullTopology } from "../orchestrator/start-topology.js";
import type { FullTopologyHandle } from "../orchestrator/start-topology.js";
import type { RskjNodeHandle } from "../orchestrator/topology.js";
import {
  buildUnifiedReport,
  type ReportMetadata,
  type UnifiedReport,
  type UnifiedSuite,
} from "../report/schema.js";
import { renderJUnitXml } from "../report/junit.js";
import { renderMarkdown } from "../report/markdown.js";
import type { DriverConfig } from "./config.js";
import { getPreset } from "./presets.js";
import type { SuiteRun } from "./presets.js";
import { runHardhat } from "./runners/hardhat.js";
import { runK6 } from "./runners/k6.js";
import { runRit } from "./runners/rit.js";

// Re-export so the cli module has one import surface for adapter symbols
// (used by docs / type-check chains in downstream code).
export { adaptHardhatJUnit, adaptK6Summary };

/** Result returned by {@link runDriver}. */
export interface DriverResult {
  /** The aggregated unified report — what gets written to disk as JSON. */
  report: UnifiedReport;
  /** Absolute paths of every artifact written by the driver. */
  artifacts: {
    json: string;
    xml: string;
    markdown: string;
  };
}

/** Test-friendly seam: lets callers inject runners (default = the real ones). */
export interface RunnerOverrides {
  hardhat?: typeof runHardhat;
  k6?: typeof runK6;
  /** Inject the RIT runner — tests pass a fake; production uses {@link runRit}. */
  rit?: typeof runRit;
  /**
   * Inject directory + file-write functions for tests so the runner can
   * be exercised end-to-end without touching the real filesystem.
   * Default = `mkdirSync(recursive: true)` and `writeFileSync`.
   */
  mkdirFn?: (p: string) => void;
  writeFileFn?: (p: string, contents: string) => void;
  /** Optional logger for high-level progress. Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Override the orchestrator entry point — used by `--auto-node` tests
   * to inject a stub handle without spawning a JVM. Production callers
   * omit this.
   */
  startNodeFn?: typeof startRskjNode;
  /**
   * Override the full-topology entry point — used by `--auto-node` tests of
   * a `requiresTopology` preset to inject a stub handle without spawning
   * bitcoind + four JVMs. Production callers omit this.
   */
  startTopologyFn?: typeof startFullTopology;
  /**
   * Override the build-sourcing resolver — used by tests to inject a
   * stub {@link ResolvedBinaries} without downloading / building
   * anything. Production callers omit this.
   */
  resolveBinariesFn?: typeof resolveBinaries;
}

/**
 * Execute a driver run end-to-end.
 *
 * @param config    Fully-resolved driver configuration (from {@link resolveConfig}).
 * @param overrides Test seams. Production callers omit this.
 * @returns         The aggregated report plus paths to the artifacts written.
 */
export async function runDriver(
  config: DriverConfig,
  overrides: RunnerOverrides = {},
): Promise<DriverResult> {
  const log = overrides.log ?? ((line: string) => console.log(line));
  const mkdirFn = overrides.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const writeFileFn = overrides.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c));
  const hardhatRunner = overrides.hardhat ?? runHardhat;
  const k6Runner = overrides.k6 ?? runK6;
  const ritRunner = overrides.rit ?? runRit;
  const startNodeFn = overrides.startNodeFn ?? startRskjNode;
  const startTopologyFn = overrides.startTopologyFn ?? startFullTopology;
  const resolveBinariesFn = overrides.resolveBinariesFn ?? resolveBinaries;

  const preset = getPreset(config.preset);
  const startedAt = new Date().toISOString();

  // When --auto-node is set, spin the orchestrator up before any suite
  // runs. The resulting `rpcUrl` is patched onto the (otherwise immutable)
  // config so suites and the report metadata see the same value.
  let nodeHandle: RskjNodeHandle | null = null;
  let topologyHandle: FullTopologyHandle | null = null;
  let effectiveConfig = config;
  let resolvedBinaries: ResolvedBinaries | null = null;
  if (config.autoNode) {
    // Resolve binaries BEFORE starting the node. Custom mode validates +
    // fingerprints, release mode downloads + verifies, sha mode
    // clones + builds (or serves all of these from the cache). Only the
    // rskj jar is consumed today; powpeg / tcpsigner resolution is
    // recorded in the report for the upcoming full-topology task.
    let rskjJarPath = config.rskjJarPath;
    if (config.buildSpec) {
      log(`[driver] resolving binaries (build mode: ${config.buildSpec.mode})`);
      resolvedBinaries = await resolveBinariesFn(config.buildSpec, {
        log: (line: string) => log(`[build] ${line}`),
      });
      for (const warning of resolvedBinaries.warnings) {
        log(`[driver] WARNING: ${warning}`);
      }
      if (!resolvedBinaries.rskjJarPath) {
        throw new Error(
          "--auto-node needs an rskj jar but the build spec resolved none " +
            "(sha mode with only --powpeg-sha?).",
        );
      }
      rskjJarPath = resolvedBinaries.rskjJarPath;
    }
    if (!rskjJarPath) {
      throw new Error(
        "internal: autoNode set without rskjJarPath or buildSpec; " +
          "resolveConfig should have caught this",
      );
    }
    if (preset.requiresTopology) {
      // Full-topology preset: bring up bitcoind + 3 federators + the vanilla
      // miner, and point the node-facing suites (hardhat / k6) at the miner.
      // The miner runs its autominer (minerAutomine) because those suites
      // never call evm_mine; this is exact-K-safe (single producer, no
      // concurrent evm_mine). RIT still self-orchestrates its own cluster.
      const powpegJarPath = resolvedBinaries?.powpegJarPath ?? config.powpegJarPath;
      if (!powpegJarPath) {
        throw new Error(
          `preset "${preset.name}" requires a powpeg jar for the full topology — ` +
            "pass --powpeg-jar <path> or a build spec that resolves one.",
        );
      }
      log(`[driver] --auto-node + full topology; rskj=${rskjJarPath} powpeg=${powpegJarPath}`);
      topologyHandle = await startTopologyFn({
        powpegJarPath,
        rskjJarPath,
        minerAutomine: true,
        log: (line: string) => log(`[topology] ${line}`),
      });
      log(`[driver] topology up; mining node at ${topologyHandle.miningRpcUrl}`);
      effectiveConfig = { ...config, rpcUrl: topologyHandle.miningRpcUrl };
    } else {
      log(`[driver] --auto-node set; spinning up rskj regtest node from ${rskjJarPath}`);
      nodeHandle = await startNodeFn({
        jarPath: rskjJarPath,
        log: (line: string) => log(`[rskj] ${line}`),
      });
      log(`[driver] node pid=${nodeHandle.pid} rpc=${nodeHandle.rpcUrl} p2p=${nodeHandle.p2pPort}`);
      log(`[driver] waiting for RPC readiness...`);
      await nodeHandle.ready();
      log(`[driver] node ready at ${nodeHandle.rpcUrl}`);
      effectiveConfig = { ...config, rpcUrl: nodeHandle.rpcUrl };
    }
  }

  log(
    `[driver] run-id=${effectiveConfig.runId} preset=${preset.name} rpc-url=${effectiveConfig.rpcUrl}`,
  );
  log(`[driver] output-dir=${effectiveConfig.outputDir}`);
  log(`[driver] failure policy: ${effectiveConfig.failFast ? "fail-fast" : "run-all"}`);
  log(`[driver] suites to run: ${preset.runs.map((r) => r.name).join(", ")}`);

  mkdirFn(effectiveConfig.outputDir);

  const suites: UnifiedSuite[] = [];
  let stoppedEarly = false;
  let report: UnifiedReport;
  let jsonPath = "";
  let xmlPath = "";
  let mdPath = "";

  try {
    for (const run of preset.runs) {
      log(`[driver] → ${run.kind} :: ${run.name}`);
      const suite = await runOne(run, effectiveConfig, { hardhatRunner, k6Runner, ritRunner, log });
      suites.push(suite);
      log(
        `[driver] ← ${run.name}: ${suite.verdict.passed_overall ? "PASSED" : "FAILED"} ` +
          `(${suite.verdict.passed}/${suite.verdict.total} passed, ` +
          `${suite.verdict.failed} failed, ${suite.verdict.errored} errored)`,
      );
      if (effectiveConfig.failFast && !suite.verdict.passed_overall) {
        log("[driver] --fail-fast set and suite did not pass; skipping remaining suites.");
        stoppedEarly = true;
        break;
      }
    }

    const endedAt = new Date().toISOString();
    const metadata: ReportMetadata = {
      runId: effectiveConfig.runId,
      startedAt,
      endedAt,
      network: effectiveConfig.hardhatNetwork,
      rpcUrl: effectiveConfig.rpcUrl,
      labels: {
        preset: preset.name,
        failurePolicy: effectiveConfig.failFast ? "fail-fast" : "run-all",
        ...(stoppedEarly ? { stoppedEarly: "true" } : {}),
        ...(effectiveConfig.autoNode ? { autoNode: "true" } : {}),
        ...(effectiveConfig.buildSpec ? { buildMode: effectiveConfig.buildSpec.mode } : {}),
        ...(resolvedBinaries ? provenanceLabels(resolvedBinaries) : {}),
      },
    };
    if (effectiveConfig.rskjVersion) {
      metadata.rskjVersion = effectiveConfig.rskjVersion;
    } else if (resolvedBinaries?.provenance.rskj?.version) {
      // Release / sha modes know the version they resolved; surface it
      // when the caller didn't label the run explicitly.
      metadata.rskjVersion = resolvedBinaries.provenance.rskj.version;
    }
    report = buildUnifiedReport(metadata, suites);

    jsonPath = resolve(effectiveConfig.outputDir, "report.json");
    xmlPath = resolve(effectiveConfig.outputDir, "report.xml");
    mdPath = resolve(effectiveConfig.outputDir, "report.md");
    writeFileFn(jsonPath, JSON.stringify(report, null, 2) + "\n");
    writeFileFn(xmlPath, renderJUnitXml(report));
    writeFileFn(mdPath, renderMarkdown(report));

    log(`[driver] wrote ${jsonPath}`);
    log(`[driver] wrote ${xmlPath}`);
    log(`[driver] wrote ${mdPath}`);
    log(
      `[driver] overall: ${report.overall.passed_overall ? "PASSED" : "FAILED"} ` +
        `(${report.overall.passed}/${report.overall.total} passed across ${suites.length} suites)`,
    );
  } finally {
    // Guarantee the JVM is torn down even when a suite (or the report
    // emit step) throws. Stop is idempotent so a clean run hitting this
    // a second time on a re-throw is fine.
    if (nodeHandle) {
      log("[driver] stopping auto-node");
      try {
        await nodeHandle.stop();
      } catch (err) {
        log(`[driver] auto-node stop failed: ${(err as Error).message}`);
      }
    }
    if (topologyHandle) {
      log("[driver] tearing down full topology");
      try {
        await topologyHandle.stop();
      } catch (err) {
        log(`[driver] topology teardown failed: ${(err as Error).message}`);
      }
    }
  }

  return {
    report: report!,
    artifacts: { json: jsonPath, xml: xmlPath, markdown: mdPath },
  };
}

interface DispatchContext {
  hardhatRunner: typeof runHardhat;
  k6Runner: typeof runK6;
  ritRunner: typeof runRit;
  log: (line: string) => void;
}

async function runOne(
  run: SuiteRun,
  config: DriverConfig,
  ctx: DispatchContext,
): Promise<UnifiedSuite> {
  if (run.kind === "hardhat") {
    const { suite } = await ctx.hardhatRunner(run, {
      hardhatTestsPath: config.hardhatTestsPath,
      rpcUrl: config.rpcUrl,
      network: config.hardhatNetwork,
      log: ctx.log,
    });
    return suite;
  }
  if (run.kind === "rit") {
    // RIT self-orchestrates — it ignores autoNode / rpcUrl entirely. It needs
    // the powpeg fat JAR; surface a clear error if the caller didn't supply
    // one (preset author chose a RIT run, so this is operator error).
    if (!config.powpegJarPath) {
      throw new Error(
        "RIT suite requires a powpeg fat JAR. Pass --powpeg-jar <path> " +
          "or set the POWPEG_NODE_JAR_PATH env var.",
      );
    }
    const { suite } = await ctx.ritRunner(run, {
      ritTestsPath: config.ritTestsPath,
      powpegJarPath: config.powpegJarPath,
      reportPath: resolve(config.outputDir, run.reportRelPath),
      log: ctx.log,
    });
    return suite;
  }
  // k6
  const { suite } = await ctx.k6Runner(run, {
    k6TestsPath: config.k6TestsPath,
    rpcUrl: config.rpcUrl,
    log: ctx.log,
  });
  return suite;
}

/**
 * Project binary provenance into flat report-metadata labels so a
 * report alone answers "exactly which binaries did this run use?".
 * powpeg / tcpsigner aren't consumed by the driver yet — recording
 * them is the contract until the full-topology task starts launching
 * them.
 */
function provenanceLabels(resolved: ResolvedBinaries): Record<string, string> {
  const labels: Record<string, string> = {};
  const { rskj, powpeg, tcpsigner } = resolved.provenance;
  if (rskj) {
    labels.rskjSha256 = rskj.sha256;
    if (rskj.releaseTag) labels.rskjReleaseTag = rskj.releaseTag;
    if (rskj.commitSha) labels.rskjCommitSha = rskj.commitSha;
  }
  if (powpeg) {
    labels.powpegJarPath = powpeg.path;
    labels.powpegSha256 = powpeg.sha256;
    if (powpeg.releaseTag) labels.powpegReleaseTag = powpeg.releaseTag;
    if (powpeg.commitSha) labels.powpegCommitSha = powpeg.commitSha;
  }
  if (tcpsigner) {
    labels.tcpsignerPath = tcpsigner.path;
    labels.tcpsignerSha256 = tcpsigner.sha256;
  }
  return labels;
}

/**
 * Map a {@link DriverResult} to a process exit code.
 *
 * @returns 0 when the overall verdict passed, 1 otherwise.
 */
export function exitCodeFor(result: DriverResult): number {
  return result.report.overall.passed_overall ? 0 : 1;
}
