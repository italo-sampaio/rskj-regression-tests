# Full-topology orchestrator smoke

The orchestrator-task acceptance test. It brings up the **full regression
topology** — 1 bitcoind + 3 genesis PowPeg federators + 1 vanilla rskj miner
node — via `startFullTopology` (in `src/orchestrator`) and proves the
acceptance criteria for _"Extend orchestrator to full regression topology"_.

Task page: `[UPSKILLING] Extend orchestrator to full regression topology`.

## What it proves (5 checks)

| Check               | What it asserts                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`              | bitcoind (+400-block coinbase-maturity mine) + 3 federates + miner all answer JSON-RPC; wall-clock boot reported (target < 30s)                                 |
| `federation-formed` | `getFederationAddress()` on **all three** federates equals the regtest genesis federation address `2N5muMep…` — they loaded and agree on the genesis federation |
| `federation-vote`   | `voteFeePerKbChange` from the regtest fee-per-kb authorizer key changes `getFeePerKb()` after one mined block — the federation can be governed                  |
| `exact-k`           | serialized `evm_mine` ×K on the miner advances its height by **exactly K** (Model B; never concurrent — per the exact-K gate)                                   |
| `cross-node-sync`   | every federate reaches the target height with the **same block hash** as the miner — the cluster syncs the miner's chain                                        |

Peg-in scope: the authoritative peg-in/pegout proof is the **RIT 2WP suite**
(reproduced as a child suite via the driver's RIT runner — the spike's 31/31
baseline). This smoke proves the federation is formed, governable, and mines
deterministically with the whole cluster in sync; it does not re-implement
RIT's BTC peg machinery.

## Result (2026-06-10, committed in `data/smoke.json`)

```
PASS boot              — bitcoind + 3 federates + miner ready in 9.3s
PASS federation-formed — all 3 federates report 2N5muMepJizJE1gR7FbHJU6CD18V3BpNF9p
PASS federation-vote   — feePerKb 100000 → 150000 (authorizer 0x53f8f6da…)
PASS exact-k           — miner advanced exactly 10 blocks (1 → 11)
PASS cross-node-sync   — block 11 hash matches on fed-1, fed-2, fed-3
verdict: PASS (5/5)
```

Boot **9.3s** — comfortably under the 30s target.

## Run

```bash
# Node >= 22, Java 17, bitcoind 0.18.1; no extra deps.
BITCOIND_BIN_PATH=/path/to/bitcoind-0.18.1 \
  npx tsx spikes/full-topology/harness/smoke.ts \
    [--powpeg <federate-node-*-all.jar>] [--rskj <rskj fat jar>] \
    [--btc-blocks N] [--k N] [--keep] [--out <dir>]
```

Defaults: powpeg `federate-node-gaslimit-RC1-9.1.0.0-all.jar`, rskj
`9.0.2-VETIVER` (`artifacts/rsk.jar`), 400 BTC blocks, K=10. Output under
`results/<timestamp>/` (gitignored); `--keep` retains the per-process data
dirs for postmortem.

## How the topology is wired (ported from RIT)

The orchestrator ports RIT's `bitcoin-runner.js`, `federate-runner.js`, and
the genesis slice of `config/regtest-all-keyfiles.js` into TypeScript:

- **bitcoind** (`src/orchestrator/bitcoind-runner.ts`) — regtest, dynamic
  ports in 20000–20100, `-deprecatedrpc=generate/signrawtransaction`, mines
  400 blocks at bootstrap.
- **federates** (`src/orchestrator/federate-runner.ts`) — `co.rsk.federate.FederateRunner`
  via `-cp <powpeg jar>`, one generated HOCON conf each (full `peer.active`
  mesh as a real list, BTC/RSK/MST signers pointing at a 0400 key file,
  `miner.client.enabled=false`, all 13 forks at height 1). The genesis
  federation identity (keys, ports, nodeIds, pubkeys) is pinned in
  `src/orchestrator/federation/genesis-federation.ts` — these are consensus
  constants from rskj's regtest genesis and must not be edited.
- **vanilla miner** (`startRskjNode`) — peered into the federation mesh,
  Model B block production (serialized `evm_mine`); this is where the
  hardhat/k6 suites point.

Teardown is reverse order (miner → federates → bitcoind); a mid-bring-up
failure tears down everything already started (unit-tested in
`test/orchestrator/start-topology.test.ts`).

## Layout

- `harness/smoke.ts` — the 5-check acceptance smoke
- `harness/rpc.ts` — fetch-based JSON-RPC + minimal ABI helpers (Bridge selectors)
- `results/` — live outputs (gitignored)
- `data/smoke.json` — committed snapshot of the authoritative run
