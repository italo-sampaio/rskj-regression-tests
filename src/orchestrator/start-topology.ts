/**
 * Full regression topology: 1 bitcoind + 3 genesis federators + 1 vanilla
 * rskj miner node.
 *
 * This is the multi-process counterpart to {@link startRskjNode}. It wires
 * the pieces RIT's `test.js` global before-hook wires — bitcoind first
 * (with the initial 400-block coinbase-maturity mine), then the three
 * federates in sequence (each pointed at bitcoind and mesh-peered to the
 * others) — and adds what RIT does NOT have: a vanilla rskj node peered
 * into the same regtest chain, configured for Model B block production
 * (`miner.client.enabled=false`, serialized `evm_mine`), which is where
 * the hardhat/k6 suites point.
 *
 * Block-production model (decided by the mining-model spike + the
 * exact-K-under-load gate): never run two uncoordinated block producers.
 * Every node here has `miner.client.enabled=false`; blocks are produced
 * on demand by a single serialized `evm_mine` driver against ONE node
 * (the miner, or fed-1). Concurrent `evm_mine` is forbidden — it produces
 * uncles / lost blocks (100% reproducible; see the exact-K gate).
 *
 * Teardown is reverse order (miner → federates → bitcoind) and every
 * spawned process is killed even if one `stop()` throws.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnBitcoind, type BitcoindConfig, type BitcoindHandle } from "./bitcoind-runner.js";
import { spawnFederate, type FederateConfig, type FederateHandle } from "./federate-runner.js";
import {
  forkActivationOverrides,
  GENESIS_FEDERATION,
  type GenesisFederationMember,
} from "./federation/genesis-federation.js";
import { findFreePorts } from "./port-utils.js";
import { startRskjNode } from "./start-rskj-node.js";
import type { RskjNodeHandle } from "./topology.js";

/** Coinbase maturity is 100 on regtest; RIT mines 400 for headroom. */
const DEFAULT_INITIAL_BTC_BLOCKS = 400;

/** Ports for the vanilla miner — above the federation band (30000–30005). */
const MINER_PORT_RANGE = { rangeStart: 30010, rangeEnd: 30099 } as const;

export interface FullTopologyConfig {
  /** Absolute path to the powpeg `federate-node-*-all.jar`. */
  powpegJarPath: string;
  /**
   * Absolute path to the vanilla rskj fat JAR. When omitted, no miner
   * node is started (federation-only topology) and `handle.miner` is null.
   */
  rskjJarPath?: string;
  /** Federation members to start. Defaults to all three genesis members. */
  members?: readonly GenesisFederationMember[];
  /** BTC blocks to mine at bootstrap (coinbase maturity). Default 400. */
  initialBtcBlocks?: number;
  /** Root dir under which per-process data dirs are created. Default: tmpdir per process. */
  dataRoot?: string;
  /** Keep data dirs after stop() (postmortem). Default false. */
  keepDataDirs?: boolean;
  /** Line logger; receives prefixed output from every process. */
  log?: (line: string) => void;
  /** Per-process readiness timeout (ms). Default 90s (JVMs are heavy). */
  readinessTimeoutMs?: number;
  /** Override the bitcoind config (binary, ports, creds). */
  bitcoind?: Partial<BitcoindConfig>;
  /**
   * Turn the miner node's autominer ON (`miner.client.enabled=true`).
   *
   * Default false (Model B: blocks come only from serialized `evm_mine`,
   * which is what a deterministic harness wants). Set true when the miner
   * faces suites that expect the chain to advance on its own — hardhat / k6
   * never call `evm_mine`, so they need autonomous blocks. This is
   * exact-K-safe: there is exactly ONE block producer (the federates keep
   * `miner.client.enabled=false`) and nothing issues a concurrent
   * `evm_mine`, so the race the exact-K gate found cannot occur.
   */
  minerAutomine?: boolean;
  /**
   * Pin the miner node's JSON-RPC port. Default: a free port in
   * {@link MINER_PORT_RANGE}. Node-facing suites that hardcode a network URL
   * (e.g. rskj-hardhat-tests' `rsk_regtest` → `http://localhost:4444`) can't
   * be told our allocated port, so the driver pins the miner to the standard
   * regtest RPC port they expect. The p2p port is still allocated freely.
   */
  minerRpcPort?: number;
}

/**
 * Side-channel hooks so the bring-up/teardown orchestration is unit-
 * testable without forking bitcoind + four JVMs. Defaults are the real
 * runners.
 */
export interface FullTopologyHooks {
  spawnBitcoindFn?: typeof spawnBitcoind;
  spawnFederateFn?: typeof spawnFederate;
  startRskjNodeFn?: typeof startRskjNode;
  findFreePortsFn?: typeof findFreePorts;
}

export interface FullTopologyHandle {
  bitcoind: BitcoindHandle;
  federates: FederateHandle[];
  /** The vanilla rskj miner node, or null when `rskjJarPath` was omitted. */
  miner: RskjNodeHandle | null;
  /** RPC URL of the node the harness should mine against (miner if present, else fed-1). */
  miningRpcUrl: string;
  /** Stop every process, reverse order. Idempotent; never throws on partial failure. */
  stop(): Promise<void>;
}

/**
 * Bring up the full topology and wait until every process answers JSON-RPC
 * (and bitcoind has mined its initial blocks). Throws — after tearing down
 * whatever did start — if any process fails to become ready.
 */
export async function startFullTopology(
  config: FullTopologyConfig,
  hooks: FullTopologyHooks = {},
): Promise<FullTopologyHandle> {
  const spawnBitcoindFn = hooks.spawnBitcoindFn ?? spawnBitcoind;
  const spawnFederateFn = hooks.spawnFederateFn ?? spawnFederate;
  const startRskjNodeFn = hooks.startRskjNodeFn ?? startRskjNode;
  const findFreePortsFn = hooks.findFreePortsFn ?? findFreePorts;
  const log = config.log ?? ((): void => undefined);
  const members = config.members ?? GENESIS_FEDERATION;
  const readinessTimeoutMs = config.readinessTimeoutMs ?? 90_000;
  const dataRoot = config.dataRoot ? resolve(config.dataRoot) : null;
  if (dataRoot) mkdirSync(dataRoot, { recursive: true });

  const started: { stop: () => Promise<void> }[] = [];
  const teardown = async (): Promise<void> => {
    // Reverse order, swallow individual failures so one stuck process
    // can't strand the others.
    for (const proc of started.reverse()) {
      try {
        await proc.stop();
      } catch (err) {
        log(`[topology] teardown error: ${(err as Error).message}`);
      }
    }
  };

  try {
    // 1. bitcoind + initial mine.
    log("[topology] starting bitcoind…");
    const bitcoind = await spawnBitcoindFn({
      dataDir: dataRoot ? join(dataRoot, "bitcoind") : undefined,
      keepDataDir: config.keepDataDirs,
      readinessTimeoutMs,
      log,
      ...config.bitcoind,
    });
    started.push(bitcoind);
    await bitcoind.ready();
    const initialBlocks = config.initialBtcBlocks ?? DEFAULT_INITIAL_BTC_BLOCKS;
    log(`[topology] mining ${initialBlocks} initial BTC blocks…`);
    await bitcoind.mine(initialBlocks);

    // 2. Federates, sequentially (RIT starts them in order; peer dials to
    //    not-yet-up members just retry — readiness is RPC-level per node).
    const federates: FederateHandle[] = [];
    for (const member of members) {
      log(`[topology] starting federate ${member.id}…`);
      const federateConfig: FederateConfig = {
        jarPath: config.powpegJarPath,
        member,
        bitcoinPeerAddress: bitcoind.peerAddress,
        allMembers: members,
        dataDir: dataRoot ? join(dataRoot, member.id) : undefined,
        keepDataDir: config.keepDataDirs,
        readinessTimeoutMs,
        log,
      };
      const federate = await spawnFederateFn(federateConfig);
      started.push(federate);
      federates.push(federate);
      await federate.ready();
    }

    // 3. Vanilla rskj miner node, peered into the federation chain.
    let miner: RskjNodeHandle | null = null;
    if (config.rskjJarPath) {
      log("[topology] starting vanilla rskj miner node…");
      // Allocate two free ports; when a fixed miner RPC port is requested
      // (suites that hardcode their network URL), use it and keep the freely
      // allocated one for p2p.
      const [allocatedRpcPort, p2pPort] = await findFreePortsFn(2, MINER_PORT_RANGE);
      const rpcPort = config.minerRpcPort ?? allocatedRpcPort;
      const peerActive = members.map((m) => ({
        ip: "127.0.0.1",
        port: m.p2pPort,
        nodeId: m.nodeId,
      }));
      miner = await startRskjNodeFn({
        jarPath: config.rskjJarPath,
        rpcPort,
        p2pPort,
        dataDir: dataRoot ? join(dataRoot, "miner") : undefined,
        keepDataDir: config.keepDataDirs,
        readinessTimeoutMs,
        log,
        configOverrides: {
          // Model B by default (serialized evm_mine). minerAutomine flips
          // the autominer on for suites that expect autonomous blocks
          // (hardhat / k6) — safe because the federates stay client-off, so
          // there is exactly one producer and no concurrent evm_mine.
          "miner.client.enabled": config.minerAutomine === true,
          "miner.server.enabled": true,
          // Peer into the federation mesh (discovery stays off).
          "peer.active": peerActive,
          // Consensus-identical to the federates: all forks active at 1.
          ...forkActivationOverrides(),
        },
      });
      started.push(miner);
      await miner.ready();
    }

    const miningRpcUrl = miner ? miner.rpcUrl : federates[0]!.rpcUrl;
    return {
      bitcoind,
      federates,
      miner,
      miningRpcUrl,
      async stop(): Promise<void> {
        await teardown();
      },
    };
  } catch (err) {
    log(`[topology] bring-up failed: ${(err as Error).message}; tearing down`);
    await teardown();
    throw err;
  }
}
