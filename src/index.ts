/**
 * Public surface of the rskj-regression driver / library.
 *
 * Re-exports the unified-report schema, the suite-output adapters, and
 * the driver entry points so consumers (and the binary stub at
 * `bin/rskj-regression.js`) compose them without reaching into internal
 * paths.
 *
 * See `docs/unified-report-format.md` for the full schema reference and
 * `docs/driver-poc.md` for the driver's CLI surface.
 */

export const VERSION = "0.0.1";

export function describe(): string {
  return `rskj-regression v${VERSION} (driver POC + report format + adapters)`;
}

// Unified report schema + helpers
export {
  UNIFIED_REPORT_SCHEMA_VERSION,
  buildUnifiedReport,
  computeOverallVerdict,
  computeSuiteVerdict,
} from "./report/schema.js";
export type {
  OverallVerdict,
  ReportMetadata,
  SuiteKind,
  SuiteVerdict,
  TestStatus,
  UnifiedFailure,
  UnifiedReport,
  UnifiedSuite,
  UnifiedTestCase,
} from "./report/schema.js";

// Emitters
export { renderJUnitXml } from "./report/junit.js";
export { renderMarkdown } from "./report/markdown.js";

// Adapters
export { adaptHardhatJUnit, adaptJUnitXml, parseJUnitXml } from "./adapters/junit-xml.js";
export type { JUnitAdapterOptions } from "./adapters/junit-xml.js";
export { adaptHardhatResultJson } from "./adapters/hardhat-json.js";
export type { HardhatJsonAdapterOptions } from "./adapters/hardhat-json.js";
export { adaptK6Summary } from "./adapters/k6.js";
export type { K6AdapterOptions } from "./adapters/k6.js";

// Driver — CLI + orchestrator
export { main, defaultRepoRoot } from "./cli.js";
export type { CliInputs, CliOutcome } from "./cli.js";
export { ArgvError, defaultRunId, parseArgs, resolveConfig, usage } from "./driver/config.js";
export type { DriverConfig, ParsedArgs, ResolveOptions } from "./driver/config.js";
export { getPreset, listPresets } from "./driver/presets.js";
export type { HardhatRun, K6Run, Preset, SuiteRun, SuiteRunKind } from "./driver/presets.js";
export { exitCodeFor, runDriver } from "./driver/runner.js";
export type { DriverResult, RunnerOverrides } from "./driver/runner.js";
export { runHardhat } from "./driver/runners/hardhat.js";
export type { HardhatRunnerOptions, HardhatRunnerResult } from "./driver/runners/hardhat.js";
export { runK6 } from "./driver/runners/k6.js";
export type { K6RunnerOptions, K6RunnerResult } from "./driver/runners/k6.js";
