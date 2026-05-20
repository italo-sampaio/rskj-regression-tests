/**
 * k6 → {@link UnifiedSuite} adapter.
 *
 * k6 doesn't have a Mocha-style notion of "tests"; instead it has
 * **thresholds** (declarative pass/fail criteria on metrics like
 * `http_req_duration p(95) < 500`) and **checks** (assertions evaluated
 * inside the VU loop). The adapter folds these into the unified shape:
 *
 *   - Each `threshold` entry in the k6 summary becomes one
 *     {@link UnifiedTestCase}. A failing threshold becomes a `failed`
 *     test with a synthesised failure message.
 *   - When the input has zero thresholds (most rskj-k6-tests files don't
 *     declare any), the adapter emits a single "k6 run" test case whose
 *     status is derived from the summary's `passed` flag (when present)
 *     or from the check success rate.
 *   - Suite-level metrics (HTTP latency percentiles, request totals,
 *     check counts, custom blockchain metrics) are preserved verbatim in
 *     {@link UnifiedSuite.extras} so downstream tooling can compare runs
 *     without re-parsing native k6 JSON.
 *
 * Two flavours of k6 input are supported:
 *
 *   1. The **project-native shape** produced by
 *      `rskj-k6-tests/utils/custom-reporter.js` — a single JSON document
 *      with `meta`, `metrics`, `thresholds`, and `passed`. This is what
 *      `results/<method>.json` and `reports/<version>/...` already
 *      contain in the wild.
 *   2. The **k6 default summary** produced by `k6 run --summary-export`
 *      (no thresholds parser support yet, but the structure is
 *      compatible enough that we degrade gracefully — see
 *      {@link adaptK6Summary} comments).
 *
 * NDJSON streaming output (`k6 run --out json=...`) is NOT supported
 * here — that's a stream of metric points, not a summary. If the driver
 * needs to ingest streamed output it should first run the points through
 * a k6 reducer; the unified report consumes the summary.
 */

import {
  computeSuiteVerdict,
  type UnifiedSuite,
  type UnifiedTestCase,
  type UnifiedFailure,
} from "../report/schema.js";

/* -------------------------------------------------------------------------- *
 * Input shape — matches rskj-k6-tests/utils/custom-reporter.js
 * -------------------------------------------------------------------------- */

/** A single threshold result as the project-native reporter emits it. */
interface K6Threshold {
  /** `true` if the threshold held; `false` if violated. */
  passed: boolean;
  /**
   * The threshold expressions evaluated. Some k6 versions emit this as
   * `["p(95)<500"]`, others as the parsed object form
   * `[{ source: "p(95)<500", ok: true }]`. We accept both.
   */
  thresholds?: string[] | Array<{ source?: string; ok?: boolean; threshold?: string }>;
}

interface K6Meta {
  module?: string;
  method?: string;
  test_name?: string;
  timestamp?: string;
  duration_ms?: number;
  vus_max?: number;
  iterations?: number;
  k6_version?: string;
}

interface K6Summary {
  meta: K6Meta;
  thresholds?: Record<string, K6Threshold>;
  metrics?: Record<string, unknown>;
  passed?: boolean;
}

/**
 * Best-effort detection of the k6 default `--summary-export` shape, which
 * has a different layout. We don't normalise that here — the project's
 * custom reporter is the canonical input — but we surface a helpful
 * error so callers know to wrap their output first.
 */
function looksLikeRawK6Summary(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!("metrics" in obj)) return false;
  if ("meta" in obj) return false;
  const metrics = obj.metrics as Record<string, unknown> | undefined;
  // k6's --summary-export emits a flat `metrics` map keyed by metric name,
  // never includes the project-native `meta.test_name` marker.
  return !metrics || !("test_name" in metrics);
}

/* -------------------------------------------------------------------------- *
 * Adapter options
 * -------------------------------------------------------------------------- */

export interface K6AdapterOptions {
  /**
   * Suite name. Default: `k6:<meta.method ?? meta.test_name ?? "unknown">`.
   */
  suiteName?: string;
  /** Optional human description, surfaced in the unified report. */
  description?: string;
  /** Extra metadata merged into {@link UnifiedSuite.extras}. */
  extras?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- *
 * Adapter
 * -------------------------------------------------------------------------- */

function thresholdExpressions(t: K6Threshold): string[] {
  if (!t.thresholds) return [];
  return t.thresholds.map((entry) => {
    if (typeof entry === "string") return entry;
    return entry.source ?? entry.threshold ?? "(threshold)";
  });
}

function buildThresholdTest(metricName: string, threshold: K6Threshold): UnifiedTestCase {
  const status = threshold.passed ? "passed" : "failed";
  const expressions = thresholdExpressions(threshold);
  const test: UnifiedTestCase = {
    name: `${metricName}: ${expressions.join(", ") || "threshold"}`,
    classname: metricName,
    status,
    durationMs: 0,
  };
  if (status === "failed") {
    const failure: UnifiedFailure = {
      message: `k6 threshold violated on ${metricName}: ${expressions.join(", ") || "(unspecified)"}`,
      type: "ThresholdViolation",
    };
    test.failure = failure;
  }
  return test;
}

function buildAggregateTest(summary: K6Summary): UnifiedTestCase {
  // No thresholds declared. Fall back to the summary's own pass flag
  // (project-native shape) or to the check success rate as a last resort.
  const checks = (summary.metrics as Record<string, unknown> | undefined)?.checks as
    | { failed?: number; passed?: number }
    | undefined;
  let status: UnifiedTestCase["status"] = "passed";
  let failureMessage: string | null = null;
  if (typeof summary.passed === "boolean") {
    if (!summary.passed) {
      status = "failed";
      failureMessage = "k6 run reported passed=false";
    }
  } else if (checks && typeof checks.failed === "number" && checks.failed > 0) {
    status = "failed";
    failureMessage = `${checks.failed} k6 checks failed`;
  }
  const test: UnifiedTestCase = {
    name: `${summary.meta.method ?? summary.meta.test_name ?? "k6 run"} (no thresholds)`,
    status,
    durationMs: Math.round(summary.meta.duration_ms ?? 0),
  };
  if (failureMessage) {
    test.failure = {
      message: failureMessage,
      type: "K6RunFailed",
    };
  }
  return test;
}

/**
 * Adapt a k6 custom-reporter JSON document into a {@link UnifiedSuite}.
 *
 * @param input - Either the parsed JSON object or the raw string.
 * @param options - Naming and metadata overrides.
 */
export function adaptK6Summary(
  input: string | object,
  options: K6AdapterOptions = {},
): UnifiedSuite {
  const summary: K6Summary =
    typeof input === "string" ? (JSON.parse(input) as K6Summary) : (input as K6Summary);

  if (!summary || typeof summary !== "object" || !summary.meta) {
    if (looksLikeRawK6Summary(summary)) {
      throw new Error(
        "k6 adapter: input looks like a raw k6 --summary-export, not the project-native reporter output. " +
          "Wrap the run with utils/custom-reporter.js or convert externally first.",
      );
    }
    throw new Error(
      "k6 adapter: expected an object with a 'meta' field (project-native reporter shape).",
    );
  }

  const thresholds = summary.thresholds ?? {};
  const thresholdEntries = Object.entries(thresholds);

  const tests: UnifiedTestCase[] =
    thresholdEntries.length > 0
      ? thresholdEntries.map(([name, t]) => buildThresholdTest(name, t))
      : [buildAggregateTest(summary)];

  const durationMs = Math.round(summary.meta.duration_ms ?? 0);

  const fallbackName = summary.meta.method ?? summary.meta.test_name ?? "unknown";
  const suite: UnifiedSuite = {
    name: options.suiteName ?? `k6:${fallbackName}`,
    kind: "k6",
    verdict: computeSuiteVerdict(tests, durationMs),
    tests,
    extras: {
      iterations: summary.meta.iterations ?? 0,
      vus_max: summary.meta.vus_max ?? 0,
      k6_version: summary.meta.k6_version ?? "unknown",
      metrics: summary.metrics ?? {},
      ...(options.extras ?? {}),
    },
  };
  if (options.description) suite.description = options.description;
  if (summary.meta.timestamp) suite.startedAt = summary.meta.timestamp;
  return suite;
}
