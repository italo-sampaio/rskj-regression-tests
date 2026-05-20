/**
 * Drift detector for the checked-in `samples/unified/` golden outputs.
 *
 * Re-runs the same build that `scripts/build-samples.ts` performs and
 * asserts the output matches what's on disk. If this test fails, the
 * sample inputs or the schema / adapters / emitters have drifted; run
 * `npx tsx scripts/build-samples.ts` to regenerate, then re-review the
 * diff to confirm the change is intentional before committing.
 */
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adaptHardhatJUnit,
  adaptK6Summary,
  buildUnifiedReport,
  renderJUnitXml,
  renderMarkdown,
  type UnifiedSuite,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(__dirname, "../samples");

function read(rel: string): string {
  return readFileSync(resolve(SAMPLES, rel), "utf-8");
}

function buildExpectedReport() {
  const suites: UnifiedSuite[] = [
    adaptHardhatJUnit(read("hardhat/result.xml"), "hardhat-smoke", {
      network: "rsk_regtest",
      rpcUrl: "http://localhost:4444",
    }),
    adaptK6Summary(read("k6/eth_blockNumber.json"), {
      suiteName: "k6:eth_blockNumber",
      description: "Smoke check for eth_blockNumber RPC throughput",
    }),
    adaptK6Summary(read("k6/storage_stress_with_thresholds.json"), {
      suiteName: "k6:storage_stress",
      description: "Storage-stress scenario with latency thresholds",
    }),
  ];
  return buildUnifiedReport(
    {
      runId: "sample-run-0001",
      startedAt: "2026-05-20T12:00:00Z",
      endedAt: "2026-05-20T12:18:30Z",
      rskjVersion: "vetiver-9.0.1-gaslimit-RC1",
      network: "regtest",
      rpcUrl: "http://localhost:4444",
      labels: { source: "scripts/build-samples.ts" },
    },
    suites,
  );
}

describe("samples: golden outputs", () => {
  const report = buildExpectedReport();

  it("samples/unified/sample-report.json matches the source inputs", () => {
    const onDisk = JSON.parse(read("unified/sample-report.json"));
    expect(onDisk).to.deep.equal(report);
  });

  it("samples/unified/sample-report.xml matches the JUnit projection", () => {
    const onDisk = read("unified/sample-report.xml");
    expect(onDisk).to.equal(renderJUnitXml(report));
  });

  it("samples/unified/sample-report.md matches the Markdown projection", () => {
    const onDisk = read("unified/sample-report.md");
    expect(onDisk).to.equal(renderMarkdown(report));
  });
});
