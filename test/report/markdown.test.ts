import { expect } from "chai";
import {
  buildUnifiedReport,
  computeSuiteVerdict,
  type UnifiedSuite,
  type UnifiedTestCase,
} from "../../src/report/schema.js";
import { renderMarkdown } from "../../src/report/markdown.js";

describe("markdown: renderMarkdown", () => {
  it("shows a PASSED badge and no failures section when everything passes", () => {
    const tests: UnifiedTestCase[] = [{ name: "ok", status: "passed", durationMs: 100 }];
    const suite: UnifiedSuite = {
      name: "demo",
      kind: "other",
      verdict: computeSuiteVerdict(tests, 100),
      tests,
    };
    const report = buildUnifiedReport(
      { startedAt: "2026-05-20T00:00:00Z", rskjVersion: "v1.2.3" },
      [suite],
    );
    const md = renderMarkdown(report);
    expect(md).to.contain("PASSED");
    expect(md).to.not.contain("FAILED");
    expect(md).to.contain("v1.2.3");
    expect(md).to.contain("| demo |");
    expect(md).to.not.contain("## Failures");
  });

  it("shows a FAILED badge plus per-failure block when something fails", () => {
    const tests: UnifiedTestCase[] = [
      { name: "passes", classname: "S", status: "passed", durationMs: 10 },
      {
        name: "boom",
        classname: "S",
        status: "failed",
        durationMs: 20,
        failure: {
          message: "expected 1 to equal 2",
          type: "AssertionError",
          stack: "AssertionError: ...\n  at file.ts:10",
        },
        file: "test/file.ts",
      },
    ];
    const suite: UnifiedSuite = {
      name: "s",
      kind: "hardhat",
      verdict: computeSuiteVerdict(tests, 30),
      tests,
    };
    const report = buildUnifiedReport({ startedAt: "2026-05-20T00:00:00Z" }, [suite]);
    const md = renderMarkdown(report);
    expect(md).to.contain("FAILED");
    expect(md).to.contain("## Failures");
    expect(md).to.contain("FAILURE: `s` › S › boom");
    expect(md).to.contain("expected 1 to equal 2");
    expect(md).to.contain("AssertionError");
    expect(md).to.contain("<details><summary>Stack trace</summary>");
  });

  it("renders an empty-suites note when nothing ran", () => {
    const report = buildUnifiedReport({ startedAt: "2026-05-20T00:00:00Z" }, []);
    const md = renderMarkdown(report);
    expect(md).to.contain("PASSED"); // vacuously
    expect(md).to.contain("_No suites were executed._");
  });
});
