/**
 * Topology configuration shapes.
 *
 * The orchestrator's external surface today is **single-node only** — one
 * vanilla rskj JVM, no federation, no bitcoind. But this task is the
 * groundwork for the full-topology rollout (task #6 of the
 * [regression initiative](https://www.notion.so/rootstock/Leverage-RIT-for-regression-366c132873f9809a9f44c6ae72988f86)),
 * so the schema needs to grow into:
 *
 *   - N rskj nodes (vanilla miner + ...).
 *   - 1 bitcoind in regtest.
 *   - M powpeg federators.
 *   - Optional TCP signers (one per federator with `type: "hsm"`).
 *
 * To avoid a v1→v2 schema break later, the {@link TopologyConfig} shape
 * here is already a multi-process record: `rskj` is either one
 * {@link RskjNodeConfig} or an array of them, and the future
 * `bitcoind` / `federators` / `signers` slots get added as optional
 * fields. v1 callers stay source-compatible when those slots arrive.
 *
 * Why the JSON-schema is not generated yet:
 *
 *   Codegen pulls in a build-step dependency (ts-json-schema-generator
 *   or similar). For the POC, the TypeScript types are the authoritative
 *   contract; we'll wire codegen when the full-topology task forces it.
 *   The hand-written documentation here serves as the human spec.
 */

/**
 * Configuration for a single rskj node.
 *
 * The orchestrator turns this into a `co.rsk.Start` invocation with a
 * generated HOCON config under a fresh data dir. Anything not specified
 * falls back to a sensible regtest default (see
 * {@link defaultRskjConfig} in `regtest-config.ts`).
 */
export interface RskjNodeConfig {
  /**
   * Absolute path to a rskj fat JAR (built via `./gradlew fatJar` in the
   * rskj source tree, typically `rskj-core-X.Y.Z-all.jar`). The orchestrator
   * does *not* resolve this — that's task #7 (build-sourcing modes).
   */
  jarPath: string;
  /**
   * Optional JSON-RPC HTTP port. When omitted, the orchestrator picks a
   * free port via {@link findFreePorts}.
   */
  rpcPort?: number;
  /**
   * Optional P2P (`peer.port`) port. When omitted, the orchestrator picks
   * a free port.
   */
  p2pPort?: number;
  /**
   * Optional data directory. When omitted, a fresh `tmpdir` is created
   * and (by default) cleaned up on `stop()`.
   */
  dataDir?: string;
  /**
   * When true, the data directory is left in place after `stop()` —
   * useful for postmortem inspection. Default `false`.
   */
  keepDataDir?: boolean;
  /**
   * Free-form HOCON overrides applied on top of the orchestrator's
   * baseline regtest config. Keys are dotted paths
   * (e.g. `"miner.client.delayBetweenBlocks"`), values are anything the
   * HOCON serialiser accepts.
   *
   * The overrides are written into a generated `.conf` file rather than
   * passed as `-Dkey=value` JVM args — that's clearer in postmortem
   * logs and keeps the command line readable.
   */
  configOverrides?: Record<string, unknown>;
  /**
   * Extra JVM arguments prepended to the spawn (`-Xmx2g` etc). Default
   * is `[]` — we don't pin a heap size for the regression-tests case.
   */
  jvmArgs?: string[];
  /**
   * Optional logger; receives each line of the child's stdout / stderr.
   * If omitted, the orchestrator discards child output (the JVM's own
   * logback file remains the source of truth for debugging).
   */
  log?: (line: string) => void;
  /**
   * Optional readiness timeout in milliseconds. Default 60 000 ms —
   * enough for the JVM to JIT-warm and start answering JSON-RPC.
   */
  readinessTimeoutMs?: number;
}

/**
 * Top-level topology shape. Today it carries only `rskj`. Future tasks
 * add optional `bitcoind`, `federators`, `signers` fields.
 *
 * Single-node callers should pass one {@link RskjNodeConfig}; multi-node
 * callers pass an array. The orchestrator wires P2P peers up automatically
 * when an array is supplied.
 */
export interface TopologyConfig {
  rskj: RskjNodeConfig | RskjNodeConfig[];

  /*
   * Reserved slots — wired in task #6. Adding them as optional fields
   * now means consumers that target the v1 shape stay source-compatible
   * when the full-topology surface lands.
   *
   * bitcoind?: BitcoindConfig;
   * federators?: FederatorConfig[];
   * signers?: SignerConfig[];
   */
}

/**
 * Handle returned by {@link startRskjNode}.
 *
 * `ready()` blocks until the node answers `eth_blockNumber`. `stop()`
 * is idempotent — calling it more than once is a no-op after the JVM
 * has exited.
 */
export interface RskjNodeHandle {
  /** Resolved JSON-RPC URL — e.g. `http://127.0.0.1:30001`. */
  rpcUrl: string;
  /** Resolved RPC port (always equal to the port in {@link rpcUrl}). */
  rpcPort: number;
  /** Resolved P2P port — surfaced for callers that wire peers explicitly. */
  p2pPort: number;
  /** Absolute path to the data directory the JVM is writing into. */
  dataDir: string;
  /** PID of the child JVM, or `null` once the process has exited. */
  pid: number | null;
  /**
   * Block until the node answers `eth_blockNumber` (returns 0 or higher).
   * Safe to call more than once; subsequent calls return immediately
   * after the first success.
   */
  ready(): Promise<void>;
  /**
   * Send SIGTERM (then SIGKILL after a grace period) to the JVM and
   * await its exit. Removes the data directory unless `keepDataDir`
   * was set. Idempotent.
   */
  stop(): Promise<void>;
}
