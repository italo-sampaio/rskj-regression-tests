# CI regression gate

A GitHub Actions workflow (`.github/workflows/regression.yml`) that runs the
unified regression suite against a build-from-SHA topology and **gates on the
machine-readable verdict**, plus the structured verdict-gate it depends on
(`src/ci/gate.ts` + `src/ci/run-gate.ts`).

## Trigger model — same-repo `workflow_dispatch`

The workflow is triggered manually (or via API) with two inputs:

| Input        | Meaning                                             |
| ------------ | --------------------------------------------------- |
| `rskj_sha`   | rskj commit / branch / tag to build and test        |
| `powpeg_sha` | powpeg-node commit / branch / tag to build and test |
| `preset`     | driver preset (default `full`)                      |

It runs build-from-SHA for both, brings up the full topology, runs
`hardhat-smoke + k6 + RIT 2WP`, and gates.

**Why same-repo only** (scope decision, 2026-06-10): wiring a cross-repo
trigger so a push to a `*-rc` branch on `rsksmart/rskj` or
`rsksmart/powpeg-node` fires this workflow (via `repository_dispatch`), and
commenting the verdict back on those repos' PRs, needs org-level permissions
and team coordination that this self-contained workflow deliberately avoids.
That cross-repo wiring is a **documented handoff** — see
[Cross-repo follow-up](#cross-repo-follow-up).

## The four hardening gates

The verdict gate exists because the mining-model spike showed a run can
"complete" while being silently broken (a candidate SIGSEGV'd yet the combine
step still produced a green-looking partial report). `evaluateGate` enforces:

1. **Gate on process health, not just the suite verdict.** A non-zero driver/
   process exit, a native crash (SIGSEGV / SIGABRT / `hs_err_pid` / "A fatal
   error has been detected by the Java Runtime") found in the captured logs,
   or a missing/empty/unparseable `report.json` fails the run — independently
   of test pass/fail.
2. **Don't trust log-grep for health.** Health is judged from **structured**
   signals — the report's own `errored` / `failed` counts and artifact
   presence — never by grepping logs for `" ERROR "` (which on this codebase
   silently missed 1,982 `baseEvent` WARNs). The log scan that DOES run looks
   only for unambiguous native-crash markers, a different thing from using a
   log line as a health proxy.
3. **Report assembly must be loss-less.** Every suite the preset was expected
   to produce (`--expect hardhat-smoke,k6:eth_blockNumber,rit-2wp-smoke`) must
   be present in the report; a missing suite fails the gate loudly rather than
   passing a partial (green-looking) report.
4. **Exact-K is enforced upstream.** The orchestrator mines serialized and
   asserts +1 per call (the exact-K spike is the Model-B gate); the topology's
   single miner runs the autominer for hardhat/k6, which never issue a
   concurrent `evm_mine`. The CI gate's contribution is to confirm the run
   that depends on this produced every expected suite and crashed nowhere.

`evaluateGate` is pure and exhaustively unit-tested; `runGate` adds the disk
I/O (read `report.json`, scan the logs dir) and writes a Markdown summary to
`$GITHUB_STEP_SUMMARY`.

### Running the gate directly

```bash
npm run build
node dist/src/ci/run-gate.js \
  --report reports/<run-id>/report.json \
  --logs-dir reports/<run-id> \
  --expect hardhat-smoke,k6:eth_blockNumber,rit-2wp-smoke \
  --driver-exit "$DRIVER_EXIT" \
  --summary-file "$GITHUB_STEP_SUMMARY"
```

Exit 0 = gate passes, 1 = gate fails, 2 = bad arguments. The workflow runs the
driver with `continue-on-error` and feeds its exit code in via `--driver-exit`,
so the gate — not the driver's own exit — is the single source of the job's
pass/fail.

## Runtime

The `< 30 min` gating-preset target is a **soft** goal. Building rskj and
powpeg-node from SHA dominates a cold run; the SHA-keyed build cache makes
re-runs of the same SHAs fast. The workflow's `timeout-minutes` is set
generously (90) so a cold build doesn't false-fail; tighten once typical
runtimes are measured.

## Cross-repo follow-up

To make this fire automatically on `*-rc` pushes to the product repos (the
original initiative goal), a follow-up needs, on `rsksmart/rskj` and
`rsksmart/powpeg-node`:

1. A small workflow on each repo that, on push to `**-rc`, sends a
   `repository_dispatch` (or `workflow_dispatch` via the API) to this repo with
   the head SHA — requires a token with `actions:write` on this repo.
2. A step here that posts the gate's Markdown summary back as a commit status /
   PR comment on the originating repo — requires a token with `statuses:write`
   / `pull_requests:write` on that repo.

Both are permission + secret-management tasks for whoever owns the org, which
is why v1 stops at the same-repo `workflow_dispatch` surface above.
