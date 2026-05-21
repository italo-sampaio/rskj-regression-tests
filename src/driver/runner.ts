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
  /**
   * Inject directory + file-write functions for tests so the runner can
   * be exercised end-to-end without touching the real filesystem.
   * Default = `mkdirSync(recursive: true)` and `writeFileSync`.
   */
  mkdirFn?: (p: string) => void;
  writeFileFn?: (p: string, contents: string) => void;
  /** Optional logger for high-level progress. Defaults to console.log. */
  log?: (line: string) => void;
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

  const preset = getPreset(config.preset);
  const startedAt = new Date().toISOString();

  log(`[driver] run-id=${config.runId} preset=${preset.name} rpc-url=${config.rpcUrl}`);
  log(`[driver] output-dir=${config.outputDir}`);
  log(`[driver] failure policy: ${config.failFast ? "fail-fast" : "run-all"}`);
  log(`[driver] suites to run: ${preset.runs.map((r) => r.name).join(", ")}`);

  mkdirFn(config.outputDir);

  const suites: UnifiedSuite[] = [];
  let stoppedEarly = false;

  for (const run of preset.runs) {
    log(`[driver] → ${run.kind} :: ${run.name}`);
    const suite = await runOne(run, config, { hardhatRunner, k6Runner, log });
    suites.push(suite);
    log(
      `[driver] ← ${run.name}: ${suite.verdict.passed_overall ? "PASSED" : "FAILED"} ` +
        `(${suite.verdict.passed}/${suite.verdict.total} passed, ` +
        `${suite.verdict.failed} failed, ${suite.verdict.errored} errored)`,
    );
    if (config.failFast && !suite.verdict.passed_overall) {
      log("[driver] --fail-fast set and suite did not pass; skipping remaining suites.");
      stoppedEarly = true;
      break;
    }
  }

  const endedAt = new Date().toISOString();
  const metadata: ReportMetadata = {
    runId: config.runId,
    startedAt,
    endedAt,
    network: config.hardhatNetwork,
    rpcUrl: config.rpcUrl,
    labels: {
      preset: preset.name,
      failurePolicy: config.failFast ? "fail-fast" : "run-all",
      ...(stoppedEarly ? { stoppedEarly: "true" } : {}),
    },
  };
  if (config.rskjVersion) {
    metadata.rskjVersion = config.rskjVersion;
  }
  const report = buildUnifiedReport(metadata, suites);

  const jsonPath = resolve(config.outputDir, "report.json");
  const xmlPath = resolve(config.outputDir, "report.xml");
  const mdPath = resolve(config.outputDir, "report.md");
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

  return {
    report,
    artifacts: { json: jsonPath, xml: xmlPath, markdown: mdPath },
  };
}

interface DispatchContext {
  hardhatRunner: typeof runHardhat;
  k6Runner: typeof runK6;
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
  // k6
  const { suite } = await ctx.k6Runner(run, {
    k6TestsPath: config.k6TestsPath,
    rpcUrl: config.rpcUrl,
    log: ctx.log,
  });
  return suite;
}

/**
 * Map a {@link DriverResult} to a process exit code.
 *
 * @returns 0 when the overall verdict passed, 1 otherwise.
 */
export function exitCodeFor(result: DriverResult): number {
  return result.report.overall.passed_overall ? 0 : 1;
}
