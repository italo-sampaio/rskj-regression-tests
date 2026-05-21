/**
 * Hardhat suite runner.
 *
 * Shells out to `npx hardhat test mocha` inside the rskj-hardhat-tests
 * checkout the driver was configured with, then reads back the rolled-up
 * `results/result.json` that the sibling repo's global mocha `setup.ts`
 * writes at the end of every test session.
 *
 * Why `result.json` and not JUnit XML:
 *
 *   Hardhat 3 only allows one mocha reporter via its `test.mocha.reporter`
 *   config, and `rskj-hardhat-tests` already uses that slot for a custom
 *   JSON collector. We can't pass `--reporter xunit` on the CLI either
 *   (hardhat 3 doesn't expose that flag). Reading the JSON the sibling
 *   already writes is strictly cheaper for the POC than negotiating a
 *   reporter switch in the sibling repo. The {@link adaptHardhatResultJson}
 *   adapter converts the JSON into the same {@link UnifiedSuite} the
 *   JUnit-XML adapter would, so the rest of the driver doesn't care.
 *
 * Smoke vs. full subset:
 *
 *   The `--grep "\[smoke\]"` selection used in CI (see
 *   `rskj-hardhat-tests/package.json` `test:smoke:rsk:*` scripts) is the
 *   gating slice. The runner replicates that invocation rather than
 *   shelling into one of the existing npm scripts so the driver controls
 *   the RPC URL (via `--network <id>`) and isn't tied to which scripts
 *   the sibling repo happens to expose.
 *
 *   Env-var contract with the sibling suite:
 *     - `HARDHAT_NETWORK=<id>`              picks the network block in
 *                                           the consumer's `hardhat.config.ts`.
 *     - `SMOKE=true`                        enables `setup.ts` smoke behaviour
 *                                           (matches the existing npm scripts).
 *     - `AUTO_FUND_ACCOUNTS` (passthrough)  caller decides; if not set we
 *                                           leave the env var alone so the
 *                                           sibling repo's default (which
 *                                           does the right thing for
 *                                           regtest) takes over.
 *
 *   We don't try to set up `PRIVATE_KEY_<NETWORK>_*` here — that's a
 *   caller concern. The driver inherits `process.env`, so a CI step that
 *   exports those keys before invoking us will Just Work.
 *
 * Failure semantics:
 *
 *   A hardhat run that produces a `result.json` with failing testcases
 *   is surfaced as a `passed_overall: false` suite — _not_ a runner
 *   error. The runner only synthesises an `error`-status suite when:
 *     - `result.json` is missing entirely (the process didn't even get
 *       far enough to emit one).
 *     - The JSON can't be parsed by the adapter.
 *     - The child process terminated via signal.
 *   This keeps the report meaningful in catastrophic failure cases
 *   without conflating them with assertion failures.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { adaptHardhatResultJson } from "../../adapters/hardhat-json.js";
import type { UnifiedSuite } from "../../report/schema.js";
import { computeSuiteVerdict } from "../../report/schema.js";
import type { HardhatRun } from "../presets.js";

/** Side-channel parameters the driver passes to the runner. */
export interface HardhatRunnerOptions {
  /** Absolute path to the rskj-hardhat-tests checkout. */
  hardhatTestsPath: string;
  /** RPC URL the network block should target — surfaced via env. */
  rpcUrl: string;
  /** Hardhat network identifier (`rsk_regtest`, `rsk_betanet`, ...). */
  network: string;
  /**
   * Override for the result-file path *relative* to `hardhatTestsPath`.
   * Defaults to `results/result.json` — what the sibling repo's global
   * mocha `setup.ts` writes at the end of every test session.
   */
  resultRelPath?: string;
  /**
   * Override the spawn implementation — used by tests to inject a fake
   * child process. Production callers omit this.
   */
  spawnFn?: typeof spawn;
  /**
   * Override the file reader — used by tests to inject XML content
   * without touching disk. Production callers omit this.
   */
  readFileFn?: (p: string) => string;
  /**
   * Override the existence check — pairs with `readFileFn` for tests.
   */
  existsFn?: (p: string) => boolean;
  /**
   * Optional logger; defaults to console. The driver wires this to its
   * own logger so progress updates flow through one place.
   */
  log?: (line: string) => void;
}

/** Result of a single hardhat invocation, ready for the unified report. */
export interface HardhatRunnerResult {
  suite: UnifiedSuite;
  /** Raw process exit code. Useful for diagnostic logging. */
  exitCode: number;
  /** Captured stdout (truncated by the spawn pipe). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Run one hardhat suite invocation and return its result as a unified suite.
 *
 * Always resolves. Failures land inside the returned `suite.verdict`;
 * a thrown error is reserved for "couldn't even produce a suite".
 *
 * @param run     Preset entry describing the hardhat invocation.
 * @param options Driver-side parameters (paths, RPC URL, network, ...).
 */
export async function runHardhat(
  run: HardhatRun,
  options: HardhatRunnerOptions,
): Promise<HardhatRunnerResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const resultRelPath = options.resultRelPath ?? "results/result.json";
  const resultAbsPath = resolve(options.hardhatTestsPath, resultRelPath);
  const spawnFn = options.spawnFn ?? spawn;
  const readFileFn = options.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const existsFn = options.existsFn ?? existsSync;

  // Reset any stale result file from a previous run so we don't silently
  // adapt a previous run's output if the current invocation fails to
  // emit one. We deliberately don't `unlink` — callers may share the
  // checkout between runs and we don't want side-effects on the
  // sibling repo. Instead we record the mtime and consider a file with
  // an older mtime "stale" after the run.
  const preMtime = existsFn(resultAbsPath) ? safeMtime(resultAbsPath) : 0;

  // Use the explicit "test mocha" task so the invocation is stable even
  // if hardhat 3 grows other test sub-tasks (solidity, etc).
  const args = ["hardhat", "test", "mocha"];
  if (run.smoke) {
    args.push("--grep", "\\[smoke\\]");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARDHAT_NETWORK: options.network,
    // The sibling suite's setup.ts gates smoke-specific behaviour on this.
    SMOKE: run.smoke ? "true" : "false",
    // Surface the RPC URL for tests that read it directly. The network
    // block in hardhat.config.ts is the primary input, but exposing the
    // URL here makes the value visible in logs.
    RSKJ_RPC_URL: options.rpcUrl,
  };

  log(`[hardhat] cwd=${options.hardhatTestsPath}`);
  log(`[hardhat] cmd=npx ${args.join(" ")} (HARDHAT_NETWORK=${options.network})`);

  const childResult = await runChild(spawnFn, "npx", args, {
    cwd: options.hardhatTestsPath,
    env,
  });

  // The sibling repo's setup.ts writes `results/result.json` at the end
  // of every test session. If the file is missing, or was not refreshed
  // by this run, surface a synthetic error suite so the report makes
  // the failure visible.
  const resultExists = existsFn(resultAbsPath);
  const resultMtime = resultExists ? safeMtime(resultAbsPath) : 0;
  const resultIsFresh = resultExists && resultMtime >= preMtime;

  if (!resultExists || !resultIsFresh) {
    log(
      `[hardhat] no fresh result.json at ${resultAbsPath} ` +
        `(exists=${resultExists}, fresh=${resultIsFresh}); building synthetic error suite.`,
    );
    return {
      suite: makeErrorSuite(run, {
        message: `hardhat suite produced no result.json at ${resultAbsPath}`,
        type: "MissingReport",
        stack: childResult.stderr.slice(-4000) || childResult.stdout.slice(-4000),
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let resultJson: string;
  try {
    resultJson = readFileFn(resultAbsPath);
  } catch (err) {
    log(`[hardhat] failed reading result.json: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to read hardhat result.json: ${(err as Error).message}`,
        type: "ReadError",
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let suite: UnifiedSuite;
  try {
    suite = adaptHardhatResultJson(resultJson, {
      suiteName: run.name,
      ...(run.description ? { description: run.description } : {}),
      extras: {
        rpcUrl: options.rpcUrl,
        network: options.network,
        exitCode: childResult.exitCode,
      },
    });
  } catch (err) {
    log(`[hardhat] adapter failed to parse result.json: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to adapt hardhat result.json: ${(err as Error).message}`,
        type: "AdapterError",
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  return {
    suite,
    exitCode: childResult.exitCode,
    stdout: childResult.stdout,
    stderr: childResult.stderr,
  };
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runChild(
  spawnFn: typeof spawn,
  command: string,
  args: string[],
  spawnOptions: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ChildResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(command, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Mirror to the driver's own stdout so progress is visible in CI.
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`hardhat child process terminated by signal ${signal}`));
        return;
      }
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function makeErrorSuite(
  run: HardhatRun,
  failure: { message: string; type: string; stack?: string },
): UnifiedSuite {
  const tests = [
    {
      name: `${run.name}: process failed to produce a parsable JUnit XML`,
      status: "error" as const,
      durationMs: 0,
      failure,
    },
  ];
  const suite: UnifiedSuite = {
    name: run.name,
    kind: "hardhat",
    verdict: computeSuiteVerdict(tests, 0),
    tests,
  };
  if (run.description) suite.description = run.description;
  return suite;
}
