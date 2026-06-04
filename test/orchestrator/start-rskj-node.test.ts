/**
 * Unit tests for the public {@link startRskjNode} entry. The lifecycle
 * tests live in `rskj-runner.test.ts`; here we cover the JAR-path
 * validation surface and the option-forwarding shim.
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { startRskjNode } from "../../src/orchestrator/start-rskj-node.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 99;
  exitCode: number | null = null;
  kill(): boolean {
    setImmediate(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    });
    return true;
  }
}

function stubHooks(): Parameters<typeof startRskjNode>[0]["hooks"] {
  return {
    spawnFn: (() => new FakeChild()) as unknown as typeof import("node:child_process").spawn,
    mkdirFn: () => undefined,
    mkdtempFn: (p: string) => `${p}stub`,
    writeFileFn: () => undefined,
    rmFn: () => undefined,
    findFreePortsFn: async (count: number) => Array.from({ length: count }, (_, i) => 40000 + i),
    waitForPortFn: async () => undefined,
    waitForRpcReadyFn: async () => undefined,
    javaBin: "java-stub",
  };
}

describe("orchestrator: startRskjNode", () => {
  it("rejects when jarPath is missing", async () => {
    let err: Error | null = null;
    try {
      // @ts-expect-error: intentionally missing jarPath for the test.
      await startRskjNode({});
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/jarPath is required/);
  });

  it("rejects when the jarPath does not exist", async () => {
    let err: Error | null = null;
    try {
      await startRskjNode({
        jarPath: "/this/does/not/exist.jar",
        jarExistsFn: () => false,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/jar not found/);
  });

  it("forwards options through to the spawner when validation passes", async () => {
    const handle = await startRskjNode({
      jarPath: "/abs/rskj-all.jar",
      jarExistsFn: () => true,
      hooks: stubHooks(),
    });
    expect(handle.rpcUrl).to.equal("http://127.0.0.1:40000");
    expect(handle.rpcPort).to.equal(40000);
    expect(handle.p2pPort).to.equal(40001);
    await handle.stop();
  });
});
