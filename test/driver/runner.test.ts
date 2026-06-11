/**
 * Unit tests for the driver orchestrator.
 *
 * Uses the {@link RunnerOverrides} seam to inject fake suite runners +
 * in-memory file writers, so these tests run without a node, hardhat, or
 * k6 binary anywhere on the host. The real aggregation logic
 * (`buildUnifiedReport`, the adapters) is covered by its own tests; here
 * we cover the driver's own behaviour: ordering, fail-fast, artifact
 * paths, and the verdict-to-exit-code mapping.
 */

import { expect } from "chai";
import { resolve } from "node:path";
import type { BuildSourceSpec, ResolvedBinaries } from "../../src/build/types.js";
import type { DriverConfig } from "../../src/driver/config.js";
import { exitCodeFor, runDriver } from "../../src/driver/runner.js";
import type {
  HardhatRunnerOptions,
  HardhatRunnerResult,
} from "../../src/driver/runners/hardhat.js";
import type { K6RunnerOptions, K6RunnerResult } from "../../src/driver/runners/k6.js";
import type { RitRunnerOptions, RitRunnerResult } from "../../src/driver/runners/rit.js";
import type { HardhatRun, K6Run, RitRun } from "../../src/driver/presets.js";
import { computeSuiteVerdict, type UnifiedSuite } from "../../src/report/schema.js";

function suiteFromOutcome(name: string, kind: "hardhat" | "k6", passed: boolean): UnifiedSuite {
  const tests = passed
    ? [{ name: `${name}: ok`, status: "passed" as const, durationMs: 10 }]
    : [
        {
          name: `${name}: boom`,
          status: "failed" as const,
          durationMs: 10,
          failure: { message: "boom" },
        },
      ];
  return {
    name,
    kind,
    verdict: computeSuiteVerdict(tests, 10),
    tests,
  };
}

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    preset: "smoke",
    rpcUrl: "http://node:4444",
    autoNode: false,
    hardhatNetwork: "rsk_regtest",
    hardhatTestsPath: "/fake/hardhat",
    k6TestsPath: "/fake/k6",
    ritTestsPath: "/fake/rit",
    outputDir: "/tmp/driver-test-out",
    runId: "test-run",
    failFast: false,
    ...overrides,
  };
}

interface CapturedArtifacts {
  files: Record<string, string>;
  dirs: string[];
}

function makeWriters(): {
  overrides: {
    mkdirFn: (p: string) => void;
    writeFileFn: (p: string, c: string) => void;
    log: (line: string) => void;
  };
  captured: CapturedArtifacts;
} {
  const captured: CapturedArtifacts = { files: {}, dirs: [] };
  return {
    overrides: {
      mkdirFn: (p: string) => captured.dirs.push(p),
      writeFileFn: (p: string, c: string) => {
        captured.files[p] = c;
      },
      log: () => {
        /* silent in tests */
      },
    },
    captured,
  };
}

describe("driver/runner: runDriver", () => {
  it("invokes both runners in preset order and writes the three artifacts", async () => {
    const calls: string[] = [];
    const fakeHardhat = async (
      run: HardhatRun,
      _opts: HardhatRunnerOptions,
    ): Promise<HardhatRunnerResult> => {
      calls.push(`hardhat:${run.name}`);
      return {
        suite: suiteFromOutcome(run.name, "hardhat", true),
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const fakeK6 = async (run: K6Run, _opts: K6RunnerOptions): Promise<K6RunnerResult> => {
      calls.push(`k6:${run.name}`);
      return { suite: suiteFromOutcome(run.name, "k6", true), exitCode: 0, stdout: "", stderr: "" };
    };
    const { overrides, captured } = makeWriters();

    const result = await runDriver(baseConfig(), {
      hardhat: fakeHardhat,
      k6: fakeK6,
      ...overrides,
    });

    expect(calls).to.deep.equal(["hardhat:hardhat-smoke", "k6:k6:eth_blockNumber"]);
    expect(captured.dirs).to.deep.equal(["/tmp/driver-test-out"]);

    expect(result.artifacts.json).to.equal(resolve("/tmp/driver-test-out/report.json"));
    expect(result.artifacts.xml).to.equal(resolve("/tmp/driver-test-out/report.xml"));
    expect(result.artifacts.markdown).to.equal(resolve("/tmp/driver-test-out/report.md"));
    expect(Object.keys(captured.files).sort()).to.deep.equal(
      [result.artifacts.json, result.artifacts.markdown, result.artifacts.xml].sort(),
    );

    expect(result.report.overall.passed_overall).to.equal(true);
    expect(result.report.suites).to.have.length(2);
    expect(result.report.metadata.runId).to.equal("test-run");
    expect(result.report.metadata.rpcUrl).to.equal("http://node:4444");
    expect(result.report.metadata.labels?.preset).to.equal("smoke");
    expect(result.report.metadata.labels?.failurePolicy).to.equal("run-all");
  });

  it("collects every suite by default even when one fails", async () => {
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => ({
      suite: suiteFromOutcome(run.name, "hardhat", false),
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const { overrides } = makeWriters();

    const result = await runDriver(baseConfig(), {
      hardhat: fakeHardhat,
      k6: fakeK6,
      ...overrides,
    });
    expect(result.report.suites).to.have.length(2);
    expect(result.report.overall.passed_overall).to.equal(false);
    expect(result.report.metadata.labels?.stoppedEarly).to.equal(undefined);
  });

  it("stops at the first failure when --fail-fast is set", async () => {
    const calls: string[] = [];
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => {
      calls.push(`hardhat:${run.name}`);
      return {
        suite: suiteFromOutcome(run.name, "hardhat", false),
        exitCode: 1,
        stdout: "",
        stderr: "",
      };
    };
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => {
      calls.push(`k6:${run.name}`);
      return { suite: suiteFromOutcome(run.name, "k6", true), exitCode: 0, stdout: "", stderr: "" };
    };
    const { overrides } = makeWriters();

    const result = await runDriver(baseConfig({ failFast: true }), {
      hardhat: fakeHardhat,
      k6: fakeK6,
      ...overrides,
    });

    expect(calls).to.deep.equal(["hardhat:hardhat-smoke"]);
    expect(result.report.suites).to.have.length(1);
    expect(result.report.overall.passed_overall).to.equal(false);
    expect(result.report.metadata.labels?.stoppedEarly).to.equal("true");
  });

  it("uses the configured network in report metadata", async () => {
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const { overrides } = makeWriters();

    const result = await runDriver(
      baseConfig({ hardhatNetwork: "rsk_betanet", rskjVersion: "vetiver-9.0.1" }),
      { hardhat: fakeHardhat, k6: fakeK6, ...overrides },
    );
    expect(result.report.metadata.network).to.equal("rsk_betanet");
    expect(result.report.metadata.rskjVersion).to.equal("vetiver-9.0.1");
  });

  it("--auto-node spins the orchestrator up, runs suites, and stops it", async () => {
    const events: string[] = [];
    const fakeHandle = {
      rpcUrl: "http://127.0.0.1:55555",
      rpcPort: 55555,
      p2pPort: 55556,
      dataDir: "/tmp/fake-data",
      pid: 1234,
      ready: async () => {
        events.push("ready");
      },
      stop: async () => {
        events.push("stop");
      },
    };
    const fakeStart = async (opts: { jarPath: string }): Promise<typeof fakeHandle> => {
      events.push(`start:${opts.jarPath}`);
      return fakeHandle;
    };
    const fakeHardhat = async (
      run: HardhatRun,
      opts: HardhatRunnerOptions,
    ): Promise<HardhatRunnerResult> => {
      events.push(`hardhat:${opts.rpcUrl}`);
      return {
        suite: suiteFromOutcome(run.name, "hardhat", true),
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const fakeK6 = async (run: K6Run, opts: K6RunnerOptions): Promise<K6RunnerResult> => {
      events.push(`k6:${opts.rpcUrl}`);
      return {
        suite: suiteFromOutcome(run.name, "k6", true),
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const { overrides } = makeWriters();

    const result = await runDriver(
      baseConfig({ autoNode: true, rskjJarPath: "/abs/rskj.jar", rpcUrl: "" }),
      {
        hardhat: fakeHardhat,
        k6: fakeK6,
        // Cast is needed because the fake handle has a fixed-number pid;
        // the real handle's pid is a getter that returns number | null.
        startNodeFn: fakeStart as unknown as Parameters<typeof runDriver>[1] extends infer R
          ? R extends { startNodeFn?: infer F }
            ? NonNullable<F>
            : never
          : never,
        ...overrides,
      },
    );

    expect(events).to.deep.equal([
      "start:/abs/rskj.jar",
      "ready",
      "hardhat:http://127.0.0.1:55555",
      "k6:http://127.0.0.1:55555",
      "stop",
    ]);
    expect(result.report.metadata.rpcUrl).to.equal("http://127.0.0.1:55555");
    expect(result.report.metadata.labels?.autoNode).to.equal("true");
  });

  it("--auto-node with a build spec resolves binaries BEFORE starting the node and labels provenance", async () => {
    const events: string[] = [];
    const fakeHandle = {
      rpcUrl: "http://127.0.0.1:55555",
      rpcPort: 55555,
      p2pPort: 55556,
      dataDir: "/tmp/fake-data",
      pid: 1234,
      ready: async () => {
        events.push("ready");
      },
      stop: async () => {
        events.push("stop");
      },
    };
    const fakeStart = async (opts: { jarPath: string }): Promise<typeof fakeHandle> => {
      events.push(`start:${opts.jarPath}`);
      return fakeHandle;
    };
    const resolved: ResolvedBinaries = {
      rskjJarPath: "/cache/releases/rskj/VETIVER-9.0.1/rskj-core-9.0.1-VETIVER-all.jar",
      powpegJarPath: "/cache/releases/powpeg/VETIVER-9.0.0.0/federate-node-VETIVER-9.0.0.0-all.jar",
      provenance: {
        rskj: {
          component: "rskj",
          mode: "release",
          path: "/cache/releases/rskj/VETIVER-9.0.1/rskj-core-9.0.1-VETIVER-all.jar",
          sha256: "aa".repeat(32),
          version: "9.0.1",
          releaseTag: "VETIVER-9.0.1",
          verification: "reproducible-builds",
          cacheHit: true,
        },
        powpeg: {
          component: "powpeg",
          mode: "release",
          path: "/cache/releases/powpeg/VETIVER-9.0.0.0/federate-node-VETIVER-9.0.0.0-all.jar",
          sha256: "bb".repeat(32),
          releaseTag: "VETIVER-9.0.0.0",
        },
      },
      warnings: ["stale reproducible-builds"],
    };
    const fakeResolve = async (spec: BuildSourceSpec): Promise<ResolvedBinaries> => {
      events.push(`resolve:${spec.mode}`);
      return resolved;
    };
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const { overrides } = makeWriters();

    const result = await runDriver(
      baseConfig({
        autoNode: true,
        rpcUrl: "",
        buildSpec: { mode: "release", rskjVersion: "9.0.1", powpegVersion: "9.0.0.0" },
      }),
      {
        hardhat: fakeHardhat,
        k6: fakeK6,
        resolveBinariesFn: fakeResolve,
        startNodeFn: fakeStart as unknown as Parameters<typeof runDriver>[1] extends infer R
          ? R extends { startNodeFn?: infer F }
            ? NonNullable<F>
            : never
          : never,
        ...overrides,
      },
    );

    // Resolution happens before the node starts, with the resolved jar.
    expect(events.slice(0, 3)).to.deep.equal([
      "resolve:release",
      "start:/cache/releases/rskj/VETIVER-9.0.1/rskj-core-9.0.1-VETIVER-all.jar",
      "ready",
    ]);

    // Provenance lands in the report labels; powpeg is recorded even
    // though the driver doesn't launch it yet.
    const labels = result.report.metadata.labels!;
    expect(labels.buildMode).to.equal("release");
    expect(labels.rskjSha256).to.equal("aa".repeat(32));
    expect(labels.rskjReleaseTag).to.equal("VETIVER-9.0.1");
    expect(labels.powpegSha256).to.equal("bb".repeat(32));
    expect(labels.powpegReleaseTag).to.equal("VETIVER-9.0.0.0");
    // The resolved version backfills metadata.rskjVersion when the
    // caller didn't pass --rskj-version.
    expect(result.report.metadata.rskjVersion).to.equal("9.0.1");
  });

  it("--auto-node fails fast when the build spec resolves no rskj jar", async () => {
    const fakeResolve = async (): Promise<ResolvedBinaries> => ({
      powpegJarPath: "/cache/builds/powpeg/abc/federate-node-all.jar",
      provenance: {},
      warnings: [],
    });
    const { overrides } = makeWriters();

    let err: Error | null = null;
    try {
      await runDriver(
        baseConfig({ autoNode: true, rpcUrl: "", buildSpec: { mode: "sha", powpegRef: "abc" } }),
        { resolveBinariesFn: fakeResolve, ...overrides },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err, "should have thrown").to.not.equal(null);
    expect(err!.message).to.match(/needs an rskj jar/);
  });

  it("--auto-node stops the orchestrator even when a suite throws", async () => {
    const events: string[] = [];
    const fakeHandle = {
      rpcUrl: "http://127.0.0.1:55555",
      rpcPort: 55555,
      p2pPort: 55556,
      dataDir: "/tmp/fake-data",
      pid: 1234,
      ready: async () => undefined,
      stop: async () => {
        events.push("stop");
      },
    };
    const fakeStart = async (): Promise<typeof fakeHandle> => fakeHandle;
    const fakeHardhat = async (): Promise<HardhatRunnerResult> => {
      throw new Error("kaboom");
    };
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const { overrides } = makeWriters();

    let err: Error | null = null;
    try {
      await runDriver(baseConfig({ autoNode: true, rskjJarPath: "/abs/rskj.jar", rpcUrl: "" }), {
        hardhat: fakeHardhat,
        k6: fakeK6,
        startNodeFn: fakeStart as unknown as Parameters<typeof runDriver>[1] extends infer R
          ? R extends { startNodeFn?: infer F }
            ? NonNullable<F>
            : never
          : never,
        ...overrides,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "runDriver should propagate the suite failure").to.not.equal(null);
    expect(events).to.deep.equal(["stop"]);
  });

  it("a requiresTopology preset + --auto-node brings up the full topology and points suites at the miner", async () => {
    const events: string[] = [];
    const fakeTopology = async (cfg: {
      powpegJarPath: string;
      rskjJarPath?: string;
      minerAutomine?: boolean;
    }) => {
      events.push(
        `topology:rskj=${cfg.rskjJarPath}:powpeg=${cfg.powpegJarPath}:automine=${cfg.minerAutomine}`,
      );
      return {
        bitcoind: {} as never,
        federates: [] as never,
        miner: null,
        miningRpcUrl: "http://127.0.0.1:30010",
        stop: async () => {
          events.push("topology-stop");
        },
      };
    };
    const fakeHardhat = async (
      run: HardhatRun,
      opts: HardhatRunnerOptions,
    ): Promise<HardhatRunnerResult> => {
      events.push(`hardhat:${opts.rpcUrl}`);
      return {
        suite: suiteFromOutcome(run.name, "hardhat", true),
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const fakeK6 = async (run: K6Run, opts: K6RunnerOptions): Promise<K6RunnerResult> => {
      events.push(`k6:${opts.rpcUrl}`);
      return { suite: suiteFromOutcome(run.name, "k6", true), exitCode: 0, stdout: "", stderr: "" };
    };
    const fakeRit = async (run: RitRun): Promise<RitRunnerResult> => ({
      suite: { name: run.name, kind: "rit", verdict: computeSuiteVerdict([], 0), tests: [] },
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const { overrides } = makeWriters();

    const result = await runDriver(
      baseConfig({
        preset: "full",
        autoNode: true,
        rskjJarPath: "/abs/rskj.jar",
        powpegJarPath: "/abs/powpeg.jar",
        rpcUrl: "",
      }),
      {
        hardhat: fakeHardhat,
        k6: fakeK6,
        rit: fakeRit,
        startTopologyFn: fakeTopology as unknown as Parameters<typeof runDriver>[1] extends infer R
          ? R extends { startTopologyFn?: infer F }
            ? NonNullable<F>
            : never
          : never,
        ...overrides,
      },
    );

    // The topology came up with automine on, hardhat+k6 hit the miner's RPC,
    // and the topology was torn down.
    expect(events).to.include("topology:rskj=/abs/rskj.jar:powpeg=/abs/powpeg.jar:automine=true");
    expect(events).to.include("hardhat:http://127.0.0.1:30010");
    expect(events).to.include("k6:http://127.0.0.1:30010");
    expect(events).to.include("topology-stop");
    expect(result.report.metadata.rpcUrl).to.equal("http://127.0.0.1:30010");
  });

  it("threads a build-resolved powpeg jar through to the RIT runner (sha mode, no --powpeg-jar)", async () => {
    const fakeResolve = async (): Promise<ResolvedBinaries> => ({
      rskjJarPath: "/cache/builds/rskj/abc/rskj-core-all.jar",
      powpegJarPath: "/cache/builds/powpeg/def__rskj-abc/federate-node-all.jar",
      provenance: {},
      warnings: [],
    });
    const fakeTopology = async () => ({
      bitcoind: {} as never,
      federates: [] as never,
      miner: null,
      miningRpcUrl: "http://127.0.0.1:30010",
      stop: async () => undefined,
    });
    const fakePassing = async (run: HardhatRun | K6Run) => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    let ritPowpegJar = "";
    const fakeRit = async (run: RitRun, opts: RitRunnerOptions): Promise<RitRunnerResult> => {
      ritPowpegJar = opts.powpegJarPath;
      return {
        suite: { name: run.name, kind: "rit", verdict: computeSuiteVerdict([], 0), tests: [] },
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const { overrides } = makeWriters();

    await runDriver(
      // No powpegJarPath in config — it must come from the resolved build.
      baseConfig({
        preset: "full",
        autoNode: true,
        rpcUrl: "",
        buildSpec: { mode: "sha", rskjRef: "abc", powpegRef: "def" },
      }),
      {
        resolveBinariesFn: fakeResolve,
        hardhat: fakePassing as never,
        k6: fakePassing as never,
        rit: fakeRit,
        startTopologyFn: fakeTopology as never,
        ...overrides,
      },
    );

    expect(ritPowpegJar).to.equal("/cache/builds/powpeg/def__rskj-abc/federate-node-all.jar");
  });

  it("tears down the full topology before the RIT suite runs", async () => {
    // RIT self-orchestrates its own federation on the same ports our topology
    // holds, so the driver must stop the topology before RIT — after the
    // node-facing suites (hardhat/k6) that DO need it have run.
    const order: string[] = [];
    const fakeTopology = async () => ({
      bitcoind: {} as never,
      federates: [] as never,
      miner: null,
      miningRpcUrl: "http://127.0.0.1:4444",
      stop: async () => {
        order.push("topology-stop");
      },
    });
    const fakePassing = async (run: HardhatRun | K6Run) => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeRit = async (run: RitRun): Promise<RitRunnerResult> => {
      order.push("rit-run");
      return {
        suite: { name: run.name, kind: "rit", verdict: computeSuiteVerdict([], 0), tests: [] },
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const { overrides } = makeWriters();

    await runDriver(
      baseConfig({
        preset: "full",
        autoNode: true,
        rskjJarPath: "/abs/rskj.jar",
        powpegJarPath: "/abs/powpeg.jar",
        rpcUrl: "",
      }),
      {
        hardhat: fakePassing as never,
        k6: fakePassing as never,
        rit: fakeRit,
        startTopologyFn: fakeTopology as never,
        ...overrides,
      },
    );

    // The topology is stopped exactly once, before RIT runs (not double-stopped
    // in the finally).
    expect(order).to.deep.equal(["topology-stop", "rit-run"]);
  });

  it("a requiresTopology preset + --auto-node without a powpeg jar fails fast", async () => {
    const { overrides } = makeWriters();
    let err: Error | null = null;
    try {
      await runDriver(
        baseConfig({ preset: "full", autoNode: true, rskjJarPath: "/abs/rskj.jar", rpcUrl: "" }),
        overrides,
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.not.equal(null);
    expect(err!.message).to.match(/requires a powpeg jar/);
  });
});

describe("driver/runner: RIT dispatch", () => {
  it("dispatches the rit kind to ctx.rit with resolved report path + powpeg jar", async () => {
    const ritCalls: Array<{ name: string; opts: RitRunnerOptions }> = [];
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeRit = async (run: RitRun, opts: RitRunnerOptions): Promise<RitRunnerResult> => {
      ritCalls.push({ name: run.name, opts });
      return {
        suite: {
          name: run.name,
          kind: "rit",
          verdict: computeSuiteVerdict([{ name: "ok", status: "passed", durationMs: 1 }], 1),
          tests: [{ name: "ok", status: "passed", durationMs: 1 }],
        },
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };
    const { overrides } = makeWriters();

    const result = await runDriver(
      baseConfig({ preset: "full", powpegJarPath: "/abs/powpeg.jar" }),
      { hardhat: fakeHardhat, k6: fakeK6, rit: fakeRit, ...overrides },
    );

    expect(ritCalls).to.have.length(1);
    expect(ritCalls[0]!.name).to.equal("rit-2wp-smoke");
    expect(ritCalls[0]!.opts.powpegJarPath).to.equal("/abs/powpeg.jar");
    expect(ritCalls[0]!.opts.ritTestsPath).to.equal("/fake/rit");
    // report path resolved against the output dir + the preset's relPath
    expect(ritCalls[0]!.opts.reportPath).to.equal(
      resolve("/tmp/driver-test-out/rit/rit-2wp-smoke.xml"),
    );

    // full = hardhat-smoke + k6 + rit-2wp-smoke
    expect(result.report.suites.map((s) => s.kind)).to.deep.equal(["hardhat", "k6", "rit"]);
    expect(result.report.overall.passed_overall).to.equal(true);
  });

  it("throws a clear error when a rit preset runs without a powpeg jar", async () => {
    const fakeHardhat = async (run: HardhatRun): Promise<HardhatRunnerResult> => ({
      suite: suiteFromOutcome(run.name, "hardhat", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeK6 = async (run: K6Run): Promise<K6RunnerResult> => ({
      suite: suiteFromOutcome(run.name, "k6", true),
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const fakeRit = async (): Promise<RitRunnerResult> => {
      throw new Error("should not be reached");
    };
    const { overrides } = makeWriters();

    let err: Error | null = null;
    try {
      await runDriver(baseConfig({ preset: "full" }), {
        hardhat: fakeHardhat,
        k6: fakeK6,
        rit: fakeRit,
        ...overrides,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, "runDriver should reject when powpegJarPath is missing").to.not.equal(null);
    expect(err!.message).to.match(/powpeg fat JAR/);
  });
});

describe("driver/runner: exitCodeFor", () => {
  it("returns 0 when the report passes", () => {
    const passingReport = {
      schemaVersion: "1.0.0",
      metadata: { startedAt: "x" },
      overall: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        errored: 0,
        durationMs: 0,
        passed_overall: true,
      },
      suites: [],
    };
    expect(
      exitCodeFor({ report: passingReport, artifacts: { json: "", xml: "", markdown: "" } }),
    ).to.equal(0);
  });

  it("returns 1 when the report fails", () => {
    const failingReport = {
      schemaVersion: "1.0.0",
      metadata: { startedAt: "x" },
      overall: {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        errored: 0,
        durationMs: 1,
        passed_overall: false,
      },
      suites: [],
    };
    expect(
      exitCodeFor({ report: failingReport, artifacts: { json: "", xml: "", markdown: "" } }),
    ).to.equal(1);
  });
});
