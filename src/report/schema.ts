/**
 * Unified regression-report schema.
 *
 * Every suite the driver runs (rskj-hardhat-tests, rskj-k6-tests, RIT, …)
 * collapses into one of these {@link UnifiedReport} documents. JUnit XML is
 * a lossier projection of the same data — the canonical, round-trippable
 * shape is this JSON.
 *
 * Design goals:
 *   1. Lossless for the things CI cares about: pass / fail / skip counts,
 *      per-test duration and error, suite-level and overall verdict.
 *   2. Expressive enough to carry suite-specific extras (e.g. k6 thresholds,
 *      latency percentiles) without forcing every consumer to understand
 *      them — extras live under a tagged `extras` field.
 *   3. Renderable to JUnit XML for CI gating tools and to Markdown for
 *      human reviewers.
 *
 * The schema is intentionally flat: a report has metadata and an array of
 * suites; each suite has metadata, a verdict, and an array of test cases.
 * Two levels of verdict are tracked explicitly:
 *   - per-suite: `SuiteVerdict` (counts + duration + pass flag)
 *   - overall:   `OverallVerdict` (roll-up across suites + boolean pass)
 *
 * Schema version is bumped on breaking change.
 */

export const UNIFIED_REPORT_SCHEMA_VERSION = "1.0.0";

/** Per-test outcome. `error` is a process-level failure (the suite couldn't run). */
export type TestStatus = "passed" | "failed" | "skipped" | "error";

/** Source of the unified report — what kind of suite produced the input. */
export type SuiteKind = "hardhat" | "k6" | "mocha" | "rit" | "other";

/**
 * One individual test case as it appears in the unified report.
 *
 * For k6, each scenario / threshold-group is folded into one or more
 * `UnifiedTestCase`s; see {@link adaptK6Summary}.
 */
export interface UnifiedTestCase {
  /** Short, human-readable name (e.g. mocha `it()` title). */
  name: string;
  /** Optional classname / category (e.g. mocha `describe()` chain). */
  classname?: string;
  /** Per-test outcome. */
  status: TestStatus;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Failure details when `status` is `failed` or `error`. Omitted for
   * passed / skipped tests.
   */
  failure?: UnifiedFailure;
  /** Source file the test lives in, when known. */
  file?: string;
  /**
   * Free-form per-test metadata (gas used, p95 latency, threshold name…)
   * carried through but not interpreted by the unified report itself.
   */
  extras?: Record<string, unknown>;
}

/** Failure / error payload attached to a non-passing test case. */
export interface UnifiedFailure {
  /** One-line message. */
  message: string;
  /** Error type (e.g. `AssertionError`, `ThresholdViolation`). */
  type?: string;
  /** Multi-line stack or detail, if available. */
  stack?: string;
}

/** Per-suite roll-up: counts and pass/fail verdict. */
export interface SuiteVerdict {
  /** Total test count (= passed + failed + skipped + errored). */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /**
   * Process-level errors — the suite (or a fraction of it) couldn't run.
   * Always failure-grade; counted separately from in-test failures so
   * tooling can distinguish "suite ran and a test asserted wrong" from
   * "suite never started".
   */
  errored: number;
  /** Total suite wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Overall suite verdict: true iff every test passed (or was skipped) and
   * no process-level errors occurred. Skipped tests do NOT fail a suite.
   */
  passed_overall: boolean;
}

/** A single suite — one invocation of one test framework against one target. */
export interface UnifiedSuite {
  /** Short suite identifier — e.g. `hardhat-smoke`, `k6-storage-stress`. */
  name: string;
  /** Origin of the suite output (determines which adapter produced it). */
  kind: SuiteKind;
  /**
   * Optional free-form description, surfaced in human-readable renders
   * (e.g. "EIP / RSKIP compatibility smoke").
   */
  description?: string;
  /**
   * ISO 8601 timestamp the suite started, if known. Missing values are
   * tolerated; consumers fall back to the report-level timestamp.
   */
  startedAt?: string;
  /** Roll-up verdict for this suite. */
  verdict: SuiteVerdict;
  /** Individual test cases in suite-declared order. */
  tests: UnifiedTestCase[];
  /**
   * Suite-specific metadata that doesn't fit the unified shape but is
   * worth preserving (e.g. k6 thresholds, hardhat network, RPC URL).
   */
  extras?: Record<string, unknown>;
}

/** Roll-up across every suite in the report. */
export interface OverallVerdict {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  /** Sum of every suite's `durationMs`. */
  durationMs: number;
  /** True iff every suite's `passed_overall` is true. */
  passed_overall: boolean;
}

/** Report-level metadata — captures the run context. */
export interface ReportMetadata {
  /**
   * Logical name of this regression run — usually the driver's run id or
   * the CI build / commit SHA.
   */
  runId?: string;
  /** ISO 8601 start timestamp. */
  startedAt: string;
  /** ISO 8601 end timestamp. */
  endedAt?: string;
  /** rskj version under test (e.g. "vetiver-9.0.1"). */
  rskjVersion?: string;
  /** Target network ("regtest", "betanet", …). */
  network?: string;
  /** RPC endpoint hit, if any. */
  rpcUrl?: string;
  /** Free-form labels for filtering reports later. */
  labels?: Record<string, string>;
}

/** The top-level unified report. */
export interface UnifiedReport {
  /** Schema version the document conforms to. */
  schemaVersion: string;
  /** Run-level context. */
  metadata: ReportMetadata;
  /** Roll-up verdict across all suites. */
  overall: OverallVerdict;
  /** Per-suite results in driver-declared order. */
  suites: UnifiedSuite[];
}

/* -------------------------------------------------------------------------- *
 * Helpers — kept here (not in a separate module) so the schema and the
 * canonical compute-the-verdict implementation live side by side. Adapters
 * use these instead of recomputing counts inline.
 * -------------------------------------------------------------------------- */

/**
 * Compute a {@link SuiteVerdict} from a list of test cases plus a duration.
 *
 * @param tests - All test cases in the suite.
 * @param durationMs - Wall-clock duration of the suite.
 * @returns A roll-up verdict; `passed_overall` is true iff there are no
 *   `failed` or `error` tests.
 */
export function computeSuiteVerdict(tests: UnifiedTestCase[], durationMs: number): SuiteVerdict {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  for (const t of tests) {
    switch (t.status) {
      case "passed":
        passed++;
        break;
      case "failed":
        failed++;
        break;
      case "skipped":
        skipped++;
        break;
      case "error":
        errored++;
        break;
    }
  }
  return {
    total: tests.length,
    passed,
    failed,
    skipped,
    errored,
    durationMs,
    passed_overall: failed === 0 && errored === 0,
  };
}

/**
 * Compute the {@link OverallVerdict} from a list of suites.
 *
 * @param suites - All suites included in the report.
 * @returns Roll-up where each metric is the sum of the per-suite metric,
 *   except `passed_overall` which is the logical AND.
 */
export function computeOverallVerdict(suites: UnifiedSuite[]): OverallVerdict {
  const acc: OverallVerdict = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    durationMs: 0,
    passed_overall: true,
  };
  for (const s of suites) {
    acc.total += s.verdict.total;
    acc.passed += s.verdict.passed;
    acc.failed += s.verdict.failed;
    acc.skipped += s.verdict.skipped;
    acc.errored += s.verdict.errored;
    acc.durationMs += s.verdict.durationMs;
    acc.passed_overall = acc.passed_overall && s.verdict.passed_overall;
  }
  return acc;
}

/**
 * Build a {@link UnifiedReport} from suites + metadata, recomputing the
 * overall verdict from the suite verdicts. Adapters and the driver should
 * use this rather than constructing the report literal.
 */
export function buildUnifiedReport(
  metadata: ReportMetadata,
  suites: UnifiedSuite[],
): UnifiedReport {
  return {
    schemaVersion: UNIFIED_REPORT_SCHEMA_VERSION,
    metadata,
    overall: computeOverallVerdict(suites),
    suites,
  };
}
