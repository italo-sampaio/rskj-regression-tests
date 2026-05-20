/**
 * Public surface of the rskj-regression driver / library.
 *
 * The driver and orchestrator implementations land in subsequent tasks of
 * the regression-testing initiative; this entry point currently re-exports
 * the unified-report schema and the suite-output adapters so consumers
 * (and the eventual driver) can compose them without reaching into internal
 * paths.
 *
 * See `docs/unified-report-format.md` for the full schema reference.
 */

export const VERSION = "0.0.0";

export function describe(): string {
  return `rskj-regression v${VERSION} (report format + adapters)`;
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
export { adaptK6Summary } from "./adapters/k6.js";
export type { K6AdapterOptions } from "./adapters/k6.js";
