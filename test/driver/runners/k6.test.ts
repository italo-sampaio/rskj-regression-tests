import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { runK6 } from "../../../src/driver/runners/k6.js";
import type { K6Run } from "../../../src/driver/presets.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
}

function makeSpawn(exitCode = 0): {
  spawnFn: (...args: unknown[]) => FakeChild;
  invocations: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
} {
  const invocations: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnFn = (command: unknown, args: unknown, options: unknown): FakeChild => {
    const child = new FakeChild();
    invocations.push({
      command: command as string,
      args: args as string[],
      env: (options as { env: NodeJS.ProcessEnv }).env,
    });
    setImmediate(() => {
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
  return { spawnFn, invocations };
}

const K6_RUN: K6Run = {
  kind: "k6",
  name: "k6:eth_blockNumber",
  scriptRelPath: "tests/eth-blockNumber.js",
  summaryRelPath: "results/eth_blockNumber.json",
};

const SAMPLE_SUMMARY = JSON.stringify({
  meta: {
    module: "eth",
    method: "eth_blockNumber",
    timestamp: "2026-05-20T00:00:00Z",
    duration_ms: 30_000,
    vus_max: 1,
    iterations: 60,
  },
  thresholds: {
    eth_blockNumber_response_time: { passed: true, thresholds: ["p(95)<300"] },
  },
  metrics: { checks: { total: 180, passed: 180, failed: 0, success_rate: 1 } },
  passed: true,
});

describe("driver/runners: runK6", () => {
  it("spawns k6 run with the script path and surfaces a unified suite", async () => {
    const { spawnFn, invocations } = makeSpawn(0);
    const result = await runK6(K6_RUN, {
      k6TestsPath: "/fake/k6",
      rpcUrl: "http://node:4444",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => true,
      readFileFn: () => SAMPLE_SUMMARY,
      log: () => {},
    });

    expect(invocations).to.have.length(1);
    expect(invocations[0]!.command).to.equal("k6");
    expect(invocations[0]!.args[0]).to.equal("run");
    expect(invocations[0]!.args[invocations[0]!.args.length - 1]).to.include(
      "tests/eth-blockNumber.js",
    );
    expect(invocations[0]!.env.RPC_URL).to.equal("http://node:4444");

    expect(result.suite.kind).to.equal("k6");
    expect(result.suite.name).to.equal("k6:eth_blockNumber");
    expect(result.suite.verdict.passed_overall).to.equal(true);
  });

  it("forwards --vus / --duration when the preset entry supplies them", async () => {
    const { spawnFn, invocations } = makeSpawn(0);
    await runK6(
      { ...K6_RUN, vus: 3, duration: "10s" },
      {
        k6TestsPath: "/fake/k6",
        rpcUrl: "http://node:4444",
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        existsFn: () => true,
        readFileFn: () => SAMPLE_SUMMARY,
        log: () => {},
      },
    );
    const args = invocations[0]!.args;
    expect(args).to.include("--vus");
    expect(args[args.indexOf("--vus") + 1]).to.equal("3");
    expect(args).to.include("--duration");
    expect(args[args.indexOf("--duration") + 1]).to.equal("10s");
  });

  it("synthesises an error suite when the summary JSON never appears", async () => {
    const { spawnFn } = makeSpawn(99);
    const result = await runK6(K6_RUN, {
      k6TestsPath: "/fake/k6",
      rpcUrl: "http://x",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => false,
      readFileFn: () => {
        throw new Error("nope");
      },
      log: () => {},
    });
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.failure?.type).to.equal("MissingSummary");
  });

  it("synthesises an error suite when the adapter rejects the summary JSON", async () => {
    const { spawnFn } = makeSpawn(0);
    const result = await runK6(K6_RUN, {
      k6TestsPath: "/fake/k6",
      rpcUrl: "http://x",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => true,
      readFileFn: () => "{}",
      log: () => {},
    });
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.failure?.type).to.equal("AdapterError");
  });
});
