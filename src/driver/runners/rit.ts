/**
 * RIT (rootstock-integration-tests) suite runner.
 *
 * RIT is fundamentally different from the hardhat and k6 suites: it is NOT
 * a client of an external RPC node. The suite **self-orchestrates** — its
 * Mocha global `before`-hook (in the repo-root `test.js`) boots its own
 * `bitcoind` daemon and three powpeg federate JVMs, mines the initial
 * blockchain, and only then runs the spec files. Consequently this runner:
 *
 *   - Does NOT consult `--auto-node` / `--rpc-url`; there is no external
 *     node for RIT to point at. The driver passes neither value through.
 *   - DOES need to be told where the powpeg fat JAR and the `bitcoind`
 *     binary live, because RIT spawns those itself via env vars.
 *
 * How the subset mechanism works (the critical gotcha):
 *
 *   RIT has no `.mocharc` and no `mocha` key in its package.json, so
 *   `mocha` falls back to its default spec glob (`['test']`) which loads the
 *   ROOT `test.js`. That file's `before`-hook boots the cluster, then
 *   glob-loads `tests/**\/*.js` filtered by the `INCLUDE_CASES` env var
 *   (comma-separated FILENAME-PREFIX match, see `needsToBeTested` in
 *   `test.js`). We must therefore NEVER pass explicit spec file paths on the
 *   mocha CLI — doing so bypasses `test.js`'s bootstrap entirely (no cluster
 *   would boot). A subset is selected purely by setting `INCLUDE_CASES` and
 *   keeping mocha on its default entry point.
 *
 * Reporter choice — `mocha-junit-reporter` (already a RIT dependency):
 *
 *   RIT ships `mocha-junit-reporter@2.2.1`. We invoke mocha with
 *   `--reporter mocha-junit-reporter` and point its output at an absolute
 *   path via the `MOCHA_FILE` env var. The resulting JUnit XML is consumed
 *   by the EXISTING {@link adaptJUnitXml} adapter (kind `"rit"`) — zero new
 *   adapter code. We deliberately do NOT use mocha's built-in `json`
 *   reporter: it partitions results into `passes` / `pending` / `failures`
 *   arrays and omits a per-test `state` field, which the hardhat-json
 *   adapter keys off, so it would misclassify every test.
 *
 * Env contract with RIT (set by this runner):
 *
 *   - `POWPEG_NODE_JAR_PATH`  the powpeg fat JAR the federates run. The
 *                             caller MUST supply this — the RIT repo's `.env`
 *                             default points at a stale SNAPSHOT jar that
 *                             does not exist on disk.
 *   - `BITCOIND_BIN_PATH`     the bitcoind 0.18.1 binary (default
 *                             `/home/italo/workspace/bitcoin-0.18.1/bin/bitcoind`).
 *   - `CONFIG_FILE_PATH`      `./config/regtest-all-keyfiles` — keyfile-only
 *                             federation, NO HSM / tcpsigner.
 *   - `INCLUDE_CASES`         comma-separated filename-prefix subset.
 *   - `EXEC_ENV`              `Ubuntu` (non-MACOS native binaries).
 *   - `MOCHA_FILE`            absolute JUnit-XML output path.
 *   - `BITCOIN_DATA_DIR`      data dir for the bitcoind child. RIT's
 *                             `lib/bitcoin-runner.js` sets
 *                             `removeDataDirOnStop: true` and uses the dir as
 *                             the child's cwd, so it MUST exist before the
 *                             spawn or Node throws `ENOENT`. We `mkdir -p` it.
 *
 * Failure semantics mirror the hardhat / k6 runners:
 *
 *   A RIT run that produces a JUnit XML with failing testcases yields a
 *   `passed_overall: false` suite — NOT a runner error. The runner only
 *   synthesises an `error`-status suite when the catastrophic case happens:
 *   bitcoind or a federate JVM fails to boot, so the Mocha `before`-hook
 *   throws and no `MOCHA_FILE` is ever written (or the file is stale /
 *   unparseable). That surfaces as a `MissingReport` error suite.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { adaptJUnitXml } from "../../adapters/junit-xml.js";
import type { UnifiedSuite } from "../../report/schema.js";
import { computeSuiteVerdict } from "../../report/schema.js";
import type { RitRun } from "../presets.js";

/** Default bitcoind 0.18.1 binary on the local workstation / CI box. */
export const DEFAULT_BITCOIND_BIN_PATH = "/home/italo/workspace/bitcoin-0.18.1/bin/bitcoind";

/** Keyfile-only federation config (no HSM / tcpsigner). */
export const RIT_CONFIG_FILE_PATH = "./config/regtest-all-keyfiles";

/** Side-channel parameters the driver passes to the RIT runner. */
export interface RitRunnerOptions {
  /** Absolute path to the rootstock-integration-tests checkout. */
  ritTestsPath: string;
  /**
   * Absolute path to the powpeg fat JAR the federates run. Surfaced as
   * `POWPEG_NODE_JAR_PATH`. Required — the RIT `.env` default is stale.
   */
  powpegJarPath: string;
  /**
   * Absolute path to the report file mocha-junit-reporter writes
   * (surfaced as `MOCHA_FILE`). The runner reads it back after the run.
   */
  reportPath: string;
  /**
   * bitcoind binary path. Defaults to {@link DEFAULT_BITCOIND_BIN_PATH}.
   */
  bitcoindBinPath?: string;
  /**
   * bitcoind data directory. Defaults to `<ritTestsPath>/bitcoin-data`
   * (matches the RIT config's own default). `mkdir -p`'d before spawn.
   */
  bitcoinDataDir?: string;
  /** Override the spawn implementation — tests inject a fake child. */
  spawnFn?: typeof spawn;
  /** Override the file reader — tests inject XML without touching disk. */
  readFileFn?: (p: string) => string;
  /** Override the existence check — pairs with `readFileFn` for tests. */
  existsFn?: (p: string) => boolean;
  /** Override the directory creator — tests capture the dirs instead. */
  mkdirFn?: (p: string) => void;
  /** Optional logger; defaults to console. */
  log?: (line: string) => void;
}

/** Result of a single RIT invocation, ready for the unified report. */
export interface RitRunnerResult {
  suite: UnifiedSuite;
  /** Raw process exit code. */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/** Mocha timeout for RIT — matches the suite's own `--timeout 1200000`. */
const RIT_MOCHA_TIMEOUT_MS = 1_200_000;

/**
 * Run one RIT invocation and return its result as a unified suite.
 *
 * Always resolves. Assertion failures land inside the returned
 * `suite.verdict`; a synthetic `error` suite is reserved for "the cluster
 * never booted, so no report was produced".
 *
 * @param run     Preset entry describing the RIT invocation.
 * @param options Driver-side parameters (paths, subset, report path, ...).
 */
export async function runRit(run: RitRun, options: RitRunnerOptions): Promise<RitRunnerResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const spawnFn = options.spawnFn ?? spawn;
  const readFileFn = options.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const existsFn = options.existsFn ?? existsSync;
  const mkdirFn = options.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));

  const reportAbs = isAbsolute(options.reportPath)
    ? options.reportPath
    : resolve(options.ritTestsPath, options.reportPath);
  const bitcoindBinPath = options.bitcoindBinPath ?? DEFAULT_BITCOIND_BIN_PATH;
  const bitcoinDataDir = options.bitcoinDataDir ?? resolve(options.ritTestsPath, "bitcoin-data");

  // GOTCHA: RIT's lib/bitcoin-runner.js uses removeDataDirOnStop and uses the
  // data dir as the bitcoind child's cwd. Node's spawn() throws ENOENT if the
  // cwd is missing, so the dir MUST exist before the run. mkdir -p it (and the
  // report dir, so mocha-junit-reporter can write even if its own mkdirp is
  // ever a no-op).
  mkdirFn(bitcoinDataDir);
  mkdirFn(dirname(reportAbs));

  // Staleness guard — see the hardhat runner for the rationale. We record the
  // pre-run mtime and treat an older file as stale, so a cluster that fails to
  // boot doesn't silently re-adapt a previous run's report.
  const preMtime = existsFn(reportAbs) ? safeMtime(reportAbs) : 0;

  // CRITICAL: keep mocha on its DEFAULT spec (no explicit file paths). Passing
  // spec paths would bypass test.js's cluster-bootstrap before-hook.
  const args = [
    "mocha",
    "--timeout",
    String(RIT_MOCHA_TIMEOUT_MS),
    "--reporter",
    "mocha-junit-reporter",
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POWPEG_NODE_JAR_PATH: options.powpegJarPath,
    BITCOIND_BIN_PATH: bitcoindBinPath,
    CONFIG_FILE_PATH: RIT_CONFIG_FILE_PATH,
    BITCOIN_DATA_DIR: bitcoinDataDir,
    EXEC_ENV: "Ubuntu",
    MOCHA_FILE: reportAbs,
  };
  if (run.includeCases && run.includeCases.length > 0) {
    env.INCLUDE_CASES = run.includeCases.join(",");
  }

  log(`[rit] cwd=${options.ritTestsPath}`);
  log(`[rit] cmd=npx ${args.join(" ")}`);
  log(`[rit] POWPEG_NODE_JAR_PATH=${options.powpegJarPath}`);
  log(`[rit] BITCOIND_BIN_PATH=${bitcoindBinPath}`);
  log(`[rit] CONFIG_FILE_PATH=${RIT_CONFIG_FILE_PATH}`);
  log(`[rit] BITCOIN_DATA_DIR=${bitcoinDataDir}`);
  log(`[rit] MOCHA_FILE=${reportAbs}`);
  log(`[rit] INCLUDE_CASES=${env.INCLUDE_CASES ?? "(all)"}`);

  const childResult = await runChild(spawnFn, "npx", args, {
    cwd: options.ritTestsPath,
    env,
  });

  const reportExists = existsFn(reportAbs);
  const reportMtime = reportExists ? safeMtime(reportAbs) : 0;
  const reportIsFresh = reportExists && reportMtime >= preMtime;

  if (!reportExists || !reportIsFresh) {
    log(
      `[rit] no fresh JUnit XML at ${reportAbs} ` +
        `(exists=${reportExists}, fresh=${reportIsFresh}); building synthetic error suite. ` +
        `This usually means bitcoind or a federate JVM failed to boot.`,
    );
    return {
      suite: makeErrorSuite(run, {
        message:
          `RIT suite produced no JUnit XML at ${reportAbs} — ` +
          `bitcoind / federate JVMs likely failed to boot.`,
        type: "MissingReport",
        stack: childResult.stderr.slice(-4000) || childResult.stdout.slice(-4000),
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let xml: string;
  try {
    xml = readFileFn(reportAbs);
  } catch (err) {
    log(`[rit] failed reading JUnit XML: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to read RIT JUnit XML: ${(err as Error).message}`,
        type: "ReadError",
      }),
      exitCode: childResult.exitCode,
      stdout: childResult.stdout,
      stderr: childResult.stderr,
    };
  }

  let suite: UnifiedSuite;
  try {
    // Merge the (possibly multiple) <testsuite> elements RIT emits — one per
    // spec file — into a single logical "rit" suite so the report gets one
    // entry per preset run, matching the hardhat runner's behaviour.
    const [merged] = adaptJUnitXml(xml, {
      suiteName: run.name,
      kind: "rit",
      merge: true,
      ...(run.description ? { description: run.description } : {}),
      extras: {
        powpegJarPath: options.powpegJarPath,
        includeCases: run.includeCases ?? null,
        exitCode: childResult.exitCode,
      },
    });
    if (!merged) {
      throw new Error("adapter produced no suites");
    }
    suite = merged;
  } catch (err) {
    log(`[rit] adapter failed to parse JUnit XML: ${(err as Error).message}`);
    return {
      suite: makeErrorSuite(run, {
        message: `Failed to adapt RIT JUnit XML: ${(err as Error).message}`,
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
 * Helpers — identical shape to the hardhat / k6 runners. Kept duplicated
 * rather than abstracted so each runner stays self-contained.
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
        rejectPromise(new Error(`rit child process terminated by signal ${signal}`));
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
  run: RitRun,
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
    kind: "rit",
    verdict: computeSuiteVerdict(tests, 0),
    tests,
  };
  if (run.description) suite.description = run.description;
  return suite;
}
