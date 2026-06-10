import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptHardhatJUnit, adaptJUnitXml, parseJUnitXml } from "../../src/adapters/junit-xml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_HARDHAT = resolve(__dirname, "../../samples/hardhat/result.xml");

describe("adapter: parseJUnitXml", () => {
  it("rejects empty or malformed input", () => {
    expect(() => parseJUnitXml("")).to.throw(/no <testsuite>/);
    expect(() => parseJUnitXml("<root></root>")).to.throw(/no <testsuite>/);
  });

  it("parses a single testsuite (mocha xunit shape)", () => {
    const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1" failures="0" errors="0" skipped="0" time="0.123">
  <testcase classname="C" name="t" time="0.05"/>
</testsuite>`;
    const { suites } = parseJUnitXml(xml);
    expect(suites).to.have.length(1);
    expect(suites[0]!.attrs["name"]).to.equal("S");
    expect(suites[0]!.testcases).to.have.length(1);
  });

  it("parses a testsuites wrapper (junit-reporter / k6 shape)", () => {
    const xml = `<testsuites>
  <testsuite name="A" time="1.0"><testcase name="a" time="0.5"/></testsuite>
  <testsuite name="B" time="2.0"><testcase name="b" time="1.5"/></testsuite>
</testsuites>`;
    const { suites } = parseJUnitXml(xml);
    expect(suites).to.have.length(2);
    expect(suites.map((s) => s.attrs["name"])).to.deep.equal(["A", "B"]);
  });
});

describe("adapter: adaptJUnitXml", () => {
  it("converts pass / fail / skip into the unified shape", () => {
    const xml = `<testsuite name="S" tests="3" failures="1" skipped="1" errors="0" time="0.300">
  <testcase classname="C" name="ok" time="0.100"/>
  <testcase classname="C" name="fails" time="0.150">
    <failure message="bad" type="AssertionError">stack here</failure>
  </testcase>
  <testcase classname="C" name="skipped" time="0">
    <skipped/>
  </testcase>
</testsuite>`;
    const [suite] = adaptJUnitXml(xml);
    expect(suite!.verdict.total).to.equal(3);
    expect(suite!.verdict.passed).to.equal(1);
    expect(suite!.verdict.failed).to.equal(1);
    expect(suite!.verdict.skipped).to.equal(1);
    expect(suite!.verdict.durationMs).to.equal(300);
    expect(suite!.tests[1]!.failure?.message).to.equal("bad");
    expect(suite!.tests[1]!.failure?.type).to.equal("AssertionError");
    expect(suite!.tests[1]!.failure?.stack).to.equal("stack here");
  });

  it("distinguishes <error> from <failure>", () => {
    const xml = `<testsuite name="S" time="0">
  <testcase name="explodes" time="0">
    <error message="ENOENT" type="Error">stack</error>
  </testcase>
</testsuite>`;
    const [suite] = adaptJUnitXml(xml);
    expect(suite!.tests[0]!.status).to.equal("error");
    expect(suite!.verdict.errored).to.equal(1);
    expect(suite!.verdict.failed).to.equal(0);
    expect(suite!.verdict.passed_overall).to.equal(false);
  });

  it("merges multiple <testsuite>s when merge=true", () => {
    const xml = `<testsuites>
  <testsuite name="A" time="1.0"><testcase name="a" time="0.5"/></testsuite>
  <testsuite name="B" time="2.0"><testcase name="b" time="1.5"/></testsuite>
</testsuites>`;
    const merged = adaptJUnitXml(xml, { suiteName: "all", merge: true });
    expect(merged).to.have.length(1);
    expect(merged[0]!.name).to.equal("all");
    expect(merged[0]!.verdict.total).to.equal(2);
    expect(merged[0]!.verdict.durationMs).to.equal(3000);
  });

  it("tags merged suites with kind 'rit' for the RIT runner", () => {
    // RIT emits one <testsuite> per spec file; the runner merges them under
    // a single kind:'rit' suite.
    const xml = `<testsuites name="Mocha Tests" tests="3" failures="0" time="3.0">
  <testsuite name="Sync" time="1.0"><testcase name="boots" time="1.0"/></testsuite>
  <testsuite name="Bridge" time="2.0">
    <testcase name="ok" time="1.0"/>
    <testcase name="ok2" time="1.0"/>
  </testsuite>
</testsuites>`;
    const [suite] = adaptJUnitXml(xml, { suiteName: "rit-2wp-smoke", kind: "rit", merge: true });
    expect(suite!.kind).to.equal("rit");
    expect(suite!.name).to.equal("rit-2wp-smoke");
    expect(suite!.verdict.total).to.equal(3);
    expect(suite!.verdict.passed).to.equal(3);
    expect(suite!.verdict.durationMs).to.equal(3000);
  });

  it("accepts the checked-in hardhat sample and produces a coherent suite", () => {
    const xml = readFileSync(SAMPLE_HARDHAT, "utf-8");
    const suite = adaptHardhatJUnit(xml);
    expect(suite.kind).to.equal("hardhat");
    expect(suite.name).to.equal("hardhat-smoke");
    expect(suite.verdict.total).to.equal(6);
    expect(suite.verdict.passed).to.equal(4);
    expect(suite.verdict.failed).to.equal(1);
    expect(suite.verdict.skipped).to.equal(1);
    expect(suite.verdict.passed_overall).to.equal(false);
    const failing = suite.tests.find((t) => t.status === "failed");
    expect(failing).to.exist;
    expect(failing!.failure?.message).to.contain("expected");
  });
});
