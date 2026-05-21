/**
 * Unit tests for the JVM-spawning runner. All filesystem / process /
 * network seams are stubbed so the tests cover the lifecycle wiring
 * without launching a real JVM.
 *
 * What we lock in here:
 *
 *   - The HOCON config file gets written under the resolved dataDir.
 *   - `java` is invoked with `-Drsk.conf.file=<configPath> -jar <jarPath> --regtest`
 *     so consumers can grep for the canonical command shape.
 *   - `handle.ready()` waits on both the port-bind and the JSON-RPC
 *     probe (in that order).
 *   - `handle.stop()` is idempotent and removes the data dir unless
 *     `keepDataDir` was set or the caller supplied an explicit dataDir.
 *   - `dataDir`-supplied paths are *not* removed on stop (consumer owns
 *     the lifecycle).
 *   - The `pid` getter returns `null` after the child exits.
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnRskjNode } from "../../src/orchestrator/rskj-runner.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 12345;
  exitCode: number | null = null;
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = (signal as NodeJS.Signals) ?? "SIGTERM";
    // Mimic real spawn: when the parent kills the child it eventually exits.
    setImmediate(() => {
      this.exitCode = 0;
      this.emit("exit", 0, signal ?? null);
    });
    return true;
  }
}

interface Captured {
  spawnCalls: Array<{ command: string; args: string[]; options: unknown }>;
  writes: Record<string, string>;
  mkdirs: string[];
  removes: string[];
  fakeChild: FakeChild;
}

function setupHooks(): {
  hooks: Parameters<typeof spawnRskjNode>[1];
  captured: Captured;
} {
  const captured: Captured = {
    spawnCalls: [],
    writes: {},
    mkdirs: [],
    removes: [],
    fakeChild: new FakeChild(),
  };
  const hooks: Parameters<typeof spawnRskjNode>[1] = {
    spawnFn: ((command: unknown, args: unknown, options: unknown) => {
      captured.spawnCalls.push({
        command: command as string,
        args: args as string[],
        options,
      });
      return captured.fakeChild;
    }) as unknown as typeof import("node:child_process").spawn,
    mkdirFn: (p: string) => {
      captured.mkdirs.push(p);
    },
    mkdtempFn: (prefix: string) => `${prefix}stub`,
    writeFileFn: (p: string, c: string) => {
      captured.writes[p] = c;
    },
    rmFn: (p: string) => {
      captured.removes.push(p);
    },
    findFreePortsFn: async (count: number) => {
      // Deterministic port allocation: 30001, 30002, ...
      return Array.from({ length: count }, (_, i) => 30001 + i);
    },
    waitForPortFn: async () => undefined,
    waitForRpcReadyFn: async () => undefined,
    javaBin: "java-stub",
  };
  return { hooks, captured };
}

describe("orchestrator/rskj-runner: spawnRskjNode", () => {
  it("writes a HOCON config under the data dir and spawns java with the right args", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode(
      {
        jarPath: "/abs/rskj-all.jar",
        log: () => undefined,
      },
      hooks,
    );

    // Data dir was picked from mkdtemp, ports from the stub allocator.
    expect(handle.dataDir).to.match(/rskj-regression-stub$/);
    expect(handle.rpcPort).to.equal(30001);
    expect(handle.p2pPort).to.equal(30002);
    expect(handle.rpcUrl).to.equal("http://127.0.0.1:30001");

    // HOCON config landed under the data dir.
    const configPath = `${handle.dataDir}/rskj.conf`;
    expect(captured.writes[configPath], "config should be written").to.be.a("string");
    expect(captured.writes[configPath]).to.include("database.dir = ");
    expect(captured.writes[configPath]).to.include(`rpc.providers.web.http.port = 30001`);
    expect(captured.writes[configPath]).to.include(`peer.port = 30002`);

    // Spawn shape: java <JVM args> -Drsk.conf.file=<config> -cp <jar> co.rsk.Start --regtest
    expect(captured.spawnCalls).to.have.length(1);
    const call = captured.spawnCalls[0]!;
    expect(call.command).to.equal("java-stub");
    expect(call.args).to.deep.equal([
      `-Drsk.conf.file=${configPath}`,
      "-cp",
      "/abs/rskj-all.jar",
      "co.rsk.Start",
      "--regtest",
    ]);
    expect((call.options as { cwd: string }).cwd).to.equal(handle.dataDir);

    // Cleanup so the test process doesn't leak handlers.
    await handle.stop();
  });

  it("uses the caller-supplied dataDir and does NOT remove it on stop", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode(
      { jarPath: "/abs/rskj-all.jar", dataDir: "/owned/by/caller" },
      hooks,
    );
    expect(handle.dataDir).to.equal("/owned/by/caller");
    expect(captured.mkdirs).to.include("/owned/by/caller");
    await handle.stop();
    expect(captured.removes).to.deep.equal([]);
  });

  it("removes the auto-generated data dir on stop by default", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode({ jarPath: "/abs/rskj-all.jar" }, hooks);
    await handle.stop();
    expect(captured.removes).to.deep.equal([handle.dataDir]);
  });

  it("keeps the auto-generated data dir when keepDataDir is set", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode({ jarPath: "/abs/rskj-all.jar", keepDataDir: true }, hooks);
    await handle.stop();
    expect(captured.removes).to.deep.equal([]);
  });

  it("respects explicit ports without calling the allocator", async () => {
    const { hooks, captured } = setupHooks();
    let allocatorCalls = 0;
    hooks!.findFreePortsFn = async (count: number) => {
      allocatorCalls++;
      return Array.from({ length: count }, (_, i) => 99000 + i);
    };
    const handle = await spawnRskjNode(
      { jarPath: "/abs/rskj-all.jar", rpcPort: 4444, p2pPort: 5555 },
      hooks,
    );
    expect(allocatorCalls).to.equal(0);
    expect(handle.rpcPort).to.equal(4444);
    expect(handle.p2pPort).to.equal(5555);
    expect(captured.writes[`${handle.dataDir}/rskj.conf`]).to.include("peer.port = 5555");
    expect(captured.writes[`${handle.dataDir}/rskj.conf`]).to.include(
      "rpc.providers.web.http.port = 4444",
    );
    await handle.stop();
  });

  it("calls the port-bind wait then the JSON-RPC probe in handle.ready()", async () => {
    const { hooks } = setupHooks();
    const events: string[] = [];
    hooks!.waitForPortFn = async () => {
      events.push("port");
    };
    hooks!.waitForRpcReadyFn = async () => {
      events.push("rpc");
    };
    const handle = await spawnRskjNode({ jarPath: "/abs/rskj-all.jar" }, hooks);
    await handle.ready();
    expect(events).to.deep.equal(["port", "rpc"]);
    // Second call should be a no-op (idempotent).
    await handle.ready();
    expect(events).to.deep.equal(["port", "rpc"]);
    await handle.stop();
  });

  it("stop() is idempotent", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode({ jarPath: "/abs/rskj-all.jar" }, hooks);
    await handle.stop();
    await handle.stop();
    expect(captured.removes.length).to.equal(1);
  });

  it("pid returns null once the child exits", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode({ jarPath: "/abs/rskj-all.jar" }, hooks);
    expect(handle.pid).to.equal(12345);
    captured.fakeChild.exitCode = 0;
    captured.fakeChild.emit("exit", 0, null);
    expect(handle.pid).to.equal(null);
    await handle.stop();
  });

  it("merges configOverrides on top of the baseline", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode(
      {
        jarPath: "/abs/rskj-all.jar",
        configOverrides: { targetgaslimit: 12_500_000, "miner.client.enabled": false },
      },
      hooks,
    );
    const conf = captured.writes[`${handle.dataDir}/rskj.conf`]!;
    expect(conf).to.include("targetgaslimit = 12500000");
    expect(conf).to.include("miner.client.enabled = false");
    await handle.stop();
  });

  it("forwards jvmArgs to the spawn command", async () => {
    const { hooks, captured } = setupHooks();
    const handle = await spawnRskjNode(
      {
        jarPath: "/abs/rskj-all.jar",
        jvmArgs: ["-Xmx2g", "-XX:+UseG1GC"],
      },
      hooks,
    );
    const args = captured.spawnCalls[0]!.args;
    expect(args.slice(0, 2)).to.deep.equal(["-Xmx2g", "-XX:+UseG1GC"]);
    await handle.stop();
  });
});
