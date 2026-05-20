/**
 * Hardhat `result.json` → {@link UnifiedSuite} adapter.
 *
 * `rskj-hardhat-tests` ships a global mocha `setup.ts` that writes a
 * single rolled-up JSON document to `results/result.json` at the end of
 * every test session. The document is a stable shape (committed in the
 * sibling repo for years now) and *much* easier to work with than
 * running mocha's `xunit` reporter alongside the existing reporters —
 * hardhat 3 only allows one mocha reporter via its config, and the
 * sibling repo's reporter slot is already taken by a custom JSON
 * collector. Reading `result.json` directly avoids a sibling-repo
 * config change for the POC.
 *
 * Input shape (subset we rely on):
 *
 *     {
 *       "stats":   { suites, tests, passes, pending, failures,
 *                    start: ISO, end: ISO, duration: ms },
 *       "tests":   [ { title, fullTitle, file, duration, state, err } ],
 *       "networkInfo": { network, chainId, rpcUrl, ... }   // optional
 *     }
 *
 * `state` values are mocha's: `passed`, `failed`, `pending`. The adapter
 * maps:
 *   - `passed`           → "passed"
 *   - `failed`           → "failed" (with `err.message` / `err.stack`)
 *   - `pending`          → "skipped"
 *   - anything else      → "error"
 *
 * Tests of kind `error` should be rare in practice — mocha exposes
 * uncaught hook errors via the `failures` count in stats, not via test
 * state — but we keep the path so an unusual reporter version doesn't
 * silently drop test cases.
 */

import {
  computeSuiteVerdict,
  type SuiteKind,
  type UnifiedSuite,
  type UnifiedTestCase,
  type TestStatus,
} from "../report/schema.js";

interface HardhatResultJsonTest {
  title: string;
  fullTitle?: string;
  file?: string;
  duration?: number;
  state?: "passed" | "failed" | "pending" | string;
  currentRetry?: number;
  err?: {
    message?: string;
    name?: string;
    stack?: string;
  };
}

interface HardhatResultJsonStats {
  suites?: number;
  tests?: number;
  passes?: number;
  pending?: number;
  failures?: number;
  start?: string;
  end?: string;
  duration?: number;
}

interface HardhatResultJson {
  stats?: HardhatResultJsonStats;
  tests?: HardhatResultJsonTest[];
  networkInfo?: Record<string, unknown>;
}

/** Tunables exposed to the driver. */
export interface HardhatJsonAdapterOptions {
  /** Suite name in the unified report. Default `"hardhat-smoke"`. */
  suiteName?: string;
  /** Suite kind tag. Default `"hardhat"`. */
  kind?: SuiteKind;
  /** Optional human description carried through. */
  description?: string;
  /** Extra metadata merged into `UnifiedSuite.extras`. */
  extras?: Record<string, unknown>;
}

/**
 * Convert a parsed (or string) hardhat-tests `result.json` document into
 * a {@link UnifiedSuite}.
 *
 * @throws Error when the document is missing the `tests` array entirely.
 *   Empty arrays are accepted and yield a zero-counts suite.
 */
export function adaptHardhatResultJson(
  input: string | object,
  options: HardhatJsonAdapterOptions = {},
): UnifiedSuite {
  const parsed: HardhatResultJson =
    typeof input === "string"
      ? (JSON.parse(input) as HardhatResultJson)
      : (input as HardhatResultJson);

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tests)) {
    throw new Error("hardhat result.json adapter: expected an object with a 'tests' array.");
  }

  const tests: UnifiedTestCase[] = parsed.tests.map((t) => {
    const status = mapStatus(t.state);
    const test: UnifiedTestCase = {
      name: t.title,
      status,
      durationMs: t.duration ?? 0,
    };
    if (t.fullTitle && t.fullTitle !== t.title)
      test.classname = trimSuitePrefix(t.fullTitle, t.title);
    if (t.file) test.file = t.file;
    if ((status === "failed" || status === "error") && t.err) {
      const failureMessage = t.err.message ?? "(no message)";
      const failure: { message: string; type?: string; stack?: string } = {
        message: failureMessage,
      };
      if (t.err.name) failure.type = t.err.name;
      if (t.err.stack) failure.stack = t.err.stack;
      test.failure = failure;
    }
    return test;
  });

  const durationMs = parsed.stats?.duration ?? sumDurations(tests);
  const suite: UnifiedSuite = {
    name: options.suiteName ?? "hardhat-smoke",
    kind: options.kind ?? "hardhat",
    verdict: computeSuiteVerdict(tests, durationMs),
    tests,
  };
  if (options.description) suite.description = options.description;
  if (parsed.stats?.start) suite.startedAt = parsed.stats.start;
  // Preserve the captured network metadata + any caller-side extras. The
  // unified-report schema lets us carry arbitrary data here without
  // forcing every consumer to understand it.
  const extras: Record<string, unknown> = {
    ...(parsed.networkInfo ? { networkInfo: parsed.networkInfo } : {}),
    ...(options.extras ?? {}),
  };
  if (Object.keys(extras).length > 0) suite.extras = extras;
  return suite;
}

function mapStatus(state: string | undefined): TestStatus {
  switch (state) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "pending":
      return "skipped";
    case undefined:
    case "":
      return "error";
    default:
      return "error";
  }
}

function sumDurations(tests: UnifiedTestCase[]): number {
  let total = 0;
  for (const t of tests) total += t.durationMs;
  return total;
}

/**
 * Mocha's `fullTitle` is the concatenation of every enclosing describe
 * block plus the test's own `it()` title. The trailing portion is
 * `t.title` verbatim, so the classname (the `describe()` chain) is
 * what's left after stripping it. We keep this conservative — if the
 * trim doesn't yield a clean classname, fall back to `fullTitle`.
 */
function trimSuitePrefix(fullTitle: string, title: string): string {
  const idx = fullTitle.lastIndexOf(title);
  if (idx <= 0) return fullTitle;
  return fullTitle.slice(0, idx).trim();
}
