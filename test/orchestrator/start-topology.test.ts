/**
 * Unit tests for the full-topology orchestration — ordering, miner peer
 * wiring, the mining-RPC selection, and (critically) teardown-on-failure,
 * all with injected fake runners (no bitcoind, no JVMs).
 *
 * The real end-to-end proof is the smoke harness
 * (`spikes/full-topology/harness/smoke.ts`); these tests cover the control
 * flow that the smoke's happy path can't exercise — chiefly that a
 * mid-bring-up failure tears down everything already started.
 */

import { expect } from "chai";
import {
  startFullTopology,
  type FullTopologyHooks,
} from "../../src/orchestrator/start-topology.js";
import { GENESIS_FEDERATION } from "../../src/orchestrator/federation/genesis-federation.js";

interface Event {
  kind: string;
  id?: string;
}

function fakeBitcoind(events: Event[], stopped: string[]) {
  return {
    rpcUrl: "http://127.0.0.1:20001",
    rpcPort: 20001,
    p2pPort: 20000,
    rpcUser: "rsk",
    rpcPassword: "rsk",
    peerAddress: "127.0.0.1:20000",
    dataDir: "/tmp/btc",
    pid: 1,
    ready: async () => {
      events.push({ kind: "btc.ready" });
    },
    mine: async (n: number) => {
      events.push({ kind: "btc.mine", id: String(n) });
      return [];
    },
    rpc: async () => null,
    stop: async () => {
      stopped.push("bitcoind");
    },
  };
}

function buildHooks(
  events: Event[],
  stopped: string[],
  opts: { failFederate?: string } = {},
): FullTopologyHooks {
  return {
    spawnBitcoindFn: (async () =>
      fakeBitcoind(events, stopped)) as FullTopologyHooks["spawnBitcoindFn"],
    spawnFederateFn: (async (config: {
      member: { id: string; rpcPort: number; p2pPort: number };
    }) => {
      const id = config.member.id;
      events.push({ kind: "fed.spawn", id });
      return {
        id,
        rpcUrl: `http://127.0.0.1:${config.member.rpcPort}`,
        rpcPort: config.member.rpcPort,
        p2pPort: config.member.p2pPort,
        dataDir: `/tmp/${id}`,
        pid: 2,
        ready: async () => {
          if (opts.failFederate === id) {
            throw new Error(`federate ${id} failed to start`);
          }
          events.push({ kind: "fed.ready", id });
        },
        stop: async () => {
          stopped.push(id);
        },
      };
    }) as FullTopologyHooks["spawnFederateFn"],
    startRskjNodeFn: (async (cfg: {
      configOverrides?: Record<string, unknown>;
      rpcPort?: number;
    }) => {
      events.push({ kind: "miner.spawn" });
      (events as unknown as { minerOverrides?: unknown }).minerOverrides = cfg.configOverrides;
      (events as unknown as { minerRpcPort?: unknown }).minerRpcPort = cfg.rpcPort;
      return {
        rpcUrl: "http://127.0.0.1:30010",
        rpcPort: 30010,
        p2pPort: 30011,
        dataDir: "/tmp/miner",
        pid: 3,
        ready: async () => {
          events.push({ kind: "miner.ready" });
        },
        stop: async () => {
          stopped.push("miner");
        },
      };
    }) as FullTopologyHooks["startRskjNodeFn"],
    findFreePortsFn: async () => [30010, 30011],
  };
}

describe("orchestrator: startFullTopology", () => {
  it("starts bitcoind → mine → 3 federates → miner, in order", async () => {
    const events: Event[] = [];
    const stopped: string[] = [];
    const handle = await startFullTopology(
      { powpegJarPath: "/jars/fed.jar", rskjJarPath: "/jars/rskj.jar" },
      buildHooks(events, stopped),
    );
    const order = events.map((e) => e.kind);
    expect(order.indexOf("btc.ready")).to.be.lessThan(order.indexOf("btc.mine"));
    expect(order.indexOf("btc.mine")).to.be.lessThan(order.indexOf("fed.spawn"));
    expect(order.lastIndexOf("fed.ready")).to.be.lessThan(order.indexOf("miner.spawn"));
    expect(handle.federates).to.have.length(3);
    expect(handle.miner).to.not.equal(null);
    expect(handle.miningRpcUrl).to.equal("http://127.0.0.1:30010");
    await handle.stop();
  });

  it("wires the miner's peer.active to every federate and disables its autominer", async () => {
    const events: Event[] = [];
    const handle = await startFullTopology(
      { powpegJarPath: "/jars/fed.jar", rskjJarPath: "/jars/rskj.jar" },
      buildHooks(events, []),
    );
    const overrides = (events as unknown as { minerOverrides: Record<string, unknown> })
      .minerOverrides;
    expect(overrides["miner.client.enabled"]).to.equal(false);
    expect(overrides["miner.server.enabled"]).to.equal(true);
    const peerActive = overrides["peer.active"] as { port: number; nodeId: string }[];
    expect(peerActive).to.have.length(3);
    expect(peerActive.map((p) => p.port)).to.deep.equal(GENESIS_FEDERATION.map((m) => m.p2pPort));
    await handle.stop();
  });

  it("pins the miner's RPC port to minerRpcPort when set, else uses an allocated port", async () => {
    const pinned: Event[] = [];
    await startFullTopology(
      { powpegJarPath: "/jars/fed.jar", rskjJarPath: "/jars/rskj.jar", minerRpcPort: 4444 },
      buildHooks(pinned, []),
    );
    expect((pinned as unknown as { minerRpcPort: number }).minerRpcPort).to.equal(4444);

    const allocated: Event[] = [];
    await startFullTopology(
      { powpegJarPath: "/jars/fed.jar", rskjJarPath: "/jars/rskj.jar" },
      buildHooks(allocated, []),
    );
    // findFreePortsFn returns [30010, 30011] — the miner takes the first for RPC.
    expect((allocated as unknown as { minerRpcPort: number }).minerRpcPort).to.equal(30010);
  });

  it("omits the miner when no rskjJarPath is given (federation-only)", async () => {
    const events: Event[] = [];
    const handle = await startFullTopology(
      { powpegJarPath: "/jars/fed.jar" },
      buildHooks(events, []),
    );
    expect(handle.miner).to.equal(null);
    expect(events.some((e) => e.kind === "miner.spawn")).to.equal(false);
    // Falls back to fed-1's RPC as the mining endpoint.
    expect(handle.miningRpcUrl).to.equal(`http://127.0.0.1:${GENESIS_FEDERATION[0]!.rpcPort}`);
    await handle.stop();
  });

  it("tears down everything already started when a federate fails to boot", async () => {
    const events: Event[] = [];
    const stopped: string[] = [];
    let threw: Error | null = null;
    try {
      await startFullTopology(
        { powpegJarPath: "/jars/fed.jar", rskjJarPath: "/jars/rskj.jar" },
        buildHooks(events, stopped, { failFederate: "genesis-fed-2" }),
      );
    } catch (e) {
      threw = e as Error;
    }
    expect(threw, "should reject").to.not.equal(null);
    expect(threw!.message).to.match(/genesis-fed-2 failed/);
    // bitcoind + fed-1 + the failed fed-2 all got stopped; miner never started.
    expect(stopped).to.include("bitcoind");
    expect(stopped).to.include("genesis-fed-1");
    expect(stopped).to.include("genesis-fed-2");
    expect(stopped).to.not.include("miner");
  });
});
