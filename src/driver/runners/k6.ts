/**
 * k6 suite runner.
 *
 * Shells out to `k6 run <script>` inside the rskj-k6-tests checkout the
 * driver was configured with, then reads back the project-native summary
 * JSON the test's `handleSummary` writes (see
 * `rskj-k6-tests/utils/custom-reporter.js`).
 *
 * The JSON is handed to {@link adaptK6Summary} — this runner does no
 * parsing of its own.
 *
 * Failure semantics mirror the hardhat runner:
 *
 *   - A k6 run that produces a summary JSON with `passed=false` (or with
 *     violated thresholds) yields a `passed_overall: false` suite.
 *   - The runner only throws / synthesises an `error` suite when the
 *     child fails to produce a parseable summary file.
 *
 * Notes on the project-native reporter:
 *
 *   - The test files declare their output path indirectly via
 *     `createHandleSummary({ method })`, which writes to
 *     `results/<method>.json` *relative to k6's cwd*. We launch k6
 *     with cwd set to the k6-tests root, so this matches the
 *     `summaryRelPath` declared in the preset.
 *   - The `RPC_URL` env var picks up the target. The driver sets it
 *     unconditionally so the test's `getCurrentNetwork()` resolves to
 *     the requested endpoint, regardless of the test's default.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { adaptK6Summary } from "../../adapters/k6.js";
import type { UnifiedSuite } from "../../report/schema.js";
import { computeSuiteVerdict } from "../../report/schema.js";
import type { K6Run } from "../presets.js";

/** Side-channel parameters the driver passes to the k6 runner. */
export interface K6RunnerOptions {
  /** Absolute path to the rskj-k6-tests checkout. */
  k6TestsPath: string;
  /** RPC URL the test should hit — surfaced as the `RPC_URL` env var. */
  rpcUrl: string;
  /**
   * Override the spawn implementation — tests inject a fake child process.
   */
  spawnFn?: typeof spawn;
  readFileFn?: (p: string) => string;
  existsFn?: (p: string) => boolean;
  log?: (line: string) => void;
}

export interface K6RunnerResult {
  suite: UnifiedSuite;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one k6 scenario and return its result as a unified suite.
 *
 * Always resolves. The k6 binary's own exit code (non-zero on threshold
 * violation) is captured but does NOT propagate as an error — the
 * authoritative source of truth is the summary JSON.
 */
export async function runK6(run: K6Run, options: K6RunnerOptions): Promise<K6RunnerResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const spawnFn = options.spawnFn ?? spawn;
  const readFileFn = options.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const existsFn = options.existsFn ?? existsSync;

  const scriptAbs = resolve(options.k6TestsPath, run.scriptRelPath);
  const summaryAbs = resolve(options.k6TestsPath, run.summaryRelPath);

  // Same staleness guard as the hardhat runner — see comments there.
  const preMtime = existsFn(summaryAbs) ? safeMtime(summaryAbs) : 0;

  const args = ["run"];
  if (run.vus !== undefined) args.push("--vus", String(run.vus));
  if (run.duration !== undefined) args.push("--duration", run.duration);
  args.push(scriptAbs);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RPC_URL: options.rpcUrl,
  };

  log(`[k6] cwd=${options.k6TestsPath}`);
  log(`[k6] cmd=k6 ${args.join(" ")} (RPC_URL=${options.rpcUrl})`);

  const childResult = await runChild(spawnFn, "k6", args, {
    cwd: options.k6TestsPath,
    env,
  });

  const summaryExists = existsFn(summaryAbs);
  const summaryMtime = summaryExists ? safeMtime(summaryAbs) : 0;
  const summaryIsFresh = summaryExists && summaryMtime >= preMtime;

  if (!summaryExists || !summaryIsFresh) {
    log(
      `[k6] no fresh summary JSON at ${summaryAbs} ` +
        `(exists=${summaryExists}, fresh=${summaryIsFresh}); building synthetic error suite.`,
    );
    return {
      suite: makeErrorSuite(run, {
        message: `k6 scenario produced no summary JSON at ${summaryAbs}`,
        type: "MissingSummary",
        stack: childResult.stderr.slice(-4000) || childResult.stdout.slice(-4000),
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let summaryText: string;
  try {
    summaryText = readFileFn(summaryAbs);
  } catch (err) {
    log(`[k6] failed reading summary JSON: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to read k6 summary JSON: ${(err as Error).message}`,
        type: "ReadError",
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let suite: UnifiedSuite;
  try {
    suite = adaptK6Summary(summaryText, {
      suiteName: run.name,
      ...(run.description ? { description: run.description } : {}),
      extras: {
        rpcUrl: options.rpcUrl,
        exitCode: childResult.exitCode,
      },
    });
  } catch (err) {
    log(`[k6] adapter failed to parse summary JSON: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to adapt k6 summary JSON: ${(err as Error).message}`,
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
 * Helpers — identical shape to the hardhat runner. Kept duplicated rather
 * than abstracted into a shared module so each runner stays self-contained
 * (the bodies are tiny and the two runners may diverge as more options land).
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
        rejectPromise(new Error(`k6 child process terminated by signal ${signal}`));
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
  run: K6Run,
  failure: { message: string; type: string; stack?: string },
): UnifiedSuite {
  const tests = [
    {
      name: `${run.name}: process failed to produce a parsable summary JSON`,
      status: "error" as const,
      durationMs: 0,
      failure,
    },
  ];
  const suite: UnifiedSuite = {
    name: run.name,
    kind: "k6",
    verdict: computeSuiteVerdict(tests, 0),
    tests,
  };
  if (run.description) suite.description = run.description;
  return suite;
}
