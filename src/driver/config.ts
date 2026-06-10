/**
 * Driver configuration — argv parsing + path resolution.
 *
 * The CLI surface is intentionally tiny for the POC:
 *
 *     rskj-regression run <preset> --rpc-url <url> [flags]
 *     rskj-regression run <preset> --auto-node --rskj-jar <path> [flags]
 *
 * Flag inventory:
 *
 *   `--rpc-url <url>`           Required when `--auto-node` is *not* set.
 *                               RPC endpoint the suites target.
 *   `--auto-node`               When set, the driver spins up its own rskj
 *                               regtest node via the orchestrator library
 *                               and uses its RPC URL. Mutually exclusive
 *                               with `--rpc-url`.
 *   `--rskj-jar <path>`         Path to a rskj fat JAR. With `--auto-node`
 *                               and no `--build-mode` this is required and
 *                               is sugar for `--build-mode custom`.
 *
 * Build-sourcing flags (all require `--auto-node`; see
 * `docs/build-sourcing-modes.md`):
 *
 *   `--build-mode <m>`          `release` | `custom` | `sha`. How the rskj /
 *                               powpeg binaries are obtained. Defaults to
 *                               `custom` when `--rskj-jar` is given.
 *   `--release-version <v>`     (release) rskj release pin, e.g. `9.0.1`
 *                               or `VETIVER-9.0.1`.
 *   `--powpeg-release-version <v>` (release) optional powpeg-node pin,
 *                               e.g. `9.0.0.0`.
 *   `--rskj-sha <ref>`          (sha) git ref of rsksmart/rskj to build.
 *   `--powpeg-sha <ref>`        (sha) optional git ref of
 *                               rsksmart/powpeg-node to build.
 *   `--powpeg-jar <path>`       (custom) prebuilt powpeg fat JAR.
 *   `--tcpsigner <path>`        (custom) tcpsigner binary.
 *   `--cache-dir <path>`        Download / build cache root. Default
 *                               `$RSKJ_REGRESSION_CACHE_DIR`, else
 *                               `~/.cache/rskj-regression`.
 *
 * Backward compatibility is a hard requirement: `--auto-node --rskj-jar
 * <path>` keeps working unchanged (it synthesizes a custom-mode spec),
 * and `--rpc-url` runs need no build mode at all.
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
 * fast with a message telling the user which knob to set. The
 * env-var-or-peer-directory model is the cheapest way to keep cross-repo
 * iteration friction low; auto-cloning / fetching is out of scope until
 * the build-sourcing-modes task.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { BuildSourceSpec } from "../build/types.js";

/** Parsed-and-resolved driver configuration, ready for `runner.run()`. */
export interface DriverConfig {
  /** Preset name, e.g. `"smoke"`. */
  preset: string;
  /**
   * RPC endpoint every suite hits. When `autoNode` is set this is empty
   * at resolve-time and the driver fills it in after spinning the
   * orchestrator up.
   */
  rpcUrl: string;
  /**
   * When true, the driver owns the lifecycle of an rskj node via the
   * orchestrator library and ignores any pre-running endpoint.
   */
  autoNode: boolean;
  /**
   * Absolute path to a rskj fat JAR when `autoNode` is set with a
   * custom-mode source. Kept alongside {@link buildSpec} for backward
   * compatibility — library callers that construct a DriverConfig by
   * hand with only this field still work.
   */
  rskjJarPath?: string;
  /**
   * How `--auto-node` obtains its binaries. Synthesized as a
   * custom-mode spec when only `--rskj-jar` is given; absent on
   * `--rpc-url` runs. The runner resolves this via `resolveBinaries`
   * BEFORE starting the node.
   */
  buildSpec?: BuildSourceSpec;
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
  autoNode: boolean;
  rskjJarPath?: string;
  buildMode?: string;
  releaseVersion?: string;
  powpegReleaseVersion?: string;
  rskjSha?: string;
  powpegSha?: string;
  powpegJarPath?: string;
  tcpsignerPath?: string;
  cacheDir?: string;
  hardhatNetwork?: string;
  hardhatTestsPath?: string;
  k6TestsPath?: string;
  outputDir?: string;
  runId?: string;
  rskjVersion?: string;
  failFast: boolean;
}

const USAGE = `Usage:
  rskj-regression run <preset> --rpc-url <url> [options]
  rskj-regression run <preset> --auto-node --rskj-jar <path> [options]
  rskj-regression run <preset> --auto-node --build-mode release --release-version <v> [options]
  rskj-regression run <preset> --auto-node --build-mode sha --rskj-sha <ref> [options]

Sub-commands:
  run <preset>                Run a regression preset.

RPC source (pick exactly one):
  --rpc-url <url>             Use a pre-running node at this URL.
  --auto-node                 Spin up an rskj regtest node via the
                              orchestrator and target its RPC.

Build sourcing (all require --auto-node):
  --build-mode <mode>         How to obtain the rskj / powpeg binaries:
                              release | custom | sha. Defaults to custom
                              when --rskj-jar is given.
  --rskj-jar <path>           (custom) Path to a rskj fat JAR
                              (e.g. rskj-core-X.Y.Z-all.jar).
  --powpeg-jar <path>         (custom) Path to a powpeg fat JAR
                              (federate-node-...-all.jar).
  --tcpsigner <path>          (custom) Path to a tcpsigner binary.
  --release-version <v>       (release) rskj release pin, e.g. 9.0.1 or
                              VETIVER-9.0.1. Verified against the
                              reproducible-builds repo.
  --powpeg-release-version <v> (release) Optional powpeg-node release pin,
                              e.g. 9.0.0.0 or VETIVER-9.0.0.0.
  --rskj-sha <ref>            (sha) Git ref of rsksmart/rskj to clone+build.
  --powpeg-sha <ref>          (sha) Optional git ref of rsksmart/powpeg-node
                              to clone+build.
  --cache-dir <path>          Download / build cache root. Default
                              $RSKJ_REGRESSION_CACHE_DIR, else
                              ~/.cache/rskj-regression.

Options:
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
    return { command: "help", failFast: false, autoNode: false };
  }

  const command = argv[0];
  if (command !== "run") {
    throw new ArgvError(`Unknown sub-command "${command}". Expected "run".`);
  }

  const result: ParsedArgs = { command: "run", failFast: false, autoNode: false };
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
      case "--auto-node":
        result.autoNode = true;
        break;
      case "--rskj-jar":
        result.rskjJarPath = expectValue(argv, ++i, arg);
        break;
      case "--build-mode":
        result.buildMode = expectValue(argv, ++i, arg);
        break;
      case "--release-version":
        result.releaseVersion = expectValue(argv, ++i, arg);
        break;
      case "--powpeg-release-version":
        result.powpegReleaseVersion = expectValue(argv, ++i, arg);
        break;
      case "--rskj-sha":
        result.rskjSha = expectValue(argv, ++i, arg);
        break;
      case "--powpeg-sha":
        result.powpegSha = expectValue(argv, ++i, arg);
        break;
      case "--powpeg-jar":
        result.powpegJarPath = expectValue(argv, ++i, arg);
        break;
      case "--tcpsigner":
        result.tcpsignerPath = expectValue(argv, ++i, arg);
        break;
      case "--cache-dir":
        result.cacheDir = expectValue(argv, ++i, arg);
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
        return { command: "help", failFast: false, autoNode: false };
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
  if (parsed.autoNode && parsed.rpcUrl) {
    throw new Error("--auto-node and --rpc-url are mutually exclusive.");
  }
  if (!parsed.autoNode && !parsed.rpcUrl) {
    throw new Error("Missing required option: either --rpc-url <url> or --auto-node.");
  }
  const { buildSpec, rskjJarPath } = resolveBuildSource(parsed, cwd, pathExists);

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
    // `rpcUrl` is filled in by the runner after the auto-node boot. Keep
    // it as the empty string here rather than `undefined` so the field
    // stays string-typed throughout — the runner overwrites it before
    // any suite reads it.
    rpcUrl: parsed.rpcUrl ?? "",
    autoNode: parsed.autoNode,
    hardhatNetwork: parsed.hardhatNetwork ?? "rsk_regtest",
    hardhatTestsPath,
    k6TestsPath,
    outputDir,
    runId,
    failFast: parsed.failFast,
  };
  if (rskjJarPath) {
    result.rskjJarPath = rskjJarPath;
  }
  if (buildSpec) {
    result.buildSpec = buildSpec;
  }
  if (parsed.rskjVersion) {
    result.rskjVersion = parsed.rskjVersion;
  }
  return result;
}

/**
 * Turn the build-sourcing flags into a {@link BuildSourceSpec} (and,
 * for custom mode, the validated rskj jar path the legacy config field
 * carries).
 *
 * Rules:
 *
 *   - Every build flag requires `--auto-node` — binaries are only ever
 *     consumed to boot the node. `--rpc-url` runs pass through with no
 *     build spec at all.
 *   - No `--build-mode` + `--rskj-jar` = sugar for custom mode
 *     (backward compatibility with the pre-build-modes CLI).
 *   - Flags belonging to a different mode than the selected one are
 *     rejected, not ignored — a silently-ignored `--rskj-sha` next to
 *     `--build-mode release` would test the wrong binary.
 *   - custom-mode paths are validated to exist here so the error names
 *     the flag; release / sha artifacts don't exist yet at config time.
 */
function resolveBuildSource(
  parsed: ParsedArgs,
  cwd: string,
  pathExists: (p: string) => boolean,
): { buildSpec?: BuildSourceSpec; rskjJarPath?: string } {
  if (!parsed.autoNode) {
    const given = listGivenFlags(parsed, [
      "buildMode",
      "releaseVersion",
      "powpegReleaseVersion",
      "rskjSha",
      "powpegSha",
      "powpegJarPath",
      "tcpsignerPath",
      "cacheDir",
    ]);
    if (given.length > 0) {
      throw new Error(`${given.join(", ")} require(s) --auto-node.`);
    }
    return {};
  }

  const mode = parsed.buildMode ?? (parsed.rskjJarPath ? "custom" : undefined);
  if (mode === undefined) {
    throw new Error("--auto-node requires --rskj-jar <path> (or an explicit --build-mode).");
  }
  const cacheDir = parsed.cacheDir ? resolveCwdRelative(parsed.cacheDir, cwd) : undefined;

  switch (mode) {
    case "custom": {
      rejectForeignFlags("custom", parsed, [
        "releaseVersion",
        "powpegReleaseVersion",
        "rskjSha",
        "powpegSha",
      ]);
      if (!parsed.rskjJarPath) {
        throw new Error("--build-mode custom requires --rskj-jar <path>.");
      }
      const rskjJarPath = resolveCwdRelative(parsed.rskjJarPath, cwd);
      // Validate up-front so the error mentions the flag, not "java: no such file".
      if (!pathExists(rskjJarPath)) {
        throw new Error(
          `--rskj-jar path does not exist: ${rskjJarPath}. ` +
            `Build a fat JAR with \`./gradlew fatJar\` in the rskj source tree, or point at a prebuilt one.`,
        );
      }
      const powpegJarPath = parsed.powpegJarPath
        ? resolveCwdRelative(parsed.powpegJarPath, cwd)
        : undefined;
      if (powpegJarPath && !pathExists(powpegJarPath)) {
        throw new Error(`--powpeg-jar path does not exist: ${powpegJarPath}.`);
      }
      const tcpsignerPath = parsed.tcpsignerPath
        ? resolveCwdRelative(parsed.tcpsignerPath, cwd)
        : undefined;
      if (tcpsignerPath && !pathExists(tcpsignerPath)) {
        throw new Error(`--tcpsigner path does not exist: ${tcpsignerPath}.`);
      }
      return {
        buildSpec: {
          mode: "custom",
          rskjJar: rskjJarPath,
          ...(powpegJarPath ? { powpegJar: powpegJarPath } : {}),
          ...(tcpsignerPath ? { tcpsigner: tcpsignerPath } : {}),
        },
        rskjJarPath,
      };
    }
    case "release": {
      rejectForeignFlags("release", parsed, [
        "rskjJarPath",
        "powpegJarPath",
        "tcpsignerPath",
        "rskjSha",
        "powpegSha",
      ]);
      if (!parsed.releaseVersion) {
        throw new Error("--build-mode release requires --release-version <v>.");
      }
      return {
        buildSpec: {
          mode: "release",
          rskjVersion: parsed.releaseVersion,
          ...(parsed.powpegReleaseVersion ? { powpegVersion: parsed.powpegReleaseVersion } : {}),
          ...(cacheDir ? { cacheDir } : {}),
        },
      };
    }
    case "sha": {
      rejectForeignFlags("sha", parsed, [
        "rskjJarPath",
        "powpegJarPath",
        "tcpsignerPath",
        "releaseVersion",
        "powpegReleaseVersion",
      ]);
      if (!parsed.rskjSha) {
        throw new Error(
          "--build-mode sha requires --rskj-sha <ref> with --auto-node " +
            "(the driver boots the rskj node from it).",
        );
      }
      return {
        buildSpec: {
          mode: "sha",
          rskjRef: parsed.rskjSha,
          ...(parsed.powpegSha ? { powpegRef: parsed.powpegSha } : {}),
          ...(cacheDir ? { cacheDir } : {}),
        },
      };
    }
    default:
      throw new Error(`Unknown --build-mode "${mode}". Expected release, custom, or sha.`);
  }
}

/** Flag spellings for the {@link ParsedArgs} keys used in error messages. */
const FLAG_BY_KEY: Partial<Record<keyof ParsedArgs, string>> = {
  buildMode: "--build-mode",
  releaseVersion: "--release-version",
  powpegReleaseVersion: "--powpeg-release-version",
  rskjSha: "--rskj-sha",
  powpegSha: "--powpeg-sha",
  rskjJarPath: "--rskj-jar",
  powpegJarPath: "--powpeg-jar",
  tcpsignerPath: "--tcpsigner",
  cacheDir: "--cache-dir",
};

function listGivenFlags(parsed: ParsedArgs, keys: (keyof ParsedArgs)[]): string[] {
  return keys.filter((k) => parsed[k] !== undefined).map((k) => FLAG_BY_KEY[k] ?? String(k));
}

function rejectForeignFlags(mode: string, parsed: ParsedArgs, keys: (keyof ParsedArgs)[]): void {
  const given = listGivenFlags(parsed, keys);
  if (given.length > 0) {
    throw new Error(`${given.join(", ")} cannot be combined with --build-mode ${mode}.`);
  }
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
