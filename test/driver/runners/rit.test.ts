/**
 * Unit tests for the RIT (rootstock-integration-tests) suite runner.
 *
 * These tests are strictly JVM-free and disk-free: the child process is a
 * `FakeChild` EventEmitter (matching the k6 / hardhat runner test style),
 * the JUnit XML is injected via `readFileFn`, and `existsFn` / `mkdirFn` are
 * stubbed. No bitcoind, no powpeg JVM, no real mocha run. The real RIT boot
 * is exercised only by the live verification step, never in CI.
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { runRit } from "../../../src/driver/runners/rit.js";
import type { RitRun } from "../../../src/driver/presets.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
}

function makeSpawn(exitCode = 0): {
  spawnFn: (...args: unknown[]) => FakeChild;
  invocations: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
} {
  const invocations: Array<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const spawnFn = (command: unknown, args: unknown, options: unknown): FakeChild => {
    const child = new FakeChild();
    const opts = options as { cwd: string; env: NodeJS.ProcessEnv };
    invocations.push({
      command: command as string,
      args: args as string[],
      cwd: opts.cwd,
      env: opts.env,
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

const RIT_RUN: RitRun = {
  kind: "rit",
  name: "rit-2wp-smoke",
  description: "federation sync + bridge calls",
  includeCases: ["00_00_01-sync", "01_01_02-calls-to-bridge-methods"],
  reportRelPath: "rit/rit-2wp-smoke.xml",
};

// Two <testsuite> elements (RIT emits one per spec file) — the runner merges
// them into a single logical suite.
const SAMPLE_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="3" failures="0" time="120.5">
  <testsuite name="Sync" tests="2" failures="0" time="80.0">
    <testcase classname="Sync" name="boots the federation" time="40.0"/>
    <testcase classname="Sync" name="syncs all federates" time="40.0"/>
  </testsuite>
  <testsuite name="Bridge calls" tests="1" failures="0" time="40.5">
    <testcase classname="Bridge calls" name="calls getFederationAddress" time="40.5"/>
  </testsuite>
</testsuites>`;

const FAILING_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="2" failures="1" time="10.0">
  <testsuite name="Bridge calls" tests="2" failures="1" time="10.0">
    <testcase classname="Bridge calls" name="ok" time="5.0"/>
    <testcase classname="Bridge calls" name="broken" time="5.0">
      <failure message="expected 1 to equal 2" type="AssertionError">stack</failure>
    </testcase>
  </testsuite>
</testsuites>`;

function baseOptions(
  overrides: Partial<Parameters<typeof runRit>[1]> = {},
): Parameters<typeof runRit>[1] {
  return {
    ritTestsPath: "/fake/rit",
    powpegJarPath: "/fake/powpeg.jar",
    reportPath: "/out/rit/rit-2wp-smoke.xml",
    spawnFn: undefined,
    existsFn: () => true,
    readFileFn: () => SAMPLE_JUNIT,
    mkdirFn: () => {},
    log: () => {},
    ...overrides,
  };
}

describe("driver/runners: runRit", () => {
  it("spawns mocha on its default spec with the RIT env contract", async () => {
    const { spawnFn, invocations } = makeSpawn(0);
    await runRit(
      RIT_RUN,
      baseOptions({ spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn }),
    );

    expect(invocations).to.have.length(1);
    const inv = invocations[0]!;
    expect(inv.command).to.equal("npx");
    expect(inv.args[0]).to.equal("mocha");
    // CRITICAL: no explicit spec file path on the CLI — that would bypass
    // test.js's cluster-bootstrap before-hook.
    expect(inv.args).to.not.include.members(["tests/00_00_01-sync.js"]);
    expect(inv.args).to.include("--reporter");
    expect(inv.args[inv.args.indexOf("--reporter") + 1]).to.equal("mocha-junit-reporter");
    expect(inv.args).to.include("--timeout");

    expect(inv.cwd).to.equal("/fake/rit");
    expect(inv.env.POWPEG_NODE_JAR_PATH).to.equal("/fake/powpeg.jar");
    expect(inv.env.BITCOIND_BIN_PATH).to.equal("/home/italo/workspace/bitcoin-0.18.1/bin/bitcoind");
    expect(inv.env.CONFIG_FILE_PATH).to.equal("./config/regtest-all-keyfiles");
    expect(inv.env.EXEC_ENV).to.equal("Ubuntu");
    expect(inv.env.MOCHA_FILE).to.equal("/out/rit/rit-2wp-smoke.xml");
    expect(inv.env.INCLUDE_CASES).to.equal("00_00_01-sync,01_01_02-calls-to-bridge-methods");
    expect(inv.env.BITCOIN_DATA_DIR).to.equal(resolve("/fake/rit", "bitcoin-data"));
  });

  it("merges per-file testsuites into one rit suite and reports passes", async () => {
    const { spawnFn } = makeSpawn(0);
    const result = await runRit(
      RIT_RUN,
      baseOptions({ spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn }),
    );
    expect(result.suite.kind).to.equal("rit");
    expect(result.suite.name).to.equal("rit-2wp-smoke");
    expect(result.suite.verdict.total).to.equal(3);
    expect(result.suite.verdict.passed).to.equal(3);
    expect(result.suite.verdict.passed_overall).to.equal(true);
    expect(result.suite.extras?.powpegJarPath).to.equal("/fake/powpeg.jar");
  });

  it("surfaces assertion failures as a failed (not errored) suite", async () => {
    const { spawnFn } = makeSpawn(1);
    const result = await runRit(
      RIT_RUN,
      baseOptions({
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        readFileFn: () => FAILING_JUNIT,
      }),
    );
    expect(result.suite.verdict.failed).to.equal(1);
    expect(result.suite.verdict.errored).to.equal(0);
    expect(result.suite.verdict.passed_overall).to.equal(false);
  });

  it("creates the bitcoin-data dir and the report dir before spawning", async () => {
    const { spawnFn } = makeSpawn(0);
    const mkdirCalls: string[] = [];
    await runRit(
      RIT_RUN,
      baseOptions({
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        mkdirFn: (p: string) => mkdirCalls.push(p),
      }),
    );
    expect(mkdirCalls).to.include(resolve("/fake/rit", "bitcoin-data"));
    expect(mkdirCalls).to.include("/out/rit");
  });

  it("synthesises a MissingReport error suite when no JUnit XML appears", async () => {
    // The catastrophic case: bitcoind / a federate JVM failed to boot, so the
    // mocha before-hook threw and MOCHA_FILE was never written.
    const { spawnFn } = makeSpawn(7);
    const result = await runRit(
      RIT_RUN,
      baseOptions({
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        existsFn: () => false,
        readFileFn: () => {
          throw new Error("nope");
        },
      }),
    );
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.failure?.type).to.equal("MissingReport");
    expect(result.suite.kind).to.equal("rit");
  });

  it("synthesises an AdapterError suite when the XML is unparseable", async () => {
    const { spawnFn } = makeSpawn(0);
    const result = await runRit(
      RIT_RUN,
      baseOptions({
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        readFileFn: () => "<not-junit/>",
      }),
    );
    expect(result.suite.verdict.errored).to.equal(1);
    expect(result.suite.tests[0]!.failure?.type).to.equal("AdapterError");
  });

  it("omits INCLUDE_CASES when the run has no subset (full suite)", async () => {
    const { spawnFn, invocations } = makeSpawn(0);
    await runRit(
      { kind: "rit", name: "rit-full", reportRelPath: "rit/full.xml" },
      baseOptions({ spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn }),
    );
    expect(invocations[0]!.env.INCLUDE_CASES).to.equal(undefined);
  });
});
