# rskj-regression

A unified regression-testing harness for the [rskj](https://github.com/rsksmart/rskj)
node. It is being built to bring up a representative network topology
(bitcoind + powpeg federators + a real-miner rskj node) and run a selectable
slice of the three existing RSK test suites against it in a single command,
producing one unified report — human-readable for reviewers, machine-readable
for CI gating.

> Status: **driver POC + single-node orchestrator + report format + adapters.**
> This repo currently contains the driver CLI that runs the hardhat-smoke
> and k6 cherry-pick suites against either a pre-running RPC endpoint
> (`--rpc-url`) or a node it spins up itself from a rskj fat JAR
> (`--auto-node --rskj-jar <path>`), and emits one unified report.
> Underneath sits the unified regression-report schema as TypeScript
> types and JSON, JUnit XML and Markdown emitters, the hardhat and k6
> suite-output adapters, and a small `@rsksmart/network-orchestrator`-shaped
> library at `src/orchestrator/` that spins up an isolated rskj regtest
> node and tears it down cleanly. Full topology (bitcoind + federators)
> is a follow-up task; see [Roadmap](#roadmap) below.

## Why

RSK has three complementary test suites today, each owning a different
quality axis:

| Suite                                                                                  | Owns                                                  | Stack                              | Topology                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| [rskj-hardhat-tests](https://github.com/rsksmart/rskj-hardhat-tests)                   | Consensus correctness (EIPs, RSKIPs, bridge ABI)      | Hardhat + Mocha + Chai + ethers v6 | Single rskj node                                  |
| [rskj-k6-tests](https://github.com/rsksmart/rskj-k6-tests)                             | Performance & load (RPC throughput, gas-limit stress) | k6 (own JS runtime)                | Single rskj node, perf-tuned                      |
| [rootstock-integration-tests](https://github.com/rsksmart/rootstock-integration-tests) | End-to-end peg, federation, fork activations          | Mocha + web3.js (JavaScript)       | bitcoind + 3 powpeg JVMs (+ optional TCP signers) |

Today, running all three for a single change means juggling three toolchains,
three environments, and three report formats. The cost is high enough that
full regression usually only happens at release sign-off. `rskj-regression`
aims to bring that cost down to "press one button" so it can be run on every
nontrivial change.

## Repository layout

```
.
├── src/
│   ├── report/         # Unified report schema + JUnit / Markdown emitters
│   ├── adapters/       # Per-suite adapters: hardhat / k6 → unified shape
│   ├── driver/         # CLI / config / preset / suite-runners (the POC driver)
│   ├── orchestrator/   # Single-rskj-node spawner (port-utils, HOCON config,
│   │                   # JVM runner, RPC-readiness probe)
│   ├── cli.ts          # `rskj-regression` CLI entry
│   └── index.ts        # Public re-exports
├── bin/
│   └── rskj-regression.js  # Binary stub invoked via `npx rskj-regression`
├── test/               # Unit tests for the harness itself
├── samples/            # Real-shape sample inputs + golden unified outputs
├── scripts/            # Utilities (e.g. samples:build)
├── docs/               # Format specs + reference docs
├── .github/workflows/  # CI: lint, format, type-check, unit tests
├── eslint.config.js    # Flat-config ESLint setup
├── tsconfig.json
├── package.json
└── README.md
```

The three driven suites live in their own repos and are **not** vendored
here — the driver invokes them as external commands or library calls.

The unified regression-report format (the contract every adapter
produces and every emitter consumes) is documented in
[`docs/unified-report-format.md`](docs/unified-report-format.md).

## Requirements

- Node.js 22 or newer (see [`.nvmrc`](.nvmrc))
- npm 10 or newer

## Getting started

```bash
git clone https://github.com/rsksmart/rskj-regression.git
cd rskj-regression
npm install
npm test
```

The test suite covers the unified-report schema, the JUnit and Markdown
emitters, the hardhat and k6 adapters, the driver's CLI / config / preset
plumbing and the suite runners' fake-process paths, and a drift check
against the checked-in golden samples; a green run confirms the toolchain
and the adapters are wired up correctly.

## Driving a regression run

Once `npm run build` has produced `dist/`, the driver CLI is available as
`bin/rskj-regression.js` (also resolvable as `npx rskj-regression`).

**Against a pre-running node:**

```bash
rskj-regression run smoke \
  --rpc-url http://localhost:4444 \
  --network rsk_regtest
```

**Spinning up its own node (single-node orchestrator):**

```bash
rskj-regression run smoke \
  --auto-node \
  --rskj-jar /abs/path/to/rskj-core-X.Y.Z-all.jar
```

In both cases the `smoke` preset runs the rskj-hardhat-tests
`[smoke]`-tagged subset plus the `eth_blockNumber` k6 per-method test,
and writes a three-format unified report bundle
(`report.json` / `report.xml` / `report.md`) under `./reports/<run-id>/`.
The process exits 0 when the overall verdict passes and 1 when it does
not. See [`docs/driver-poc.md`](docs/driver-poc.md) for the full CLI
surface, sibling-repo path resolution, and the run-all vs. fail-fast
failure policy, and [`docs/orchestrator-single-node.md`](docs/orchestrator-single-node.md)
for the `--auto-node` path and the underlying library API.

## Using the orchestrator as a library

The `src/orchestrator/` subtree is re-exported from the package root so
other tools (or the suites themselves, during local iteration) can
consume it directly:

```ts
import { startRskjNode } from "rskj-regression";

const node = await startRskjNode({
  jarPath: "/abs/path/to/rskj-all.jar",
  // ports + dataDir are auto-allocated when omitted
});
await node.ready();
console.log(`hit me at ${node.rpcUrl}`);
// ...
await node.stop(); // idempotent
```

See [`docs/orchestrator-single-node.md`](docs/orchestrator-single-node.md)
for the full API surface and config defaults.

## Common commands

| Command                 | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm test`              | Run the Mocha unit-test suite                                               |
| `npm run lint`          | ESLint over the entire repo                                                 |
| `npm run lint:fix`      | ESLint with autofix                                                         |
| `npm run format`        | Apply Prettier formatting                                                   |
| `npm run format:check`  | Prettier check (CI-friendly)                                                |
| `npm run type-check`    | `tsc --noEmit` against `tsconfig.json`                                      |
| `npm run build`         | Emit JS + declaration files into `dist/`                                    |
| `npm run samples:build` | Regenerate `samples/unified/` golden outputs from the checked-in raw inputs |
| `npm run verify`        | Format check + lint + type-check + tests (mirrors what CI runs)             |

## Tooling decisions

- **Language: TypeScript.** Consistent with `rskj-hardhat-tests` and keeps
  the repo in the same family as the three suites it drives.
- **Test runner: Mocha + Chai.** Same combination used by both
  `rskj-hardhat-tests` and `rootstock-integration-tests`; tests written here
  will feel familiar to existing contributors.
- **Linter: ESLint v9 flat config + `typescript-eslint`.** Aligned with the
  current ESLint major used across the sibling repos.
- **Formatter: Prettier**, with `eslint-config-prettier` to keep the two
  tools out of each other's way.
- **CI: GitHub Actions** running lint, format check, type-check, and unit
  tests on every push and pull request.

## Roadmap

This repo is being built incrementally. Each step lands in its own PR.

1. **Bootstrap** — scaffolding, lint, format, tests, CI. _(this commit)_
2. **Unified report format + suite-output adapters** — define the JSON + Markdown contracts the driver will emit; build small adapters that normalize each suite's native output into the unified schema.
3. **Driver-aggregation POC** — against an already-running node, kick off `hardhat`'s smoke subset plus one k6 cherry-pick scenario, normalize their output, emit one report. No orchestration yet.
4. **Single-node orchestrator** — extract a single-rskj-node spinner from RIT's process runners; wire the driver to bring it up automatically.
5. **Mining-model spike** — pick between (a) rskj internal miner + continuous bitcoind, (b) external CPU miner via `getWork`/`submitBitcoinBlock`, or (c) rskj internal miner + on-demand bitcoind. Outcome decides the topology config schema.
6. **Full topology** — extend the orchestrator to `bitcoind + N powpeg federators (± TCP signers) + 1 vanilla rskj miner`.
7. **Build-sourcing modes** — accept any of: a reproducible-builds version pin, a custom set of JARs + tcpsigner binary, or build-from-SHA.
8. **CI integration** — run on every push to `-rc` branches and on demand from PR labels.
9. **RIT integration (optional)** — refactor `rootstock-integration-tests` to consume the shared orchestrator, once the pattern has proven valuable for the other two suites.

## Out of scope

- Replacing any existing suite. The three suites continue to exist and run
  independently for their own purposes. `rskj-regression` only adds a new
  way to run them together.
- Replacing release-time performance characterization (the full k6 suite
  stays manual / on-demand) or release-time exhaustive compatibility runs
  (the full hardhat suite stays a pre-release activity).
- Replacing RIT in CI. RIT continues to run on every PR with its current
  orchestration; absorbing it into the shared orchestrator is an explicit
  later-phase decision.

## License

[MIT](./LICENSE)
