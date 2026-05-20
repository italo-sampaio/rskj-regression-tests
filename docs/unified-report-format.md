# Unified regression-report format

This document defines the report format that every suite the
`rskj-regression` driver runs collapses into. It is the contract between
the driver and any downstream consumer — CI gates, dashboards, PR
comments, release sign-off pages.

Two output formats are emitted from one canonical in-memory shape:

| Format    | Audience             | Purpose                                                    |
| --------- | -------------------- | ---------------------------------------------------------- |
| JSON      | Tooling, dashboards  | Round-trippable, full fidelity. Source of truth.           |
| JUnit XML | CI gating            | Lossier projection — pass/fail counts + per-test outcomes. |
| Markdown  | Humans / PR comments | Render of the same data with stack-trace details.          |

The canonical TypeScript types live in
[`src/report/schema.ts`](../src/report/schema.ts). This document mirrors
them in prose so external consumers don't have to read the source.

---

## Schema versioning

The current version is **`1.0.0`** (`UNIFIED_REPORT_SCHEMA_VERSION`).
Backwards-incompatible changes bump the major; additive fields bump the
minor; bugfixes / clarifications bump the patch.

Every emitted JSON report carries the version in its top-level
`schemaVersion` field. Consumers should pin or feature-detect.

---

## Top-level: `UnifiedReport`

```jsonc
{
  "schemaVersion": "1.0.0",
  "metadata": {
    /* ReportMetadata, see below */
  },
  "overall": {
    /* OverallVerdict, see below */
  },
  "suites": [
    /* UnifiedSuite[], see below */
  ],
}
```

| Field           | Type             | Required | Notes                                |
| --------------- | ---------------- | -------- | ------------------------------------ |
| `schemaVersion` | `string`         | yes      | SemVer.                              |
| `metadata`      | `ReportMetadata` | yes      | Run-level context.                   |
| `overall`       | `OverallVerdict` | yes      | Recomputed by `buildUnifiedReport`.  |
| `suites`        | `UnifiedSuite[]` | yes      | Driver-declared order; may be empty. |

---

## `ReportMetadata`

```jsonc
{
  "runId": "ci-build-1234", // optional
  "startedAt": "2026-05-20T12:00:00Z", // ISO 8601, required
  "endedAt": "2026-05-20T12:18:30Z", // optional
  "rskjVersion": "vetiver-9.0.1-gaslimit-RC1", // optional
  "network": "regtest", // optional
  "rpcUrl": "http://localhost:4444", // optional
  "labels": { "branch": "rc/9.0.2" }, // optional
}
```

Only `startedAt` is required. Everything else is optional; the driver
fills in what it knows.

---

## `OverallVerdict`

Roll-up across every suite.

```jsonc
{
  "total": 6,
  "passed": 4,
  "failed": 1,
  "skipped": 1,
  "errored": 0,
  "durationMs": 123456,
  "passed_overall": false,
}
```

- `total = passed + failed + skipped + errored`
- `passed_overall = AND of every suite's passed_overall`
- `durationMs` is the sum of every suite's `durationMs`.

CI gates should consume `passed_overall` (boolean) and surface the four
counts. Anything else is informational.

---

## `UnifiedSuite`

One suite = one invocation of one test framework against one target.

```jsonc
{
  "name": "hardhat-smoke",
  "kind": "hardhat",
  "description": "EIP / RSKIP compatibility smoke", // optional
  "startedAt": "2026-05-20T12:00:00Z", // optional
  "verdict": {
    /* SuiteVerdict */
  },
  "tests": [
    /* UnifiedTestCase[] */
  ],
  "extras": {
    /* free-form suite-specific data */
  }, // optional
}
```

### `kind`

One of `"hardhat" | "k6" | "mocha" | "rit" | "other"`. Determines which
adapter produced the suite; consumers can use it to render suite-specific
extras.

### `extras`

Free-form. Examples in this codebase:

- **k6:** `{ iterations, vus_max, k6_version, metrics: { http, checks, custom } }`
  — preserves the full custom-reporter output for later comparison.
- **hardhat:** typically empty in v1; the driver may attach
  `{ rpcUrl, network, gasReportingEnabled }` once those are surfaced.

### `SuiteVerdict`

```jsonc
{
  "total": 3,
  "passed": 1,
  "failed": 1,
  "skipped": 1,
  "errored": 0,
  "durationMs": 350,
  "passed_overall": false,
}
```

- `passed_overall = (failed === 0 && errored === 0)`. Skipped tests do
  **not** fail a suite.
- `errored` is a process-level error (the suite couldn't run a given
  test). In-test assertion failures go in `failed`.

---

## `UnifiedTestCase`

```jsonc
{
  "name": "should deploy CREATE2 contract",
  "classname": "EIP-1014 CREATE2 Opcode", // optional
  "status": "passed", // "passed" | "failed" | "skipped" | "error"
  "durationMs": 50,
  "file": "test/eips/eip1014/Create2Test.ts", // optional
  "failure": {
    // present iff status in {failed, error}
    "message": "expected '0x' to equal '0x01'",
    "type": "AssertionError", // optional
    "stack": "AssertionError: ...\n  at ...", // optional
  },
  "extras": { "gasUsed": 21000 }, // optional
}
```

### `status` semantics

| Status    | When                                                                              | Counts as |
| --------- | --------------------------------------------------------------------------------- | --------- |
| `passed`  | Test ran and all assertions held.                                                 | pass      |
| `failed`  | Test ran and an assertion (or k6 threshold) failed.                               | failure   |
| `skipped` | Test was deliberately not run (e.g. mocha `.skip`).                               | neither   |
| `error`   | Test could not run (process crash, setup throw, timeout that aborted the runner). | failure   |

### `failure`

Required iff `status` is `failed` or `error`. `message` is a one-line
summary, `type` is the error class (used by JUnit `type` attribute), and
`stack` is the full multi-line detail.

---

## JUnit XML projection

The XML projection follows the Surefire / Maven flavour of JUnit:

```xml
<testsuites tests="6" failures="1" errors="0" skipped="1" time="123.456" name="ci-build-1234">
  <testsuite name="hardhat-smoke" tests="6" failures="1" errors="0" skipped="1" time="123.456" timestamp="...">
    <testcase name="should deploy CREATE2" time="0.050" classname="EIP-1014" file="..."/>
    <testcase name="rejects malformed peg-in" time="12.345" classname="Bridge">
      <failure message="expected '0x' to equal '0x01'" type="AssertionError">AssertionError: ...</failure>
    </testcase>
    <testcase name="executes PUSH0" time="0.000" classname="RSKIP-398">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>
```

Mappings:

| Unified             | JUnit XML                                       |
| ------------------- | ----------------------------------------------- |
| `status: "passed"`  | `<testcase ...>` with no children               |
| `status: "failed"`  | `<failure message=... type=...>stack</failure>` |
| `status: "error"`   | `<error message=... type=...>stack</error>`     |
| `status: "skipped"` | `<skipped/>`                                    |
| `durationMs`        | `time` in seconds with 3 decimals               |
| `extras`            | **dropped** (use JSON for round-trip fidelity)  |

---

## Markdown projection

The Markdown projection produces a single self-contained document with:

1. A `# Regression report — ✅ PASSED` / `❌ FAILED` header.
2. A `## Run` block (rskj version, network, RPC URL, timestamps).
3. A `## Overall verdict` one-liner with the headline counts.
4. A `## Suites` table — one row per suite, sortable columns.
5. A `## Failures` section — one block per failing test with file,
   classname, error message, and a `<details>` block containing the
   (truncated) stack trace.

The output renders correctly in:

- GitHub PR comments (HTML `<details>` is supported).
- GitHub Actions step summaries (`$GITHUB_STEP_SUMMARY`).
- Standard CLI Markdown viewers (`glow`, `bat`, plain `less`).

---

## Adapters

Each test suite has an input format that doesn't match the unified shape;
adapters translate. Implemented in v1:

| Suite                | Input format                               | Adapter                              |
| -------------------- | ------------------------------------------ | ------------------------------------ |
| `rskj-hardhat-tests` | Mocha `xunit` / `mocha-junit-reporter` XML | `adaptHardhatJUnit`, `adaptJUnitXml` |
| `rskj-k6-tests`      | Project-native `custom-reporter.js` JSON   | `adaptK6Summary`                     |

Deferred to later tasks:

| Suite | Input format     | Adapter status                      |
| ----- | ---------------- | ----------------------------------- |
| RIT   | Mocha JSON / XML | Phase 2 follow-up (Notion task #9). |

### k6-specific notes

k6 doesn't have Mocha-style tests. The adapter folds k6's
**thresholds** into `UnifiedTestCase`s:

- Each `thresholds.<metric>` entry becomes one test, named
  `"<metric>: <expression>"`. A failing threshold becomes
  `status: "failed"` with `type: "ThresholdViolation"`.
- When no thresholds are declared (most rskj-k6-tests files), the
  adapter emits one synthetic test named `"<method> (no thresholds)"`
  whose pass / fail comes from the summary's own `passed` flag, or
  from the check failure count as a last resort.

Full k6 metrics — HTTP percentiles, custom blockchain metrics, iteration
counts — are preserved verbatim in `suite.extras` so downstream tooling
can compare runs without re-parsing native k6 JSON.

---

## Sample inputs and golden outputs

`samples/` holds checked-in real-shape inputs plus the unified-report
output they produce. To regenerate the golden files after a schema or
adapter change:

```bash
npx tsx scripts/build-samples.ts
```

The samples are referenced from the adapter unit tests; CI fails if they
drift from the source data without an explicit regeneration.
