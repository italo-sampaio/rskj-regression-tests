# RIT suite integration

The driver wires [`rootstock-integration-tests`](https://github.com/rsksmart/rootstock-integration-tests)
(RIT) in as a third child suite alongside hardhat and k6. RIT is the
black-box powpeg 2WP test layer: it boots real `bitcoind` + powpeg federate
JVMs and drives them through Mocha specs.

## Why RIT self-orchestrates (and why it ignores `--auto-node` / `--rpc-url`)

Unlike hardhat and k6, RIT is **not a client of an external RPC node**. Its
Mocha global `before`-hook (in the repo-root `test.js`) boots its own
`bitcoind` daemon and **three powpeg federate JVMs**, mines the initial
blockchain, and only then loads the spec files.

Consequence: there is nothing for the driver's orchestrator to do. The RIT
runner ignores `--auto-node` and `--rpc-url` entirely — the driver never even
passes an RPC URL to it. What RIT _does_ need is told where the powpeg fat JAR
and the `bitcoind` binary live; it spawns those itself via environment
variables.

## The `INCLUDE_CASES` subset mechanism (and the gotcha)

RIT has **no `.mocharc`** and **no `mocha` key** in its `package.json`. So
`mocha` falls back to its default spec glob (`['test']`), which loads the root
`test.js`. That file's `before`-hook boots the cluster, then glob-loads
`tests/**/*.js`, **filtered by the `INCLUDE_CASES` env var** — a comma-separated
list of **filename prefixes** matched with `path.basename(file).startsWith(...)`
(see `needsToBeTested` in `test.js`).

**Critical gotcha:** never pass explicit spec file paths to mocha. Doing so
replaces the default spec, so `test.js` (and therefore the entire
cluster-bootstrap `before`-hook) never loads — no bitcoind, no federates, no
test will pass. A subset is selected **purely** by setting `INCLUDE_CASES` and
keeping mocha on its default entry point.

Because RIT tests run sequentially against **shared blockchain state**, a
subset must lead with the bootstrap sync test (`00_00_01-sync`), which forms
the federation and mines the initial chain that later tests assert against.

The driver maps a preset's `includeCases: string[]` directly to
`INCLUDE_CASES` (comma-joined). Omitting it runs the full suite.

## Reporter choice: `mocha-junit-reporter` + the existing `junit-xml.ts` adapter

RIT already ships `mocha-junit-reporter@2.2.1` as a dependency. The runner
invokes mocha with `--reporter mocha-junit-reporter` and points its output at
an absolute path via the `MOCHA_FILE` env var. The resulting JUnit XML is fed
to the **existing** `adaptJUnitXml` adapter (`kind: "rit"`, `merge: true`) —
**zero new adapter code**. RIT emits one `<testsuite>` per spec file, so the
runner merges them into a single logical `rit` suite, matching the hardhat
runner's behaviour.

We deliberately do **not** use mocha's built-in `json` reporter: it partitions
results into `passes` / `pending` / `failures` arrays and omits a per-test
`state` field that the hardhat-json adapter keys off — it would misclassify
every test.

## Environment contract

The runner sets these env vars for the mocha child (cwd = the RIT checkout):

| Var                    | Value set by the runner                                     | Notes                                                                                                                 |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POWPEG_NODE_JAR_PATH` | `--powpeg-jar` / `POWPEG_NODE_JAR_PATH`                     | **Caller must supply.** The RIT repo's own `.env` default points at a stale SNAPSHOT jar that does not exist on disk. |
| `BITCOIND_BIN_PATH`    | default `/home/italo/workspace/bitcoin-0.18.1/bin/bitcoind` | bitcoind 0.18.1.                                                                                                      |
| `CONFIG_FILE_PATH`     | `./config/regtest-all-keyfiles`                             | Keyfile-only federation — **no HSM / tcpsigner**.                                                                     |
| `INCLUDE_CASES`        | from the preset's `includeCases`                            | Omitted when empty (full suite).                                                                                      |
| `EXEC_ENV`             | `Ubuntu`                                                    | Non-MACOS native binaries (irrelevant for keyfile config).                                                            |
| `MOCHA_FILE`           | absolute report path                                        | Where the JUnit XML is written; resolved against the driver output dir.                                               |
| `BITCOIN_DATA_DIR`     | default `<ritTestsPath>/bitcoin-data`                       | See gotcha below.                                                                                                     |

### The `bitcoin-data` gotcha

RIT's `lib/bitcoin-runner.js` sets `removeDataDirOnStop: true` and uses the
data dir as the bitcoind child's **cwd**. Node's `spawn()` throws `ENOENT` if
that cwd is missing — even when the binary path is valid. The runner
`mkdir -p`'s `BITCOIN_DATA_DIR` (and the report dir) before every run.

## Failure semantics

Mirrors the hardhat / k6 runners:

- A RIT run that produces a JUnit XML with **failing testcases** yields a
  `passed_overall: false` suite — not a runner error.
- The runner synthesises an `error`-status suite only in the **catastrophic**
  case: bitcoind or a federate JVM fails to boot, so the Mocha `before`-hook
  throws and no `MOCHA_FILE` is written (or it's stale / unparseable). That
  surfaces as a `MissingReport` (or `ReadError` / `AdapterError`) error suite,
  never a thrown exception.

## CLI / preset wiring

```
rskj-regression run full --rpc-url <url> \
  --rit-tests-path <RIT checkout> \
  --powpeg-jar /path/to/federate-node-*-all.jar
```

- `--rit-tests-path` / `RIT_TESTS_PATH` — RIT checkout. Peer-dir fallback:
  `<repo-parent>/rootstock-integration-tests`. Only RIT presets need it, so
  its existence is **not** force-validated at config time.
- `--powpeg-jar` / `POWPEG_NODE_JAR_PATH` — powpeg fat JAR. Required when a
  preset includes a RIT run; the driver raises a clear error otherwise.

The `full` preset = the commit-time `smoke` runs (hardhat + k6) plus a
`rit-2wp-smoke` run (`00_00_01-sync` + `01_01_02-calls-to-bridge-methods`).
The `smoke` preset is unchanged and RIT-free.
