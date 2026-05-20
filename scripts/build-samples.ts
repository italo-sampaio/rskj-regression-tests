/**
 * Regenerate the checked-in sample outputs under `samples/unified/`.
 *
 * Reads the inputs in `samples/hardhat/` and `samples/k6/`, runs them
 * through the adapters, builds one combined unified report, and writes:
 *
 *   - `samples/unified/sample-report.json` (canonical JSON)
 *   - `samples/unified/sample-report.xml`  (JUnit projection)
 *   - `samples/unified/sample-report.md`   (Markdown projection)
 *
 * Run with: `npx tsx scripts/build-samples.ts`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const ROOT = resolve(__dirname, "..");
const SAMPLES = resolve(ROOT, "samples");
const OUT = resolve(SAMPLES, "unified");

function readText(path: string): string {
  return readFileSync(resolve(SAMPLES, path), "utf-8");
}

function main() {
  mkdirSync(OUT, { recursive: true });

  const suites: UnifiedSuite[] = [
    adaptHardhatJUnit(readText("hardhat/result.xml"), "hardhat-smoke", {
      network: "rsk_regtest",
      rpcUrl: "http://localhost:4444",
    }),
    adaptK6Summary(readText("k6/eth_blockNumber.json"), {
      suiteName: "k6:eth_blockNumber",
      description: "Smoke check for eth_blockNumber RPC throughput",
    }),
    adaptK6Summary(readText("k6/storage_stress_with_thresholds.json"), {
      suiteName: "k6:storage_stress",
      description: "Storage-stress scenario with latency thresholds",
    }),
  ];

  const report = buildUnifiedReport(
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

  writeFileSync(resolve(OUT, "sample-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(resolve(OUT, "sample-report.xml"), renderJUnitXml(report));
  writeFileSync(resolve(OUT, "sample-report.md"), renderMarkdown(report));

  console.log("Wrote sample-report.{json,xml,md} into", OUT);
}

main();
