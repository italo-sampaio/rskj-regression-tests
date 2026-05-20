/**
 * Driver configuration — argv parsing + path resolution.
 *
 * The CLI surface is intentionally tiny for the POC:
 *
 *     rskj-regression run <preset> --rpc-url <url> [flags]
 *
 * Flag inventory:
 *
 *   `--rpc-url <url>`           Required. RPC endpoint the suites target.
 *   `--output-dir <dir>`        Where to write the unified report bundle.
 *                               Defaults to `./reports/<run-id>/`. The run
 *                               id is auto-generated from the timestamp
 *                               when omitted.
 *   `--run-id <id>`             Override the auto-generated run id.
 *   `--hardhat-tests-path <p>`  Local clone of rskj-hardhat-tests. Falls
 *                               back to env `HARDHAT_TESTS_PATH`, then to
 *                               the peer-directory convention
 *                               (`<repo-parent>/rskj-hardhat-tests`).
 *   `--k6-tests-path <p>`       Local clone of rskj-k6-tests. Same
 *                               fallback chain, env `K6_TESTS_PATH`.
 *   `--network <name>`          Hardhat network identifier (default
 *                               `rsk_regtest`). The driver passes this
 *                               through; account env vars are the
 *                               caller's responsibility.
 *   `--rskj-version <v>`        Tag carried into report metadata.
 *   `--fail-fast`               Stop after the first suite fails / errors.
 *                               Default policy is run-all; see the parent
 *                               initiative's "Failure policy" decision.
 *   `--help` / `-h`             Show usage.
 *
 * Path resolution is explicit so the failure mode is clear: when neither
 * the flag, the env var, nor the peer-directory exists, the driver fails
 * fast with a message telling the user which knob to set. We picked the
 * env-var-or-peer-directory model over auto-cloning to keep the POC's
 * footprint small — orchestration that owns its dependencies lands in
 * task #4.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Parsed-and-resolved driver configuration, ready for `runner.run()`. */
export interface DriverConfig {
  /** Preset name, e.g. `"smoke"`. */
  preset: string;
  /** RPC endpoint every suite hits. Required. */
  rpcUrl: string;
  /** Hardhat network identifier passed via `HARDHAT_NETWORK`. */
  hardhatNetwork: string;
  /** Resolved absolute path to a checkout of `rskj-hardhat-tests`. */
  hardhatTestsPath: string;
  /** Resolved absolute path to a checkout of `rskj-k6-tests`. */
  k6TestsPath: string;
  /** Absolute output directory for `{report.json,report.xml,report.md}` + raw suite outputs. */
  outputDir: string;
  /** Run identifier; appears in report metadata + default output-dir name. */
  runId: string;
  /** rskj version label carried into the report. */
  rskjVersion?: string;
  /** When true, stop after the first failing suite. */
  failFast: boolean;
}

/**
 * Parsed argv, before path resolution. Internal — exposed only for tests.
 */
export interface ParsedArgs {
  /** Sub-command, currently always `"run"`. */
  command: "run" | "help";
  preset?: string;
  rpcUrl?: string;
  hardhatNetwork?: string;
  hardhatTestsPath?: string;
  k6TestsPath?: string;
  outputDir?: string;
  runId?: string;
  rskjVersion?: string;
  failFast: boolean;
}

const USAGE = `Usage: rskj-regression run <preset> --rpc-url <url> [options]

Sub-commands:
  run <preset>                Run a regression preset against a pre-running node.

Options:
  --rpc-url <url>             Required. RPC endpoint the suites target.
  --network <name>            Hardhat network identifier (default rsk_regtest).
  --hardhat-tests-path <p>    Path to a rskj-hardhat-tests checkout.
                              Falls back to env HARDHAT_TESTS_PATH, then
                              <repo-parent>/rskj-hardhat-tests.
  --k6-tests-path <p>         Path to a rskj-k6-tests checkout.
                              Falls back to env K6_TESTS_PATH, then
                              <repo-parent>/rskj-k6-tests.
  --output-dir <dir>          Output bundle directory.
                              Default ./reports/<run-id>/.
  --run-id <id>               Override the auto-generated run id.
  --rskj-version <v>          Label carried into report metadata.
  --fail-fast                 Stop after the first suite fails (default: run all).
  -h, --help                  Show this message.

Exit code: 0 when overall verdict passes, 1 when it fails.
`;

/**
 * Print the usage string. Exposed for tests; the CLI calls this when
 * `--help` is passed or when argv parsing rejects the input.
 */
export function usage(): string {
  return USAGE;
}

class ArgvError extends Error {}

/**
 * Parse a raw argv slice (without `node`/`script`) into a {@link ParsedArgs}.
 *
 * Pure — does not touch the filesystem. Used directly by tests; the CLI
 * calls {@link resolveConfig} which wraps this plus path resolution.
 *
 * @throws ArgvError on unknown flags, missing values, or unrecognised subcommands.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { command: "help", failFast: false };
  }

  const command = argv[0];
  if (command !== "run") {
    throw new ArgvError(`Unknown sub-command "${command}". Expected "run".`);
  }

  const result: ParsedArgs = { command: "run", failFast: false };
  let i = 1;
  // The first positional after `run` is the preset.
  if (i < argv.length && !argv[i]!.startsWith("-")) {
    result.preset = argv[i];
    i++;
  }

  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "--rpc-url":
        result.rpcUrl = expectValue(argv, ++i, arg);
        break;
      case "--network":
        result.hardhatNetwork = expectValue(argv, ++i, arg);
        break;
      case "--hardhat-tests-path":
        result.hardhatTestsPath = expectValue(argv, ++i, arg);
        break;
      case "--k6-tests-path":
        result.k6TestsPath = expectValue(argv, ++i, arg);
        break;
      case "--output-dir":
        result.outputDir = expectValue(argv, ++i, arg);
        break;
      case "--run-id":
        result.runId = expectValue(argv, ++i, arg);
        break;
      case "--rskj-version":
        result.rskjVersion = expectValue(argv, ++i, arg);
        break;
      case "--fail-fast":
        result.failFast = true;
        break;
      case "-h":
      case "--help":
        return { command: "help", failFast: false };
      default:
        throw new ArgvError(`Unknown option "${arg}".`);
    }
    i++;
  }

  return result;
}

function expectValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined || value.startsWith("--")) {
    throw new ArgvError(`Option "${flag}" requires a value.`);
  }
  return value;
}

/** Generate a default run id from the current time, e.g. `20260520-184530-abcd`. */
export function defaultRunId(now: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const date =
    `${now.getUTCFullYear()}` + `${pad(now.getUTCMonth() + 1)}` + `${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  // Short pseudo-random suffix so two runs in the same second don't collide.
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${date}-${time}-${suffix}`;
}

/** Pure path-resolution input shape — exposed so {@link resolveConfig} can be unit-tested. */
export interface ResolveOptions {
  /**
   * Repository root the driver lives in — used as the anchor for the
   * peer-directory fallback (`<repoRoot>/../rskj-hardhat-tests` etc).
   */
  repoRoot: string;
  /** Environment variables — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** CWD anchor for relative `--output-dir` and `--*-tests-path` flags. */
  cwd?: string;
  /**
   * Filesystem existence check — defaults to `existsSync`. Tests inject
   * a stub to avoid touching the real filesystem.
   */
  pathExists?: (p: string) => boolean;
}

/**
 * Resolve a {@link ParsedArgs} into a fully-formed {@link DriverConfig}.
 *
 * Applies defaults, fills in path fallbacks (flag > env > peer-directory),
 * and validates that the resolved hardhat / k6 paths exist when the
 * preset uses them. Throws with a clear message otherwise.
 *
 * @throws Error when required values are missing or paths don't exist.
 */
export function resolveConfig(parsed: ParsedArgs, options: ResolveOptions): DriverConfig {
  if (parsed.command !== "run") {
    throw new Error('resolveConfig: expected a "run" command');
  }
  const pathExists = options.pathExists ?? existsSync;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (!parsed.preset) {
    throw new Error("Missing required positional argument: <preset>.");
  }
  if (!parsed.rpcUrl) {
    throw new Error("Missing required option: --rpc-url <url>.");
  }

  const repoParent = dirname(options.repoRoot);
  const hardhatTestsPath = resolvePathFlag(
    parsed.hardhatTestsPath,
    env.HARDHAT_TESTS_PATH,
    resolve(repoParent, "rskj-hardhat-tests"),
    cwd,
  );
  const k6TestsPath = resolvePathFlag(
    parsed.k6TestsPath,
    env.K6_TESTS_PATH,
    resolve(repoParent, "rskj-k6-tests"),
    cwd,
  );

  // We validate existence here so the driver fails before forking out to
  // the suite runners — the error message is much clearer this way.
  ensureDirectory(hardhatTestsPath, "rskj-hardhat-tests", "HARDHAT_TESTS_PATH", pathExists);
  ensureDirectory(k6TestsPath, "rskj-k6-tests", "K6_TESTS_PATH", pathExists);

  const runId = parsed.runId ?? defaultRunId();
  const outputDir = parsed.outputDir
    ? resolveCwdRelative(parsed.outputDir, cwd)
    : resolve(cwd, "reports", runId);

  const result: DriverConfig = {
    preset: parsed.preset,
    rpcUrl: parsed.rpcUrl,
    hardhatNetwork: parsed.hardhatNetwork ?? "rsk_regtest",
    hardhatTestsPath,
    k6TestsPath,
    outputDir,
    runId,
    failFast: parsed.failFast,
  };
  if (parsed.rskjVersion) {
    result.rskjVersion = parsed.rskjVersion;
  }
  return result;
}

function resolvePathFlag(
  flagValue: string | undefined,
  envValue: string | undefined,
  fallback: string,
  cwd: string,
): string {
  if (flagValue) return resolveCwdRelative(flagValue, cwd);
  if (envValue) return resolveCwdRelative(envValue, cwd);
  return fallback;
}

function resolveCwdRelative(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function ensureDirectory(
  path: string,
  label: string,
  envVar: string,
  pathExists: (p: string) => boolean,
): void {
  if (!pathExists(path)) {
    throw new Error(
      `${label} checkout not found at ${path}. ` +
        `Set --${labelToFlag(label)} or the ${envVar} env var, ` +
        `or clone the repo next to rskj-regression.`,
    );
  }
  // statSync only when the path exists — the existence check above used
  // the (overridable) pathExists hook. Tests with the stub skip this.
  try {
    const s = statSync(path);
    if (!s.isDirectory()) {
      throw new Error(`${label} path "${path}" is not a directory.`);
    }
  } catch {
    // statSync failed despite pathExists returning true; let it through
    // — this path is exercised only by the tests that inject pathExists.
  }
}

function labelToFlag(label: string): string {
  // "rskj-hardhat-tests" → "hardhat-tests-path"; "rskj-k6-tests" → "k6-tests-path"
  return `${label.replace(/^rskj-/, "")}-path`;
}

// Expose for tests / consumers that want to surface argv errors as
// regular Errors (e.g. CLI's `try/catch`).
export { ArgvError };
