# Driver POC — `rskj-regression run`

The `rskj-regression` binary is a thin coordinator that runs a
hardhat-smoke slice and a k6 cherry-pick scenario against an already-running
RPC endpoint, normalizes both suites' native output through the existing
adapters, and emits one unified-report bundle to disk.

This is the [phase-1 POC](https://www.notion.so/rootstock/Leverage-RIT-for-regression-366c132873f9809a9f44c6ae72988f86)
from the regression-testing initiative. The driver _does not_ spin a node
up — orchestration lands in a follow-up task.

## CLI surface

```
rskj-regression run <preset> --rpc-url <url> [options]
```

| Flag                       | Description                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--rpc-url <url>`          | Required. RPC endpoint every suite hits.                                                                       |
| `--network <name>`         | Hardhat network identifier (default `rsk_regtest`). Picks the block in the sibling repo's `hardhat.config.ts`. |
| `--hardhat-tests-path <p>` | Local clone of `rskj-hardhat-tests`. Falls back to `$HARDHAT_TESTS_PATH`, then the peer-directory convention.  |
| `--k6-tests-path <p>`      | Local clone of `rskj-k6-tests`. Falls back to `$K6_TESTS_PATH`, then the peer-directory convention.            |
| `--output-dir <dir>`       | Output bundle directory. Defaults to `./reports/<run-id>/`.                                                    |
| `--run-id <id>`            | Override the auto-generated run id (`YYYYMMDD-HHMMSS-<rand>`).                                                 |
| `--rskj-version <v>`       | Label carried into report metadata.                                                                            |
| `--fail-fast`              | Stop after the first failing suite. Default is **run-all**: every suite runs even when an earlier one failed.  |
| `-h`, `--help`             | Show usage.                                                                                                    |

Exit code:

- `0` — overall verdict passed.
- `1` — at least one suite failed or errored.
- `2` — argv / configuration error (missing flag, unknown sub-command,
  sibling-suite path does not exist, ...).
- `3` — driver itself threw an unexpected error.

## How sibling-suite paths resolve

The driver does **not** vendor or clone the suite repos. It expects them
on disk and looks them up in this order:

1. Explicit `--hardhat-tests-path` / `--k6-tests-path` flag.
2. `HARDHAT_TESTS_PATH` / `K6_TESTS_PATH` env vars.
3. The peer-directory convention: `<rskj-regression-parent>/rskj-hardhat-tests`
   and `<rskj-regression-parent>/rskj-k6-tests`. This is what works
   locally for everyone who clones the three repos side by side.

The driver `statSync`s the resolved paths before starting any suite —
when none of the three sources points at an existing directory, it
exits 2 with a message telling you which knob to set.

## Presets

Presets are declarative bundles of `{ hardhat | k6 }` runs:

| Preset  | Description                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smoke` | Commit-time gating: hardhat `[smoke]` subset + `tests/eth-blockNumber.js`. Asserts shape and basic latency; does not exercise gas-limit or PTE stress. |

The catalogue lives in [`src/driver/presets.ts`](../src/driver/presets.ts) —
add new presets there. The k6 cherry-pick is intentionally drawn from
`rskj-k6-tests/tests/` (per-RPC-method smokes) rather than from
`scenarios/` (load / stress profiles): the latter need a perf-tuned node
config and are release-time certification signals, not commit-time
gating ones.

## What gets written

For every successful invocation the driver creates `<output-dir>/` and
writes:

```
report.json   # Canonical UnifiedReport (source of truth)
report.xml    # JUnit XML projection (for CI gating)
report.md     # Markdown summary (human / PR comment)
```

The shape of `report.json` is the same one the adapters emit — see
[`unified-report-format.md`](unified-report-format.md). The Markdown
summary opens with a `✅ PASSED` / `❌ FAILED` badge and includes a
per-suite verdict table plus a "Failures" section with the failing
tests' messages and (truncated) stack traces.

## Failure policy

**Default: run-all.** All suites in the preset execute, even when an
earlier suite fails. The report lists every suite with its individual
verdict, and the overall verdict is `false` iff any suite failed.

**`--fail-fast`:** the driver stops iterating after the first suite that
yields `passed_overall: false`. Subsequent suites do not run and do not
appear in the report. The report's metadata labels include
`stoppedEarly: "true"` so consumers can distinguish a fail-fast skip
from a clean pass.

Rationale: commit-time gating wants to see _everything_ that broke, not
just the first thing — a flaky hardhat suite shouldn't hide a k6
threshold violation. `--fail-fast` exists for the developer-iteration
case ("don't waste my time running the slower k6 step when hardhat
already failed").

## Suite-runner contract

Each suite runner is a small function that:

1. Shells out to the sibling tool (`npx hardhat test` / `k6 run`),
   inheriting `process.env` plus a couple of suite-specific overrides
   (`HARDHAT_NETWORK`, `SMOKE`, `RPC_URL`).
2. Captures stdout / stderr and mirrors them to the driver's own
   stdout / stderr so progress is visible in CI logs.
3. Reads back the native output file the sibling tool writes
   (`results/result.json` for hardhat — written by the sibling repo's
   global mocha `setup.ts` — and the project-native summary JSON for k6).
4. Hands it to the relevant adapter (`adaptHardhatResultJson` /
   `adaptK6Summary`). A JUnit-XML adapter for hardhat lives alongside
   for future use, but the POC consumes JSON because hardhat 3 only
   allows one mocha reporter and the sibling repo's slot is already
   taken by the JSON collector.
5. Returns a `UnifiedSuite`. Process-level failures (no output file,
   adapter rejects the document, child terminated by signal) yield a
   synthetic single-test `error`-status suite so the report always has
   something to surface.

The runners are pure async functions and accept dependency-injection
hooks (`spawnFn`, `readFileFn`, `existsFn`) so the unit tests can drive
them without touching disk or forking real children — see
`test/driver/runners/`.

## Out of scope for this POC

- Orchestrating an rskj node — caller's responsibility for now.
- Building rskj from source / pinning a JAR — caller's responsibility.
- Full topology (federators + bitcoind + miner) — phase-4 task.
- A CI workflow that gates on `-rc` branches — phase-4 task.
- HTML rendering — Markdown is the only human-readable output.
- Vendoring the sibling repos — they're discovered on disk.
