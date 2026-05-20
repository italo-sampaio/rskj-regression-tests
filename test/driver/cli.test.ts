/**
 * Unit tests for the CLI front door. These exercise argv → exit-code
 * paths without invoking the suite runners — `runDriver` is tested
 * separately. Here we only need to confirm parse failures map to
 * exit code 2 and `--help` to 0.
 */

import { expect } from "chai";
import { main } from "../../src/cli.js";

function makeStreams(): {
  stderr: (l: string) => void;
  stdout: (l: string) => void;
  errLog: string[];
  outLog: string[];
} {
  const errLog: string[] = [];
  const outLog: string[] = [];
  return {
    errLog,
    outLog,
    stderr: (l) => errLog.push(l),
    stdout: (l) => outLog.push(l),
  };
}

describe("cli/main", () => {
  it("prints usage and exits 0 on --help", async () => {
    const streams = makeStreams();
    const result = await main({ argv: ["--help"], stderr: streams.stderr, stdout: streams.stdout });
    expect(result.exitCode).to.equal(0);
    expect(streams.outLog.join("\n")).to.include("rskj-regression");
  });

  it("prints usage and exits 0 on empty argv", async () => {
    const streams = makeStreams();
    const result = await main({ argv: [], stderr: streams.stderr, stdout: streams.stdout });
    expect(result.exitCode).to.equal(0);
    expect(streams.outLog.join("\n")).to.include("rskj-regression");
  });

  it("exits 2 on unknown sub-command", async () => {
    const streams = makeStreams();
    const result = await main({
      argv: ["walk", "smoke"],
      stderr: streams.stderr,
      stdout: streams.stdout,
    });
    expect(result.exitCode).to.equal(2);
    expect(streams.errLog.join("\n")).to.include("Unknown sub-command");
  });

  it("exits 2 when --rpc-url is missing", async () => {
    const streams = makeStreams();
    const result = await main({
      argv: ["run", "smoke"],
      stderr: streams.stderr,
      stdout: streams.stdout,
      repoRoot: "/work/rskj-regression",
      env: {},
      cwd: "/work",
    });
    expect(result.exitCode).to.equal(2);
    expect(streams.errLog.join("\n")).to.include("--rpc-url");
  });

  it("exits 2 when sibling-suite paths do not resolve", async () => {
    const streams = makeStreams();
    const result = await main({
      argv: [
        "run",
        "smoke",
        "--rpc-url",
        "http://x",
        "--hardhat-tests-path",
        "/this/does/not/exist/h",
        "--k6-tests-path",
        "/this/does/not/exist/k",
      ],
      stderr: streams.stderr,
      stdout: streams.stdout,
      repoRoot: "/work/rskj-regression",
      env: {},
      cwd: "/work",
    });
    expect(result.exitCode).to.equal(2);
    expect(streams.errLog.join("\n")).to.match(/checkout not found/);
  });
});
