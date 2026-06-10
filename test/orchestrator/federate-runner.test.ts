/**
 * Unit tests for the federate JVM runner — the generated HOCON and the
 * spawn/teardown surface, all with injected seams (no real JVM, no disk).
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  renderFederateConfig,
  spawnFederate,
  type FederateRunnerHooks,
} from "../../src/orchestrator/federate-runner.js";
import { GENESIS_FEDERATION } from "../../src/orchestrator/federation/genesis-federation.js";

const MEMBER = GENESIS_FEDERATION[0]!;

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 4242;
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

describe("orchestrator: renderFederateConfig", () => {
  const conf = renderFederateConfig({
    member: MEMBER,
    keyFilePath: "/data/signer.key",
    bitcoinPeerAddress: "127.0.0.1:20000",
    dataDir: "/data",
  });

  it("pins the member's peer key, ports and bitcoin peer", () => {
    expect(conf).to.include(`privateKey = "${MEMBER.privateKey}"`);
    expect(conf).to.include(`port = ${MEMBER.p2pPort}`);
    expect(conf).to.include(`port = ${MEMBER.rpcPort}`);
    expect(conf).to.include(`bitcoinPeerAddresses = [ "127.0.0.1:20000" ]`);
  });

  it("points all three signer slots at the key file as keyFile type", () => {
    const keyFileRefs = conf.match(/path = "\/data\/signer\.key"/g) ?? [];
    expect(keyFileRefs.length, "BTC+RSK+MST").to.equal(3);
    expect(conf).to.include(`type = "keyFile"`);
  });

  it("wires peer.active to the other two federates", () => {
    expect(conf).to.include(`port = ${GENESIS_FEDERATION[1]!.p2pPort}`);
    expect(conf).to.include(GENESIS_FEDERATION[1]!.nodeId);
    expect(conf).to.include(GENESIS_FEDERATION[2]!.nodeId);
  });

  it("disables the autominer and keeps the miner server on (Model B)", () => {
    expect(conf).to.include("client.enabled = false");
    expect(conf).to.include("server.enabled = true");
  });

  it("activates every fork at height 1", () => {
    expect(conf).to.include("vetiver900 = 1");
    expect(conf).to.include("orchid = 1");
  });
});

describe("orchestrator: spawnFederate", () => {
  function stubHooks(child: FakeChild, calls: Record<string, unknown[]>): FederateRunnerHooks {
    return {
      spawnFn: ((bin: string, args: string[]) => {
        calls.spawn = [bin, args];
        return child;
      }) as unknown as FederateRunnerHooks["spawnFn"],
      mkdirFn: () => undefined,
      writeFileFn: (p: string, c: string) => {
        (calls.write ??= []).push(p, c);
      },
      chmodFn: (p: string, mode: number) => {
        (calls.chmod ??= []).push(p, mode);
      },
      rmFn: () => undefined,
      waitForPortFn: async () => undefined,
      waitForRpcReadyFn: async () => undefined,
      javaBin: "java-stub",
    };
  }

  it("writes the key file at mode 0400 and spawns FederateRunner via -cp", async () => {
    const child = new FakeChild();
    const calls: Record<string, unknown[]> = {};
    const handle = await spawnFederate(
      { jarPath: "/jars/federate.jar", member: MEMBER, bitcoinPeerAddress: "127.0.0.1:20000" },
      stubHooks(child, calls),
    );

    const [bin, args] = calls.spawn as [string, string[]];
    expect(bin).to.equal("java-stub");
    expect(args).to.include("-cp");
    expect(args).to.include("/jars/federate.jar");
    expect(args).to.include("co.rsk.federate.FederateRunner");
    expect(args).to.include("--regtest");
    // Key file chmod'd to 0400.
    const chmodModes = (calls.chmod ?? []).filter((v) => typeof v === "number");
    expect(chmodModes).to.include(0o400);
    expect(handle.id).to.equal(MEMBER.id);
    expect(handle.rpcPort).to.equal(MEMBER.rpcPort);
    await handle.stop();
  });

  it("teardown sends SIGTERM then resolves on exit", async () => {
    const child = new FakeChild();
    const handle = await spawnFederate(
      { jarPath: "/jars/federate.jar", member: MEMBER, bitcoinPeerAddress: "127.0.0.1:20000" },
      stubHooks(child, {}),
    );
    await handle.stop();
    expect(child.killed).to.include("SIGTERM");
  });
});
