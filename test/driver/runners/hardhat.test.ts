/**
 * Tests for the hardhat suite runner. We inject a fake `spawn` that
 * returns a controllable child plus stubbed file-system reads so the
 * tests cover the success / missing-XML / parse-error paths without
 * needing hardhat (or even Node 22) installed.
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { runHardhat } from "../../../src/driver/runners/hardhat.js";
import type { HardhatRun } from "../../../src/driver/presets.js";

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
    // Drive completion asynchronously so the runner's promise waits
    // on the `close` event the way the real spawn does.
    setImmediate(() => {
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
  return { spawnFn, invocations };
}

const HARDHAT_RUN: HardhatRun = {
  kind: "hardhat",
  name: "hardhat-smoke",
  smoke: true,
};

const SAMPLE_RESULT_JSON = JSON.stringify({
  stats: {
    suites: 1,
    tests: 2,
    passes: 1,
    pending: 0,
    failures: 1,
    start: "2026-05-20T20:00:00.000Z",
    end: "2026-05-20T20:00:00.300Z",
    duration: 300,
  },
  tests: [
    { title: "ok", fullTitle: "C ok", file: "/repo/a.ts", duration: 100, state: "passed" },
    {
      title: "bad",
      fullTitle: "C bad",
      file: "/repo/b.ts",
      duration: 150,
      state: "failed",
      err: { message: "oops", name: "AssertionError", stack: "stack" },
    },
  ],
});

describe("driver/runners: runHardhat", () => {
  it("invokes hardhat test mocha with smoke grep and surfaces a unified suite", async () => {
    const { spawnFn, invocations } = makeSpawn(1); // hardhat exits 1 when a test fails
    const result = await runHardhat(HARDHAT_RUN, {
      hardhatTestsPath: "/fake/h",
      rpcUrl: "http://x",
      network: "rsk_regtest",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => true,
      readFileFn: () => SAMPLE_RESULT_JSON,
      log: () => {},
    });

    expect(invocations).to.have.length(1);
    expect(invocations[0]!.command).to.equal("npx");
    expect(invocations[0]!.args).to.deep.equal([
      "hardhat",
      "test",
      "mocha",
      "--grep",
      "\\[smoke\\]",
    ]);
    expect(invocations[0]!.env.HARDHAT_NETWORK).to.equal("rsk_regtest");
    expect(invocations[0]!.env.SMOKE).to.equal("true");

    expect(result.suite.kind).to.equal("hardhat");
    expect(result.suite.name).to.equal("hardhat-smoke");
    expect(result.suite.verdict.total).to.equal(2);
    expect(result.suite.verdict.failed).to.equal(1);
    expect(result.suite.verdict.passed_overall).to.equal(false);
  });

  it("emits a synthetic error suite when no result.json is produced", async () => {
    const { spawnFn } = makeSpawn(2);
    const result = await runHardhat(HARDHAT_RUN, {
      hardhatTestsPath: "/fake/h",
      rpcUrl: "http://x",
      network: "rsk_regtest",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => false,
      readFileFn: () => {
        throw new Error("should not be called");
      },
      log: () => {},
    });
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.status).to.equal("error");
    expect(result.suite.tests[0]!.failure?.type).to.equal("MissingReport");
  });

  it("emits a synthetic error suite when the adapter rejects the result.json", async () => {
    const { spawnFn } = makeSpawn(0);
    const result = await runHardhat(HARDHAT_RUN, {
      hardhatTestsPath: "/fake/h",
      rpcUrl: "http://x",
      network: "rsk_regtest",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      existsFn: () => true,
      readFileFn: () => '{"not-the-right-shape": true}',
      log: () => {},
    });
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.failure?.type).to.equal("AdapterError");
  });
});
