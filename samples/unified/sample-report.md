# Regression report — ❌ FAILED

## Run

- **Run ID:** `sample-run-0001`
- **rskj version:** `vetiver-9.0.1-gaslimit-RC1`
- **Network:** `regtest`
- **RPC URL:** `http://localhost:4444`
- **Started:** `2026-05-20T12:00:00Z`
- **Ended:** `2026-05-20T12:18:30Z`
- **Duration:** 8m 34s
- **Labels:** source=scripts/build-samples.ts

## Overall verdict

**❌ FAILED** — 7/10 passed, 2 failed, 0 errored, 1 skipped.

## Suites

| Suite | Kind | Verdict | Total | Passed | Failed | Skipped | Errored | Duration |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hardhat-smoke | hardhat | ❌ FAILED | 6 | 4 | 1 | 1 | 0 | 2m 3s |
| k6:eth_blockNumber | k6 | ✅ PASSED | 1 | 1 | 0 | 0 | 0 | 30.16 s |
| k6:storage_stress | k6 | ❌ FAILED | 3 | 2 | 1 | 0 | 0 | 6m 0s |

## Failures

### FAILURE: `hardhat-smoke` › Bridge Contract Functions › should reject peg-in with malformed locking script
- **File:** `/repo/test/token-bridge/BridgeTest.ts`
- **Duration:** 12.35 s
- **Type:** `AssertionError`

```
expected '0x' to equal '0x01'
```

<details><summary>Stack trace</summary>

```
AssertionError: expected '0x' to equal '0x01'
    at Context.<anonymous> (/repo/test/token-bridge/BridgeTest.ts:142:8)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
```

</details>

### FAILURE: `k6:storage_stress` › stress_call_response_time › stress_call_response_time: p(99)<200
- **Duration:** 0 ms
- **Type:** `ThresholdViolation`

```
k6 threshold violated on stress_call_response_time: p(99)<200
```
