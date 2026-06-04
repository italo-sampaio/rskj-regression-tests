# Driver POC — `rskj-regression run`

The `rskj-regression` binary is a thin coordinator that runs a
hardhat-smoke slice and a k6 cherry-pick scenario against either an
already-running RPC endpoint or a node it spins up itself via the
[single-node orchestrator](./orchestrator-single-node.md). It
normalizes both suites' native output through the existing adapters and
emits one unified-report bundle to disk.

This was the [phase-1 POC](https://www.notion.so/rootstock/Leverage-RIT-for-regression-366c132873f9809a9f44c6ae72988f86)
from the regression-testing initiative; phase 2 added the `--auto-node`
path documented below.

## CLI surface

```
rskj-regression run <preset> --rpc-url <url> [options]
rskj-regression run <preset> --auto-node --rskj-jar <path> [options]
```

| Flag                       | Description                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--rpc-url <url>`          | Use a pre-running node at this URL. Mutually exclusive with `--auto-node`.                                     |
| `--auto-node`              | Spin up an rskj regtest node via the orchestrator and target its RPC.                                          |
| `--rskj-jar <path>`        | Required with `--auto-node`. Absolute path to a rskj fat JAR.                                                  |
| `--network <name>`         | Hardhat network identifier (default `rsk_regtest`). Picks the block in the sibling repo's `hardhat.config.ts`. |
| `--hardhat-tests-path <p>` | Local clone of `rskj-hardhat-tests`. Falls back to `$HARDHAT_TESTS_PATH`, then the peer-directory convention.  |
| `--k6-tests-path <p>`      | Local clone of `rskj-k6-tests`. Falls back to `$K6_TESTS_PATH`, then the peer-directory convention.            |
| `--output-dir <dir>`       | Output bundle directory. Defaults to `./reports/<run-id>/`.                                                    |
| `--run-id <id>`            | Override the auto-generated run id (`YYYYMMDD-HHMMSS-<rand>`).                                                 |
| `--rskj-version <v>`       | Label carried into report metadata.                                                                            |
| `--fail-fast`              | Stop after the first failing suite. Default is **run-all**: every suite runs even when an earlier one failed.  |
| `-h`, `--help`             | Show usage.                                                                                                    |

## `--auto-node` lifecycle

When `--auto-node` is set, the driver:

1. Validates `--rskj-jar` (must exist; resolved relative to `cwd`).
2. Calls `startRskjNode({ jarPath })`, which writes a fresh HOCON
   config under a tmpdir-based data dir, picks free ports in the
   30000–30200 range, and `spawn`s `java -cp <jar> co.rsk.Start --regtest`.
3. Awaits `handle.ready()` — blocks on the RPC port binding plus a
   successful `eth_blockNumber` probe.
4. Patches `handle.rpcUrl` onto the driver's config so the suites
   and the report metadata see the same value.
5. Runs every suite in the preset in order.
6. In `finally`, calls `handle.stop()` — SIGTERMs the JVM (15 s grace)
   then SIGKILLs, and removes the data dir.

The pre-existing `--rpc-url` flow is unchanged. The two modes can't
co-exist on a single invocation — argv parsing rejects it.

Report metadata gains `labels.autoNode = "true"` for auto-node runs so
downstream consumers can distinguish them from pre-existing-endpoint
runs.

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

- ~~Orchestrating an rskj node — caller's responsibility for now.~~
  Done in phase 2: see [`orchestrator-single-node.md`](./orchestrator-single-node.md).
- Building rskj from source / pinning a JAR — caller's responsibility
  for now. Build-sourcing modes land in task #7.
- Full topology (federators + bitcoind + miner) — phase-4 task.
- A CI workflow that gates on `-rc` branches — phase-4 task.
- HTML rendering — Markdown is the only human-readable output.
- Vendoring the sibling repos — they're discovered on disk.
