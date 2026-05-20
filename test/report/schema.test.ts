import { expect } from "chai";
import {
  UNIFIED_REPORT_SCHEMA_VERSION,
  buildUnifiedReport,
  computeOverallVerdict,
  computeSuiteVerdict,
  type UnifiedTestCase,
  type UnifiedSuite,
} from "../../src/report/schema.js";

function passingTest(name: string, durationMs = 10): UnifiedTestCase {
  return { name, status: "passed", durationMs };
}
function failingTest(name: string, durationMs = 10): UnifiedTestCase {
  return {
    name,
    status: "failed",
    durationMs,
    failure: { message: `boom: ${name}`, type: "AssertionError" },
  };
}
function skippedTest(name: string): UnifiedTestCase {
  return { name, status: "skipped", durationMs: 0 };
}
function erroredTest(name: string): UnifiedTestCase {
  return {
    name,
    status: "error",
    durationMs: 0,
    failure: { message: "process died", type: "RuntimeError" },
  };
}

describe("schema: computeSuiteVerdict", () => {
  it("counts every status and reports passed_overall=true when nothing failed", () => {
    const verdict = computeSuiteVerdict(
      [passingTest("a"), passingTest("b"), skippedTest("c")],
      123,
    );
    expect(verdict).to.deep.equal({
      total: 3,
      passed: 2,
      failed: 0,
      skipped: 1,
      errored: 0,
      durationMs: 123,
      passed_overall: true,
    });
  });

  it("marks the suite failed when any test failed", () => {
    const verdict = computeSuiteVerdict([passingTest("a"), failingTest("b")], 100);
    expect(verdict.passed_overall).to.equal(false);
    expect(verdict.failed).to.equal(1);
  });

  it("marks the suite failed when any test errored even with no failures", () => {
    const verdict = computeSuiteVerdict([passingTest("a"), erroredTest("b")], 0);
    expect(verdict.passed_overall).to.equal(false);
    expect(verdict.errored).to.equal(1);
  });

  it("returns a zero-counts verdict for an empty suite (and still passes)", () => {
    const verdict = computeSuiteVerdict([], 0);
    expect(verdict).to.deep.equal({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
      durationMs: 0,
      passed_overall: true,
    });
  });
});

describe("schema: computeOverallVerdict", () => {
  function suite(name: string, tests: UnifiedTestCase[], durationMs: number): UnifiedSuite {
    return {
      name,
      kind: "other",
      verdict: computeSuiteVerdict(tests, durationMs),
      tests,
    };
  }

  it("sums per-suite counts and ANDs the pass flags", () => {
    const overall = computeOverallVerdict([
      suite("s1", [passingTest("a"), passingTest("b")], 50),
      suite("s2", [skippedTest("c"), passingTest("d")], 30),
    ]);
    expect(overall).to.deep.equal({
      total: 4,
      passed: 3,
      failed: 0,
      skipped: 1,
      errored: 0,
      durationMs: 80,
      passed_overall: true,
    });
  });

  it("fails overall when any suite failed", () => {
    const overall = computeOverallVerdict([
      suite("s1", [passingTest("a")], 50),
      suite("s2", [failingTest("b")], 30),
    ]);
    expect(overall.passed_overall).to.equal(false);
    expect(overall.failed).to.equal(1);
  });
});

describe("schema: buildUnifiedReport", () => {
  it("stamps the schema version and recomputes overall from suites", () => {
    const tests = [passingTest("a"), failingTest("b")];
    const suite: UnifiedSuite = {
      name: "demo",
      kind: "other",
      verdict: computeSuiteVerdict(tests, 100),
      tests,
    };
    const report = buildUnifiedReport({ startedAt: "2026-05-20T00:00:00Z", rskjVersion: "test" }, [
      suite,
    ]);
    expect(report.schemaVersion).to.equal(UNIFIED_REPORT_SCHEMA_VERSION);
    expect(report.overall.passed_overall).to.equal(false);
    expect(report.overall.failed).to.equal(1);
    expect(report.suites).to.have.length(1);
  });
});
