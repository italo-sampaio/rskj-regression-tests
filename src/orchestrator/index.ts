/**
 * Public surface of the orchestrator library.
 *
 * Consumers should import from this barrel rather than reaching into
 * individual files — the internal layout may shuffle as the
 * full-topology task (task #6) lands.
 *
 * v1 scope: single-rskj-node only. Future expansion:
 *
 *   - `startTopology(topology: TopologyConfig)` returning a multi-handle
 *     bundle (`{ rskj: RskjNodeHandle[]; bitcoind?: BitcoindHandle;
 *     federators?: FederatorHandle[] }`).
 *   - `BitcoindConfig`, `FederatorConfig`, `SignerConfig` types alongside
 *     {@link RskjNodeConfig}.
 *
 * The schema in `topology.ts` already reserves slots for those — adding
 * them won't be a breaking change for v1 callers.
 */

export { startRskjNode } from "./start-rskj-node.js";
export type { StartRskjNodeOptions } from "./start-rskj-node.js";

export { spawnRskjNode } from "./rskj-runner.js";
export type { RskjRunnerHooks } from "./rskj-runner.js";

export type { RskjNodeConfig, RskjNodeHandle, TopologyConfig } from "./topology.js";

export { DEFAULT_PORT_RANGE, findFreePorts, isPortAvailable, waitForPort } from "./port-utils.js";
export type { FindFreePortsOptions, HostPort, WaitForPortOptions } from "./port-utils.js";

export { waitForRpcReady } from "./rpc-readiness.js";
export type { RpcReadinessOptions } from "./rpc-readiness.js";

export { defaultRskjConfig, mergeConfig, renderHocon } from "./regtest-config.js";
export type { ConfigValue, DefaultConfigInputs, FlatConfig } from "./regtest-config.js";
