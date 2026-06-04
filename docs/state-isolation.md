# State isolation between suites

## Question

When `rskj-regression run <preset>` invokes more than one suite against
the same node (today: hardhat smoke + a k6 cherry-pick), the suites
share whatever state hardhat left behind. Should the orchestrator
snapshot / revert chain state between suites, or accept the
cross-contamination?

This task asks us to decide and document; the decision then drives the
orchestrator's API surface (snapshot/revert hooks vs. nothing).

## Decision

**Accept cross-contamination.** The orchestrator does **not** snapshot
or revert state between suites in v1. Each `rskj-regression`
invocation spins up a fresh JVM with a brand-new data directory, runs
every suite in the preset against the same instance in declaration
order, and tears the whole topology down at the end.

## Why

1. **Fresh-per-invocation is already isolation.** With `--auto-node`,
   the data dir is a unique `mkdtemp(/tmp/rskj-regression-XXXX)` that
   gets removed on `stop()`. Two consecutive `rskj-regression run`
   invocations are fully independent. The question is only about
   cross-suite contamination _within_ one invocation.

2. **Hardhat and k6 are designed to be order-independent for the
   smoke preset.** The hardhat compatibility tests deploy their own
   contracts to a fresh address per `it()`, fund accounts in the
   global `setup.ts`, and don't depend on prior state. The k6 smoke
   (`eth_blockNumber`) is read-only RPC. Re-ordering them or running
   them against a node mid-hardhat doesn't affect either's verdict.

3. **Snapshot/revert isn't free.** RSK exposes `evm_snapshot` /
   `evm_revert` only when test RPC methods are enabled, and the
   semantics on a real-mining node (autominer producing blocks every
   second) are messy: `evm_revert` rolls back contract state but not
   the miner's view of head, so the next mined block can contain
   transactions referencing reverted accounts. Wiring this safely
   would require pausing the miner, evicting the txpool, and
   re-syncing the mining harness — a significant surface for a
   payoff (cross-suite isolation we don't need today) that doesn't
   exist.

4. **The release-time full-suite use case doesn't need it either.**
   Even when the preset grows to include more suites (federation tests
   in phase 4, etc.), the design intent is _one cohesive regression
   pass_. If a particular suite needs isolation it can spin up its own
   sub-topology — the orchestrator gives you the primitives. The
   default "shared node, no rollback" is the right baseline.

## What the orchestrator does instead

- **Per-invocation freshness.** `--auto-node` always allocates a new
  data dir under `os.tmpdir()` and removes it on `stop()` unless the
  caller sets `keepDataDir: true`.
- **`database.reset = true`** in the generated HOCON, so even if a
  caller pins `dataDir` to an existing path, the trie starts from
  genesis.
- **Deterministic-per-port `peer.privateKey`.** Two orchestrated nodes
  on the same host don't accidentally peer with each other when the
  full-topology task lands.

## Re-evaluation triggers

We'll revisit this decision if any of the following becomes true:

- A future preset adds a suite that _writes_ state another suite
  depends on the absence of (e.g. a hardhat test that deploys a
  bridge precompile shim conflicting with the federation test's
  expected layout).
- A flaky cross-suite ordering bug surfaces in CI that snapshot /
  revert would actually have prevented.
- The full-topology task discovers a bitcoind interaction that needs
  a "go back to block N" primitive — at which point we'd build the
  rollback infrastructure for that, and incidentally get cross-suite
  isolation for free.

Until one of those fires, the simpler design wins.
