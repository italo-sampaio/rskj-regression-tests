import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptK6Summary } from "../../src/adapters/k6.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(__dirname, "../../samples/k6");

describe("adapter: adaptK6Summary", () => {
  it("rejects an obviously wrong input shape", () => {
    expect(() => adaptK6Summary({} as object)).to.throw(/meta/);
  });

  it("folds zero-threshold runs into a single aggregate test (passed=true)", () => {
    const xml = readFileSync(resolve(SAMPLES, "eth_blockNumber.json"), "utf-8");
    const suite = adaptK6Summary(xml);
    expect(suite.kind).to.equal("k6");
    expect(suite.name).to.equal("k6:eth_blockNumber");
    expect(suite.verdict.total).to.equal(1);
    expect(suite.verdict.passed).to.equal(1);
    expect(suite.verdict.passed_overall).to.equal(true);
    // Duration is rounded from the meta.
    expect(suite.verdict.durationMs).to.equal(30162);
    // Extras preserve the k6-native metrics and iteration counts.
    expect(suite.extras?.iterations).to.equal(60);
    expect(suite.extras?.metrics).to.be.an("object");
  });

  it("emits one test per threshold and flags violations", () => {
    const json = readFileSync(resolve(SAMPLES, "storage_stress_with_thresholds.json"), "utf-8");
    const suite = adaptK6Summary(json);
    expect(suite.verdict.total).to.equal(3);
    expect(suite.verdict.passed).to.equal(2);
    expect(suite.verdict.failed).to.equal(1);
    expect(suite.verdict.passed_overall).to.equal(false);

    const violated = suite.tests.find((t) => t.status === "failed");
    expect(violated).to.exist;
    expect(violated!.classname).to.equal("stress_call_response_time");
    expect(violated!.failure?.type).to.equal("ThresholdViolation");
    expect(violated!.failure?.message).to.contain("p(99)<200");
  });

  it("falls back to passed=false on aggregate when summary.passed is false", () => {
    const input = {
      meta: {
        method: "demo",
        timestamp: "2026-05-20T00:00:00Z",
        duration_ms: 1000,
      },
      thresholds: {},
      metrics: { checks: { failed: 3, passed: 10 } },
      passed: false,
    };
    const suite = adaptK6Summary(input);
    expect(suite.verdict.failed).to.equal(1);
    expect(suite.tests[0]!.failure?.message).to.contain("passed=false");
  });

  it("honours suiteName / extras overrides", () => {
    const input = {
      meta: { method: "x", timestamp: "2026-05-20T00:00:00Z", duration_ms: 1 },
      thresholds: {},
      metrics: {},
      passed: true,
    };
    const suite = adaptK6Summary(input, {
      suiteName: "k6-cherry-pick",
      description: "the regression cherry-pick",
      extras: { source: "rskj-k6-tests@abcd1234" },
    });
    expect(suite.name).to.equal("k6-cherry-pick");
    expect(suite.description).to.equal("the regression cherry-pick");
    expect(suite.extras?.source).to.equal("rskj-k6-tests@abcd1234");
  });
});
