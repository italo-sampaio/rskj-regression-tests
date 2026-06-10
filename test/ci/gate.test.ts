/**
 * Unit tests for the CI verdict gate — one per hardening rule, plus the
 * disk-reading wrapper with injected seams (no real files).
 */

import { expect } from "chai";
import { evaluateGate, type GateInput } from "../../src/ci/gate.js";
import { parseGateArgs, runGate } from "../../src/ci/run-gate.js";
import type { UnifiedReport, UnifiedSuite } from "../../src/report/schema.js";

function suite(name: string, over: Partial<UnifiedSuite["verdict"]> = {}): UnifiedSuite {
  const verdict = {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    errored: 0,
    durationMs: 100,
    passed_overall: true,
    ...over,
  };
  return { name, kind: "hardhat", verdict, tests: [] };
}

function report(suites: UnifiedSuite[]): UnifiedReport {
  const overall = suites.reduce(
    (acc, s) => ({
      total: acc.total + s.verdict.total,
      passed: acc.passed + s.verdict.passed,
      failed: acc.failed + s.verdict.failed,
      skipped: acc.skipped + s.verdict.skipped,
      errored: acc.errored + s.verdict.errored,
      durationMs: acc.durationMs + s.verdict.durationMs,
      passed_overall: acc.passed_overall && s.verdict.passed_overall,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0, durationMs: 0, passed_overall: true },
  );
  return {
    schemaVersion: "1.0.0",
    metadata: { startedAt: "2026-06-10T00:00:00Z" },
    overall,
    suites,
  };
}

function baseInput(over: Partial<GateInput> = {}): GateInput {
  return {
    report: report([suite("hardhat-smoke"), suite("k6-eth_blockNumber"), suite("rit-2wp-smoke")]),
    reportPath: "/run/report.json",
    expectedSuites: ["hardhat-smoke", "k6-eth_blockNumber", "rit-2wp-smoke"],
    ...over,
  };
}

describe("ci: evaluateGate", () => {
  it("passes a clean run with all expected suites", () => {
    const result = evaluateGate(baseInput());
    expect(result.passed, JSON.stringify(result.failures)).to.equal(true);
    expect(result.summary).to.match(/GATE PASS/);
  });

  it("rule 1 — fails on a missing/unparseable report artifact", () => {
    const result = evaluateGate(baseInput({ report: null }));
    expect(result.passed).to.equal(false);
    expect(result.failures.map((f) => f.gate)).to.include("artifact");
  });

  it("rule 1 — fails on a report with zero suites", () => {
    const result = evaluateGate(baseInput({ report: report([]), expectedSuites: [] }));
    expect(result.failures.map((f) => f.gate)).to.include("artifact");
  });

  it("rule 3 — fails loss-lessly when an expected suite is absent (even if present ones pass)", () => {
    const result = evaluateGate(
      baseInput({
        report: report([suite("hardhat-smoke"), suite("k6-eth_blockNumber")]),
      }),
    );
    expect(result.passed).to.equal(false);
    const lossLess = result.failures.find((f) => f.gate === "loss-less");
    expect(lossLess?.detail).to.match(/rit-2wp-smoke/);
  });

  it("rule 2 — fails on errored tests via structured counts, not log-grep", () => {
    const result = evaluateGate(
      baseInput({
        report: report([
          suite("hardhat-smoke"),
          suite("k6-eth_blockNumber"),
          suite("rit-2wp-smoke", { errored: 1, total: 2, passed: 1, passed_overall: false }),
        ]),
      }),
    );
    expect(result.passed).to.equal(false);
    expect(result.failures.map((f) => f.gate)).to.include("structured-health");
  });

  it("rule 1 — fails on a non-zero process exit even when the suites pass", () => {
    const result = evaluateGate(baseInput({ processes: [{ name: "federate-2", exitCode: 139 }] }));
    expect(result.passed).to.equal(false);
    const ph = result.failures.find((f) => f.gate === "process-health");
    expect(ph?.detail).to.match(/federate-2.*139/);
  });

  it("skips processes with a null (uncaptured) exit code", () => {
    const result = evaluateGate(baseInput({ processes: [{ name: "miner", exitCode: null }] }));
    expect(result.passed).to.equal(true);
  });

  it("rule 1 — fails on a native crash marker in the logs even when suites pass", () => {
    const result = evaluateGate(
      baseInput({
        logScans: [{ file: "/run/miner/node.log", markersFound: ["SIGSEGV", "hs_err_pid"] }],
      }),
    );
    expect(result.passed).to.equal(false);
    const crash = result.failures.find((f) => f.gate === "native-crash");
    expect(crash?.detail).to.match(/SIGSEGV/);
  });

  it("reports every problem at once (no short-circuit)", () => {
    const result = evaluateGate(
      baseInput({
        report: report([suite("hardhat-smoke", { failed: 1, passed: 0, passed_overall: false })]),
        processes: [{ name: "x", exitCode: 1 }],
        logScans: [{ file: "a.log", markersFound: ["SIGABRT"] }],
      }),
    );
    const gates = new Set(result.failures.map((f) => f.gate));
    expect(gates.has("loss-less")).to.equal(true);
    expect(gates.has("structured-health")).to.equal(true);
    expect(gates.has("process-health")).to.equal(true);
    expect(gates.has("native-crash")).to.equal(true);
  });
});

describe("ci: runGate (disk wrapper, injected seams)", () => {
  const goodReport = report([suite("hardhat-smoke"), suite("rit-2wp-smoke")]);

  function seams(files: Record<string, string>, logFiles: string[] = []) {
    return {
      existsFn: (p: string) => p in files || logFiles.includes(p) || p === "/run",
      readFileFn: (p: string) => {
        if (p in files) return files[p]!;
        throw new Error(`ENOENT ${p}`);
      },
      listLogFilesFn: () => logFiles,
      writeFileFn: () => undefined,
      log: () => undefined,
    };
  }

  it("loads the report, scans logs, and passes a clean run", () => {
    const result = runGate(
      {
        reportPath: "/run/report.json",
        logsDir: "/run",
        expectedSuites: ["hardhat-smoke", "rit-2wp-smoke"],
      },
      seams({ "/run/report.json": JSON.stringify(goodReport) }),
    );
    expect(result.passed, JSON.stringify(result.failures)).to.equal(true);
  });

  it("detects a crash marker discovered by scanning a log file", () => {
    const result = runGate(
      {
        reportPath: "/run/report.json",
        logsDir: "/run",
        expectedSuites: ["hardhat-smoke", "rit-2wp-smoke"],
      },
      seams(
        {
          "/run/report.json": JSON.stringify(goodReport),
          "/run/fed.log": "boot ok\n# A fatal error has been detected by the Java Runtime\n",
        },
        ["/run/fed.log"],
      ),
    );
    expect(result.passed).to.equal(false);
    expect(result.failures.map((f) => f.gate)).to.include("native-crash");
  });

  it("treats empty report content as a missing artifact", () => {
    const result = runGate(
      { reportPath: "/run/report.json", expectedSuites: [] },
      seams({ "/run/report.json": "   " }),
    );
    expect(result.failures.map((f) => f.gate)).to.include("artifact");
  });

  it("parses CLI args including --expect and --driver-exit", () => {
    const args = parseGateArgs([
      "--report",
      "r.json",
      "--logs-dir",
      "logs",
      "--expect",
      "a,b,c",
      "--driver-exit",
      "1",
    ]);
    expect(args.reportPath).to.equal("r.json");
    expect(args.expectedSuites).to.deep.equal(["a", "b", "c"]);
    expect(args.processes).to.deep.equal([{ name: "driver", exitCode: 1 }]);
  });

  it("requires --report", () => {
    expect(() => parseGateArgs(["--expect", "a"])).to.throw(/--report/);
  });
});
