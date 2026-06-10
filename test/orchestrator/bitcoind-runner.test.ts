/**
 * Unit tests for the bitcoind runner — spawn argv, the `mine` → `generate`
 * RPC mapping, and readiness, all with injected seams (no real daemon).
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnBitcoind, type BitcoindRunnerHooks } from "../../src/orchestrator/bitcoind-runner.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 7;
  exitCode: number | null = null;
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    setImmediate(() => {
      this.exitCode = 0;
      this.emit("exit", 0, signal ?? null);
    });
    return true;
  }
}

function stubHooks(
  child: FakeChild,
  rpcCalls: { method: string; params: unknown[] }[],
): BitcoindRunnerHooks {
  return {
    spawnFn: ((bin: string, args: string[]) => {
      (child as unknown as { spawnArgs?: unknown }).spawnArgs = [bin, args];
      return child;
    }) as unknown as BitcoindRunnerHooks["spawnFn"],
    mkdirFn: () => undefined,
    rmFn: () => undefined,
    findFreePortsFn: async (count: number) => Array.from({ length: count }, (_, i) => 20000 + i),
    waitForPortFn: async () => undefined,
    rpcFn: async (_url, _auth, method, params) => {
      rpcCalls.push({ method, params });
      if (method === "getblockchaininfo") return { blocks: 0 };
      if (method === "generate") return (params[0] as number) > 0 ? ["hash1", "hash2"] : [];
      return null;
    },
  };
}

describe("orchestrator: spawnBitcoind", () => {
  it("spawns regtest with the deprecated-rpc flags and dynamic ports", async () => {
    const child = new FakeChild();
    const handle = await spawnBitcoind({}, stubHooks(child, []));
    const [, args] = (child as unknown as { spawnArgs: [string, string[]] }).spawnArgs;
    expect(args).to.include("-regtest");
    expect(args).to.include("-txindex");
    expect(args).to.include("-deprecatedrpc=signrawtransaction");
    expect(args).to.include("-deprecatedrpc=generate");
    // Allocation order: rpcPort first (20000), then p2pPort (20001).
    expect(args).to.include("-rpcport=20000");
    expect(args).to.include("-port=20001");
    expect(handle.peerAddress).to.equal("127.0.0.1:20001");
    await handle.stop();
  });

  it("ready() polls getblockchaininfo; mine() drives the generate RPC", async () => {
    const child = new FakeChild();
    const rpcCalls: { method: string; params: unknown[] }[] = [];
    const handle = await spawnBitcoind(
      { rpcPort: 21000, p2pPort: 21001 },
      stubHooks(child, rpcCalls),
    );
    await handle.ready();
    const hashes = await handle.mine(400);
    expect(rpcCalls.map((c) => c.method)).to.include("getblockchaininfo");
    const gen = rpcCalls.find((c) => c.method === "generate");
    expect(gen?.params).to.deep.equal([400]);
    expect(hashes).to.deep.equal(["hash1", "hash2"]);
    await handle.stop();
  });
});
