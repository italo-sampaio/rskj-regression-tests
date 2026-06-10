# Spike: exact-K block advance under concurrent tx load

The **Model B gate** for the regression initiative: the mining-model spike picked
`evm_mine` (+ `miner.client.enabled=false`) as the harness's block-production model and
proved "advance exactly K blocks on demand" — but only on an **idle** node. RIT and the
future full-topology harness mine **with transactions in flight and assert confirmation
counts**, the exact condition never tested. This spike closes that gap.

Task page: `[UPSKILLING] Validate exact-K block advance under concurrent tx load`
(Claude Code Tasks board).

## Risk model (from source recon of rskj master, 2026-06-10)

- `evm_mine` → `MinerManager.mineBlock` → `buildBlockToMine` + `MinerClientImpl.mineBlock`,
  which reads the **shared volatile `currentWork`** (`MinerClientImpl.java:130`) — it does
  NOT pin a private snapshot. The refresh race is real for `evm_mine` too.
- For **serialized** calls every racing rebuild (60s `RefreshBlock` timer, async
  `onPendingTransactionsReceived` rebuilds) shares the same parent, so the mined block
  should still import as `IMPORTED_BEST` (+1). That's the hypothesis the load scenarios test.
- For **concurrent** calls there is no synchronization anywhere on the path; the shared
  `work` field (re-read at `MinerClientImpl.java:132/135/147/148`) predicts siblings,
  `EXIST` imports, and swallowed PoW mismatches → height advances by less than the call
  count. Captured here as an explicit reproducer (informational scenario).
- **Every failure is silent**: the `SubmitBlockResult` is discarded at
  `MinerClientImpl.java:148` and `evm_mine` returns `null` unconditionally. The only
  reliable oracle is `eth_blockNumber` before/after each call — which is exactly what this
  harness (and, by recommendation, the orchestrator's future `mineExactK` helper) asserts.

## Scenarios

| Scenario                     | Load   | `updateWorkOnNewTransaction` | Expectation                         |
| ---------------------------- | ------ | ---------------------------- | ----------------------------------- |
| `baseline-idle`              | none   | false                        | exact-K (spike-T4 parity)           |
| `negative-control-ratelimit` | none   | false (+60s submit limiter)  | oracle **detects** forced silent +0 |
| `load-serial-refresh-off`    | steady | false                        | exact-K                             |
| `load-serial-refresh-on`     | steady | true                         | exact-K                             |
| `load-rapidfire-refresh-on`  | max    | true                         | exact-K                             |
| `soak-refresh-tick`          | steady | true                         | exact-K across ≥2 60s refresh ticks |
| `concurrent-callers`         | none   | false                        | informational (reproducer)          |
| `concurrent-callers-load`    | steady | true                         | informational (reproducer)          |

Validity guards prevent vacuous greens: every load scenario asserts the txpool was
actually non-empty before mines and that mined blocks contained transactions; every
scenario starts with a 5s idle-drift check proving the autominer override took effect.
Audits: per-call height delta, chain lineage, uncle count (must be 0 when serialized —
an uncle is fingerprint evidence of a raced sibling), and exactly-once tx inclusion
after a drain.

## Run

```bash
# from the repo root (Node >= 22, Java 17, no extra deps)
npx tsx spikes/exact-k-under-load/harness/run.ts            # full matrix (~10 min)
npx tsx spikes/exact-k-under-load/harness/run.ts --quick    # reduced reps (~4 min)
npx tsx spikes/exact-k-under-load/harness/run.ts --only soak
npx tsx spikes/exact-k-under-load/harness/run.ts --jar /abs/path/rskj-core-X.Y.Z-all.jar
```

Defaults: jar `/home/italo/workspace/rskj/artifacts/rsk.jar` (9.0.2-VETIVER, the jar the
mining-model spike validated), output under `results/<timestamp>/` (gitignored).
A committed snapshot of the authoritative run lives in `data/`.

Exit code 0 = all gating scenarios PASS (informational scenarios never gate).

## Layout

- `harness/run.ts` — scenario matrix, node lifecycle (via `src/orchestrator`), verdicts
- `harness/scenario.ts` — mining loops, block/uncle/inclusion audits, rsk.log scan
- `harness/load.ts` — cow-account `eth_sendTransaction` flood with local nonce management
- `harness/rpc.ts` — minimal fetch-based JSON-RPC client
- `results/` — live outputs (gitignored): per-scenario `node.log`, `logs/rsk.log`, `metrics.json`
- `data/` — committed snapshot of the authoritative run

The full report and the gate decision live on the Notion task page; this README plus the
committed `data/metrics.json` are the in-repo record.
