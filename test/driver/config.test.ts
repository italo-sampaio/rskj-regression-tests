/**
 * Unit tests for argv parsing + path/default resolution.
 *
 * Pure logic — no filesystem, no child processes. The `pathExists` hook on
 * {@link ResolveOptions} lets us assert resolution without touching disk.
 */

import { expect } from "chai";
import {
  ArgvError,
  defaultRunId,
  parseArgs,
  resolveConfig,
  usage,
} from "../../src/driver/config.js";

describe("driver/config: parseArgs", () => {
  it("returns help when argv is empty", () => {
    const parsed = parseArgs([]);
    expect(parsed.command).to.equal("help");
  });

  it("returns help on -h / --help", () => {
    expect(parseArgs(["-h"]).command).to.equal("help");
    expect(parseArgs(["--help"]).command).to.equal("help");
  });

  it("rejects an unknown sub-command", () => {
    expect(() => parseArgs(["walk"])).to.throw(ArgvError, /Unknown sub-command/);
  });

  it("parses the minimal valid invocation", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://node:4444"]);
    expect(parsed.command).to.equal("run");
    expect(parsed.preset).to.equal("smoke");
    expect(parsed.rpcUrl).to.equal("http://node:4444");
    expect(parsed.failFast).to.equal(false);
  });

  it("collects all known options", () => {
    const parsed = parseArgs([
      "run",
      "smoke",
      "--rpc-url",
      "http://x",
      "--network",
      "rsk_betanet",
      "--hardhat-tests-path",
      "/h",
      "--k6-tests-path",
      "/k",
      "--output-dir",
      "out",
      "--run-id",
      "r1",
      "--rskj-version",
      "vetiver-9.0.1",
      "--fail-fast",
    ]);
    expect(parsed.preset).to.equal("smoke");
    expect(parsed.rpcUrl).to.equal("http://x");
    expect(parsed.hardhatNetwork).to.equal("rsk_betanet");
    expect(parsed.hardhatTestsPath).to.equal("/h");
    expect(parsed.k6TestsPath).to.equal("/k");
    expect(parsed.outputDir).to.equal("out");
    expect(parsed.runId).to.equal("r1");
    expect(parsed.rskjVersion).to.equal("vetiver-9.0.1");
    expect(parsed.failFast).to.equal(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["run", "smoke", "--rpc-url", "x", "--what"])).to.throw(
      ArgvError,
      /Unknown option/,
    );
  });

  it("rejects flags that are missing their value", () => {
    expect(() => parseArgs(["run", "smoke", "--rpc-url"])).to.throw(ArgvError, /requires a value/);
  });
});

describe("driver/config: defaultRunId", () => {
  it("renders the timestamp in compact UTC form with a random suffix", () => {
    const id = defaultRunId(new Date("2026-05-20T18:42:05Z"));
    expect(id).to.match(/^20260520-184205-[a-z0-9]{4}$/);
  });
});

describe("driver/config: resolveConfig", () => {
  const REPO = "/work/rskj-regression";
  const allowAll = (): boolean => true;

  it("fills in defaults from the peer-directory convention", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x"]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: {},
      cwd: "/work",
      pathExists: allowAll,
    });
    expect(config.preset).to.equal("smoke");
    expect(config.rpcUrl).to.equal("http://x");
    expect(config.hardhatNetwork).to.equal("rsk_regtest");
    expect(config.hardhatTestsPath).to.equal("/work/rskj-hardhat-tests");
    expect(config.k6TestsPath).to.equal("/work/rskj-k6-tests");
    expect(config.outputDir).to.match(/^\/work\/reports\//);
    expect(config.runId).to.be.a("string");
    expect(config.failFast).to.equal(false);
  });

  it("prefers --hardhat-tests-path over env over peer-directory", () => {
    const parsed = parseArgs([
      "run",
      "smoke",
      "--rpc-url",
      "http://x",
      "--hardhat-tests-path",
      "/opt/h",
    ]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: { HARDHAT_TESTS_PATH: "/env/h" },
      cwd: "/work",
      pathExists: allowAll,
    });
    expect(config.hardhatTestsPath).to.equal("/opt/h");
  });

  it("falls back to env vars when flags are absent", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x"]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: { HARDHAT_TESTS_PATH: "/env/h", K6_TESTS_PATH: "/env/k" },
      cwd: "/work",
      pathExists: allowAll,
    });
    expect(config.hardhatTestsPath).to.equal("/env/h");
    expect(config.k6TestsPath).to.equal("/env/k");
  });

  it("resolves relative output-dir against cwd", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x", "--output-dir", "out/here"]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: {},
      cwd: "/my/work",
      pathExists: allowAll,
    });
    expect(config.outputDir).to.equal("/my/work/out/here");
  });

  it("honours an explicit --run-id", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x", "--run-id", "ci-build-42"]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: {},
      cwd: "/work",
      pathExists: allowAll,
    });
    expect(config.runId).to.equal("ci-build-42");
    expect(config.outputDir).to.equal("/work/reports/ci-build-42");
  });

  it("throws when required values are missing", () => {
    const parsed = parseArgs(["run"]);
    expect(() =>
      resolveConfig(parsed, { repoRoot: REPO, env: {}, cwd: "/work", pathExists: allowAll }),
    ).to.throw(/<preset>/);

    const parsedNoRpc = parseArgs(["run", "smoke"]);
    expect(() =>
      resolveConfig(parsedNoRpc, {
        repoRoot: REPO,
        env: {},
        cwd: "/work",
        pathExists: allowAll,
      }),
    ).to.throw(/--rpc-url/);
  });

  it("accepts --auto-node + --rskj-jar instead of --rpc-url", () => {
    const parsed = parseArgs([
      "run",
      "smoke",
      "--auto-node",
      "--rskj-jar",
      "/abs/path/to/rskj.jar",
    ]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: {},
      cwd: "/work",
      pathExists: allowAll,
    });
    expect(config.autoNode).to.equal(true);
    expect(config.rskjJarPath).to.equal("/abs/path/to/rskj.jar");
    expect(config.rpcUrl).to.equal(""); // filled in by the runner after auto-node boot
  });

  it("rejects --auto-node together with --rpc-url", () => {
    const parsed = parseArgs([
      "run",
      "smoke",
      "--auto-node",
      "--rskj-jar",
      "/abs/path.jar",
      "--rpc-url",
      "http://x",
    ]);
    expect(() =>
      resolveConfig(parsed, { repoRoot: REPO, env: {}, cwd: "/work", pathExists: allowAll }),
    ).to.throw(/mutually exclusive/);
  });

  it("rejects --auto-node without --rskj-jar", () => {
    const parsed = parseArgs(["run", "smoke", "--auto-node"]);
    expect(() =>
      resolveConfig(parsed, { repoRoot: REPO, env: {}, cwd: "/work", pathExists: allowAll }),
    ).to.throw(/requires --rskj-jar/);
  });

  it("rejects --auto-node when the jar path does not exist", () => {
    const parsed = parseArgs(["run", "smoke", "--auto-node", "--rskj-jar", "/abs/missing.jar"]);
    expect(() =>
      resolveConfig(parsed, {
        repoRoot: REPO,
        env: {},
        cwd: "/work",
        pathExists: (p: string) => !p.endsWith("missing.jar"),
      }),
    ).to.throw(/--rskj-jar path does not exist/);
  });

  it("resolves relative --rskj-jar against cwd", () => {
    const parsed = parseArgs([
      "run",
      "smoke",
      "--auto-node",
      "--rskj-jar",
      "build/libs/rskj-all.jar",
    ]);
    const config = resolveConfig(parsed, {
      repoRoot: REPO,
      env: {},
      cwd: "/my/work",
      pathExists: allowAll,
    });
    expect(config.rskjJarPath).to.equal("/my/work/build/libs/rskj-all.jar");
  });

  it("throws when the resolved hardhat-tests path does not exist", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x"]);
    expect(() =>
      resolveConfig(parsed, {
        repoRoot: REPO,
        env: {},
        cwd: "/work",
        // Only allow the k6 path to exist.
        pathExists: (p: string) => p.endsWith("rskj-k6-tests"),
      }),
    ).to.throw(/rskj-hardhat-tests checkout not found/);
  });

  it("throws when the resolved k6-tests path does not exist", () => {
    const parsed = parseArgs(["run", "smoke", "--rpc-url", "http://x"]);
    expect(() =>
      resolveConfig(parsed, {
        repoRoot: REPO,
        env: {},
        cwd: "/work",
        pathExists: (p: string) => p.endsWith("rskj-hardhat-tests"),
      }),
    ).to.throw(/rskj-k6-tests checkout not found/);
  });
});

describe("driver/config: usage", () => {
  it("describes the supported flags", () => {
    const text = usage();
    expect(text).to.include("--rpc-url");
    expect(text).to.include("--auto-node");
    expect(text).to.include("--rskj-jar");
    expect(text).to.include("--fail-fast");
    expect(text).to.include("--hardhat-tests-path");
    expect(text).to.include("--k6-tests-path");
  });
});
