import { expect } from "chai";
import {
  buildUnifiedReport,
  computeSuiteVerdict,
  type UnifiedSuite,
  type UnifiedTestCase,
} from "../../src/report/schema.js";
import { renderJUnitXml } from "../../src/report/junit.js";
import { adaptJUnitXml } from "../../src/adapters/junit-xml.js";

function makeReport() {
  const tests: UnifiedTestCase[] = [
    { name: "passes", classname: "Suite A", status: "passed", durationMs: 250 },
    {
      name: "fails",
      classname: "Suite A",
      status: "failed",
      durationMs: 100,
      failure: {
        message: "expected 1 to equal 2",
        type: "AssertionError",
        stack: "AssertionError: expected 1 to equal 2\n  at test.ts:10:5",
      },
    },
    { name: "skip", classname: "Suite A", status: "skipped", durationMs: 0 },
    {
      name: "explodes",
      classname: "Suite A",
      status: "error",
      durationMs: 0,
      failure: {
        message: "ENOENT: missing config",
        type: "Error",
        stack: "Error: ENOENT: missing config",
      },
    },
  ];
  const suite: UnifiedSuite = {
    name: "demo",
    kind: "other",
    verdict: computeSuiteVerdict(tests, 350),
    tests,
  };
  return buildUnifiedReport({ startedAt: "2026-05-20T12:00:00Z", runId: "demo-run-1" }, [suite]);
}

describe("junit: renderJUnitXml", () => {
  it("emits a well-formed testsuites document with per-status counts", () => {
    const report = makeReport();
    const xml = renderJUnitXml(report);
    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).to.equal(true);
    expect(xml).to.contain('<testsuites tests="4" failures="1" errors="1" skipped="1"');
    expect(xml).to.contain('<testsuite name="demo" tests="4" failures="1" errors="1" skipped="1"');
    expect(xml).to.contain('<testcase name="passes" time="0.250" classname="Suite A"/>');
    expect(xml).to.contain('<failure message="expected 1 to equal 2" type="AssertionError">');
    expect(xml).to.contain("<error ");
    expect(xml).to.contain("<skipped/>");
  });

  it("round-trips: render → adaptJUnitXml → counts match the source", () => {
    const report = makeReport();
    const xml = renderJUnitXml(report);
    const [roundTripped] = adaptJUnitXml(xml, { kind: "other", merge: true });
    expect(roundTripped).to.exist;
    expect(roundTripped!.verdict.total).to.equal(4);
    expect(roundTripped!.verdict.passed).to.equal(1);
    expect(roundTripped!.verdict.failed).to.equal(1);
    expect(roundTripped!.verdict.errored).to.equal(1);
    expect(roundTripped!.verdict.skipped).to.equal(1);
    // Timing is in seconds-with-3dp, so 100 ms → 100 ms after round-trip.
    const failed = roundTripped!.tests.find((t) => t.status === "failed");
    expect(failed?.failure?.message).to.equal("expected 1 to equal 2");
    expect(failed?.failure?.type).to.equal("AssertionError");
  });

  it("escapes XML-special characters in names and messages", () => {
    const tests: UnifiedTestCase[] = [
      {
        name: "handles <angle> & 'quotes' \"both\"",
        status: "failed",
        durationMs: 0,
        failure: {
          message: "got <a> & b, expected <c>",
          type: "AssertionError",
        },
      },
    ];
    const suite: UnifiedSuite = {
      name: "escape-suite",
      kind: "other",
      verdict: computeSuiteVerdict(tests, 0),
      tests,
    };
    const report = buildUnifiedReport({ startedAt: "2026-05-20T00:00:00Z" }, [suite]);
    const xml = renderJUnitXml(report);
    expect(xml).to.contain("&lt;angle&gt;");
    expect(xml).to.contain("&amp; &apos;quotes&apos;");
    expect(xml).to.contain("&quot;both&quot;");
    expect(xml).to.contain("got &lt;a&gt; &amp; b");
  });
});
