import { expect } from "chai";
import { adaptHardhatResultJson } from "../../src/adapters/hardhat-json.js";

const RESULT_JSON = {
  stats: {
    suites: 2,
    tests: 4,
    passes: 2,
    pending: 1,
    failures: 1,
    start: "2026-05-20T20:00:00.000Z",
    end: "2026-05-20T20:00:01.230Z",
    duration: 1230,
  },
  tests: [
    {
      title: "passes",
      fullTitle: "Chain ID [smoke] passes",
      file: "/repo/test/core/ChainIDTest.ts",
      duration: 200,
      state: "passed",
      err: {},
    },
    {
      title: "fails",
      fullTitle: "Chain ID [smoke] fails",
      file: "/repo/test/core/ChainIDTest.ts",
      duration: 300,
      state: "failed",
      err: { message: "wrong chain id", name: "AssertionError", stack: "at Foo.bar" },
    },
    {
      title: "pending",
      fullTitle: "Chain ID [smoke] pending",
      file: "/repo/test/core/ChainIDTest.ts",
      duration: 0,
      state: "pending",
      err: {},
    },
    {
      title: "weird",
      fullTitle: "Other [smoke] weird",
      file: "/repo/test/core/Other.ts",
      duration: 50,
      state: "wat",
      err: {},
    },
  ],
  networkInfo: { network: "rsk_regtest", chainId: 33 },
};

describe("adapter: adaptHardhatResultJson", () => {
  it("maps mocha states to the unified shape", () => {
    const suite = adaptHardhatResultJson(RESULT_JSON);
    expect(suite.kind).to.equal("hardhat");
    expect(suite.name).to.equal("hardhat-smoke");
    expect(suite.verdict.total).to.equal(4);
    expect(suite.verdict.passed).to.equal(1);
    expect(suite.verdict.failed).to.equal(1);
    expect(suite.verdict.skipped).to.equal(1);
    expect(suite.verdict.errored).to.equal(1);
    expect(suite.verdict.passed_overall).to.equal(false);
    expect(suite.verdict.durationMs).to.equal(1230);
  });

  it("strips the suite-prefix when computing classname", () => {
    const suite = adaptHardhatResultJson(RESULT_JSON);
    expect(suite.tests[0]!.classname).to.equal("Chain ID [smoke]");
  });

  it("preserves failure detail on failed tests", () => {
    const suite = adaptHardhatResultJson(RESULT_JSON);
    const failed = suite.tests.find((t) => t.status === "failed")!;
    expect(failed.failure?.message).to.equal("wrong chain id");
    expect(failed.failure?.type).to.equal("AssertionError");
    expect(failed.failure?.stack).to.equal("at Foo.bar");
  });

  it("preserves the network info in extras", () => {
    const suite = adaptHardhatResultJson(RESULT_JSON);
    expect((suite.extras?.networkInfo as { network?: string }).network).to.equal("rsk_regtest");
  });

  it("accepts a string input as well as an already-parsed object", () => {
    const suite = adaptHardhatResultJson(JSON.stringify(RESULT_JSON));
    expect(suite.verdict.total).to.equal(4);
  });

  it("throws when the document doesn't have a tests array", () => {
    expect(() => adaptHardhatResultJson({ stats: {} } as unknown as object)).to.throw(/tests/);
  });

  it("accepts an empty tests array as a zero-counts (passing) suite", () => {
    const suite = adaptHardhatResultJson({ stats: { duration: 0 }, tests: [] });
    expect(suite.verdict.total).to.equal(0);
    expect(suite.verdict.passed_overall).to.equal(true);
  });
});
