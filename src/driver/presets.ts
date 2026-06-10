/**
 * Driver presets — declarative bundles of suites the driver runs together.
 *
 * Each preset names a set of hardhat, k6 and/or RIT scenarios. The driver
 * resolves a preset name into a {@link DriverPlan} that the orchestrating
 * code (see `runner.ts`) hands to the suite runners.
 *
 * The catalogue stays intentionally small: a `smoke` preset (commit-time
 * gating: hardhat + k6) and a `full` preset that adds the powpeg 2WP
 * integration smoke via RIT. Heavier release-time bundles are out of scope.
 *
 * Decisions locked in here:
 *  - **hardhat**: the smoke subset (`[smoke]` describe-tag, already wired
 *    in rskj-hardhat-tests). The driver shells out to hardhat — it does
 *    not vendor the suite.
 *  - **k6**: cherry-picked per-method tests from `rskj-k6-tests/tests/`,
 *    not the heavy `scenarios/*-stress-test.js` files. The latter need
 *    a perf-tuned node and are release-time signals, not gating ones.
 *    `eth-blockNumber.js` is the canonical low-cost smoke — it asserts
 *    shape and latency, not throughput, and runs at 1 VU.
 */

/** Logical kind of suite invocation. */
export type SuiteRunKind = "hardhat" | "k6" | "rit";

/** One hardhat invocation. The driver knows how to map this to a hardhat CLI call. */
export interface HardhatRun {
  kind: "hardhat";
  /**
   * Logical name surfaced in the unified report (e.g. `hardhat-smoke`).
   * Distinct from the hardhat package script — this is the suite identity
   * the report exposes.
   */
  name: string;
  /**
   * Human-readable description carried into {@link UnifiedSuite.description}.
   */
  description?: string;
  /**
   * Whether to run only `[smoke]`-tagged tests (`SMOKE=true ... --grep "\[smoke\]"`)
   * or the full test set. POC currently only uses `true`.
   */
  smoke: boolean;
}

/** One k6 invocation. The driver shells out to `k6 run <script>` per entry. */
export interface K6Run {
  kind: "k6";
  /** Logical name surfaced in the unified report (e.g. `k6:eth_blockNumber`). */
  name: string;
  /** Human-readable description. */
  description?: string;
  /**
   * Path to the k6 test script *relative* to the resolved k6-tests root.
   * E.g. `tests/eth-blockNumber.js`. The driver joins this with the
   * configured k6-tests path.
   */
  scriptRelPath: string;
  /**
   * Output JSON file the test's `handleSummary` writes to, *relative to
   * the k6-tests root* (matches the project-native custom-reporter
   * convention: `results/<method>.json`). The driver reads this file
   * after the run and feeds it to `adaptK6Summary`.
   */
  summaryRelPath: string;
  /** Optional explicit VU override (`--vus`). */
  vus?: number;
  /** Optional explicit duration override (`--duration`). */
  duration?: string;
}

/**
 * One RIT (rootstock-integration-tests) invocation.
 *
 * RIT self-orchestrates: its Mocha global before-hook boots its own
 * bitcoind + three powpeg federate JVMs, so — unlike hardhat / k6 — there is
 * NO external RPC target. The driver shells out to `mocha` with RIT on its
 * default spec (the repo-root `test.js`) and selects a subset purely via the
 * `INCLUDE_CASES` env var. See `src/driver/runners/rit.ts` for the full
 * env contract and the subset-selection gotcha.
 */
export interface RitRun {
  kind: "rit";
  /** Logical name surfaced in the unified report (e.g. `rit-2wp-smoke`). */
  name: string;
  /** Human-readable description. */
  description?: string;
  /**
   * Filename-prefix subset, mapped to `INCLUDE_CASES` (comma-joined). Each
   * entry matches RIT spec files by `path.basename(...).startsWith(entry)`
   * (see `needsToBeTested` in RIT's `test.js`). Omit / leave empty to run
   * the full suite. NOTE: subsets that rely on shared blockchain state must
   * include the bootstrap sync test (`00_00_01-sync`) first.
   */
  includeCases?: string[];
  /**
   * Path the JUnit XML report is written to (surfaced as `MOCHA_FILE`),
   * *relative to the driver output directory* unless absolute. The runner
   * reads this file after the run and feeds it to `adaptJUnitXml`.
   */
  reportRelPath: string;
}

export type SuiteRun = HardhatRun | K6Run | RitRun;

/** A named bundle of suite invocations. */
export interface Preset {
  name: string;
  description: string;
  runs: SuiteRun[];
}

/* -------------------------------------------------------------------------- *
 * Catalogue
 * -------------------------------------------------------------------------- */

const SMOKE: Preset = {
  name: "smoke",
  description:
    "Commit-time gating: hardhat compatibility smoke + a low-VU k6 RPC smoke. " +
    "Asserts shape and basic latency; does NOT exercise gas-limit or PTE stress.",
  runs: [
    {
      kind: "hardhat",
      name: "hardhat-smoke",
      description: "rskj-hardhat-tests [smoke]-tagged subset (consensus / RPC compatibility)",
      smoke: true,
    },
    {
      kind: "k6",
      name: "k6:eth_blockNumber",
      description: "rskj-k6-tests per-method smoke: eth_blockNumber response time + progression",
      scriptRelPath: "tests/eth-blockNumber.js",
      summaryRelPath: "results/eth_blockNumber.json",
    },
  ],
};

/**
 * Release-ish bundle that adds the powpeg 2WP integration smoke on top of
 * the commit-time `smoke` runs.
 *
 * The RIT entry runs the bootstrap sync test plus the canonical
 * bridge-method calls test. `00_00_01-sync` MUST come first — it boots the
 * full 3-fed federation and mines the initial chain that subsequent tests
 * assert against (RIT tests share blockchain state and run sequentially).
 *
 * RIT self-orchestrates, so this preset works the same whether the rest of
 * the driver runs with `--auto-node` or against a pre-running node: the RIT
 * runner ignores both and boots its own cluster.
 */
const FULL: Preset = {
  name: "full",
  description:
    "Commit-time smoke (hardhat + k6) PLUS a powpeg 2WP integration smoke via RIT. " +
    "RIT self-orchestrates its own bitcoind + 3-federate cluster.",
  runs: [
    ...SMOKE.runs,
    {
      kind: "rit",
      name: "rit-2wp-smoke",
      description:
        "rootstock-integration-tests: federation sync bootstrap + bridge-method calls " +
        "(boots bitcoind + 3 powpeg federate JVMs in-process)",
      includeCases: ["00_00_01-sync", "01_01_02-calls-to-bridge-methods"],
      reportRelPath: "rit/rit-2wp-smoke.xml",
    },
  ],
};

const PRESETS: Record<string, Preset> = {
  smoke: SMOKE,
  full: FULL,
};

/**
 * Resolve a preset by name.
 *
 * @throws Error if the preset isn't registered. Errors list available names.
 */
export function getPreset(name: string): Preset {
  const preset = PRESETS[name];
  if (!preset) {
    const available = Object.keys(PRESETS).join(", ");
    throw new Error(`Unknown preset "${name}". Available presets: ${available}`);
  }
  return preset;
}

/** Names of all registered presets, in declaration order. */
export function listPresets(): string[] {
  return Object.keys(PRESETS);
}
