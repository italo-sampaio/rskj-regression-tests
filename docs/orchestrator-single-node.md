# Network orchestrator — single-node topology

The `src/orchestrator/` subtree is a library that knows how to spin up
an isolated rskj regtest JVM and tear it down cleanly. It's the v1
surface of the network orchestrator described in §"Target architecture"
of the [regression-testing initiative](https://www.notion.so/rootstock/Leverage-RIT-for-regression-366c132873f9809a9f44c6ae72988f86).

This task delivers the **single-rskj-node** path. Bitcoind + powpeg
federators + TCP signers come in the full-topology task (#6); the
schema in `topology.ts` already reserves slots for them.

## What it is, what it isn't

**Is:**

- A small TypeScript package exporting `startRskjNode(config)` →
  `Promise<RskjNodeHandle>`.
- Dynamic free-port allocation in the 30000–30200 range, with explicit
  port pinning available.
- HOCON config generation under a per-run data directory (no shared
  `~/.rsk/regtest/database` collisions).
- An idempotent `stop()` that SIGTERMs the JVM, waits 15 s for the
  shutdown hook to flush, then SIGKILLs if needed, and removes the data
  dir unless the caller opts out.
- Adapter-friendly: the lower-level `spawnRskjNode` accepts injection
  hooks for `spawnFn` / `mkdtempFn` / port + readiness probes so unit
  tests don't fork real JVMs.

**Isn't:**

- A federator / bitcoind / signer runner. Those land in task #6.
- A build-from-SHA / reproducible-builds resolver. That's task #7.
- A long-running daemon — the orchestrator owns the JVM lifecycle for
  the duration of one driver run.

## API surface

```ts
import { startRskjNode } from "rskj-regression";

const node = await startRskjNode({
  jarPath: "/abs/path/to/rskj-core-9.1.0-SNAPSHOT-all.jar",
  // All optional:
  rpcPort: 4444,
  p2pPort: 50501,
  dataDir: "/tmp/my-rskj",
  keepDataDir: false,
  configOverrides: { targetgaslimit: 12_500_000 },
  jvmArgs: ["-Xmx2g"],
  readinessTimeoutMs: 60_000,
  log: (line) => console.log(line),
});

await node.ready(); // resolves when eth_blockNumber answers
console.log(node.rpcUrl); // http://127.0.0.1:<port>

// ...run your suite here...

await node.stop(); // idempotent
```

The handle exposes `rpcUrl`, `rpcPort`, `p2pPort`, `dataDir`, `pid`,
`ready()`, and `stop()`. See `src/orchestrator/topology.ts` for the
authoritative type definitions.

## Defaults baked into the generated config

The orchestrator generates a HOCON file at `<dataDir>/rskj.conf` on
every start. Baseline keys (overridable via `configOverrides`):

| Key                               | Default                              | Why                                                                  |
| --------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `peer.discovery.enabled`          | `false`                              | Single node, no DHT peers to find.                                   |
| `peer.port`                       | dynamic                              | Picked from the free-port allocator unless `p2pPort` is set.         |
| `peer.privateKey`                 | sha256("rskj-regression:" + p2pPort) | Deterministic-per-port so two orchestrated nodes don't collide.      |
| `rpc.providers.web.http.enabled`  | `true`                               | RPC is the whole point.                                              |
| `rpc.providers.web.http.host`     | `"0.0.0.0"`                          | Hardhat / k6 can hit it from any loopback interface.                 |
| `rpc.providers.web.http.port`     | dynamic                              | Picked from the free-port allocator unless `rpcPort` is set.         |
| `rpc.providers.web.http.cors`     | `"*"`                                | Permissive for local suites; matches rskj's bundled `regtest.conf`.  |
| `rpc.providers.web.http.hosts`    | `["*"]`                              | Same reason.                                                         |
| `miner.server.enabled`            | `true`                               | Need the mining loop to advance state.                               |
| `miner.client.enabled`            | `true`                               | Autominer on — suites don't have to RPC-poke for blocks.             |
| `miner.client.delayBetweenBlocks` | `"1 second"`                         | Same cadence as bundled `regtest.conf`.                              |
| `database.dir`                    | `<dataDir>/db`                       | Per-run isolation; no `~/.rsk/regtest/database` cross-contamination. |
| `database.reset`                  | `true`                               | Fresh state every time.                                              |
| `genesis`                         | `"rsk-dev.json"`                     | Matches `--regtest`'s genesis selection.                             |
| `wallet.enabled`                  | `true`                               | Funded by whichever suite runs.                                      |

The JVM is invoked with `--regtest` on the command line, which sets the
network preset (hard-fork heights at zero, devnet genesis, etc.). The
generated config layers on top.

## Why `-cp <jar> co.rsk.Start` and not `-jar`

rskj's current `build.gradle` produces a fat JAR with a literal
unevaluated Gradle expression in the manifest:

```
Main-Class: extension 'application' property 'mainClass'
```

`java -jar` refuses to start with that, so the orchestrator uses
`java -cp <jar> co.rsk.Start --regtest` instead — same invocation style
RIT's `federate-runner.js` uses for the powpeg JVM. If/when rskj fixes
the manifest, we can switch to the cleaner `-jar` form.

## Port allocation

We probe ports in `[30000, 30200]` with a 250 ms TCP-connect timeout,
treating refused connections as "free". This is RIT's heuristic
(`lib/port-utils.js`, `findFreePorts`) — slower than
`server.listen(0)` but stable: the kernel-allocated ephemeral port
could be snatched between the time we hand it back and the time the
JVM `bind()`s it.

Callers that pin `rpcPort` / `p2pPort` explicitly skip the probe.

## Test seams

Both `spawnRskjNode` and `startRskjNode` accept hook overrides for
`spawnFn`, `mkdirFn`, `mkdtempFn`, `writeFileFn`, `rmFn`,
`findFreePortsFn`, `waitForPortFn`, `waitForRpcReadyFn`, and the java
binary path. The unit tests in `test/orchestrator/rskj-runner.test.ts`
exercise the full lifecycle without touching disk, the network, or
java.

For end-to-end validation against a real JAR, use a small driver
script (we used `/tmp/verify-orchestrator.mjs` during development) —
the test suite stays fast on purpose.

## Driver integration

The driver gains a new opt-in flag pair:

```
rskj-regression run smoke --auto-node --rskj-jar <path>
```

When `--auto-node` is set, the driver:

1. Resolves the JAR path (must be absolute, must exist).
2. Calls `startRskjNode({ jarPath })`, awaits `ready()`.
3. Patches the resolved `rpcUrl` onto its config so suites see the
   right endpoint.
4. Runs the preset's suites against that URL.
5. Calls `handle.stop()` in `finally` — even when a suite throws.

The pre-existing `--rpc-url <url>` flow is **unchanged**; both modes
coexist, the two are mutually exclusive at argv-parse time. The
phase-1 betanet-style integration test (167/203 against
`http://node-use1-1.betanet.rskcomputing.net:4444`) still works without
modification.

Report metadata includes `labels.autoNode = "true"` when the
orchestrator owned the JVM lifecycle, so downstream consumers can
distinguish auto-node runs from pre-existing-endpoint runs.

## Out of scope for this task (deferred)

- `bitcoind-runner.ts`, `federate-runner.ts`, `federate-starter.ts`,
  `tcpsigner-runner.ts` — task #6 (full topology).
- `BitcoindConfig`, `FederatorConfig`, `SignerConfig` — task #6.
- Build-from-SHA / reproducible-builds resolver — task #7.
- CI workflow that uses `--auto-node` — task #8.
- A JSON-schema generator emitting types from `topology.ts` —
  deferred; the TypeScript types are the contract for now.

## See also

- [`docs/state-isolation.md`](state-isolation.md) — decision log on
  cross-suite state contamination.
- [`docs/driver-poc.md`](driver-poc.md) — driver CLI surface (now
  augmented with `--auto-node`).
- [`docs/unified-report-format.md`](unified-report-format.md) — report
  schema reference.
