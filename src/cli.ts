/**
 * CLI entry point for `rskj-regression run <preset>`.
 *
 * Responsibilities:
 *   - Parse argv via {@link parseArgs}.
 *   - Resolve paths + defaults via {@link resolveConfig}.
 *   - Hand off to {@link runDriver} which orchestrates the suites and
 *     writes the unified-report bundle to disk.
 *   - Map the resulting verdict to a process exit code.
 *
 * Kept thin on purpose — all the interesting decisions live in
 * `src/driver/*`. This module exists so the binary stub
 * (`bin/rskj-regression.js`) has one symbol to import.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgvError, parseArgs, resolveConfig, usage, type DriverConfig } from "./driver/config.js";
import { exitCodeFor, runDriver } from "./driver/runner.js";

/** Inputs for {@link main} — exposed so tests can drive the CLI directly. */
export interface CliInputs {
  /** argv without the leading `node`/`script` slots. */
  argv: string[];
  /** Anchor for path resolution; defaults to this repo's root. */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Stream errors / usage out somewhere other than process.stderr (tests). */
  stderr?: (line: string) => void;
  /** Stream info messages somewhere other than process.stdout (tests). */
  stdout?: (line: string) => void;
}

/** Result of running {@link main} as a function. */
export interface CliOutcome {
  exitCode: number;
  /** When set, the resolved config the run used. Missing on parse / help paths. */
  config?: DriverConfig;
}

/**
 * Run the CLI as a function. Returns the exit code rather than calling
 * `process.exit`, so tests can assert on it without tearing down the
 * test process.
 */
export async function main(inputs: CliInputs): Promise<CliOutcome> {
  const stderr = inputs.stderr ?? ((l) => process.stderr.write(l + "\n"));
  const stdout = inputs.stdout ?? ((l) => process.stdout.write(l + "\n"));
  const repoRoot = inputs.repoRoot ?? defaultRepoRoot();

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(inputs.argv);
  } catch (err) {
    if (err instanceof ArgvError) {
      stderr(`error: ${err.message}`);
      stderr(usage());
      return { exitCode: 2 };
    }
    throw err;
  }

  if (parsed.command === "help") {
    stdout(usage());
    return { exitCode: 0 };
  }

  let config: DriverConfig;
  try {
    config = resolveConfig(parsed, {
      repoRoot,
      ...(inputs.env ? { env: inputs.env } : {}),
      ...(inputs.cwd ? { cwd: inputs.cwd } : {}),
    });
  } catch (err) {
    stderr(`error: ${(err as Error).message}`);
    stderr(usage());
    return { exitCode: 2 };
  }

  try {
    const result = await runDriver(config);
    return { exitCode: exitCodeFor(result), config };
  } catch (err) {
    stderr(`error: driver run failed: ${(err as Error).message}`);
    if ((err as Error).stack) stderr((err as Error).stack ?? "");
    return { exitCode: 3, config };
  }
}

/**
 * Default repo root used when the CLI is invoked through the binary
 * stub. Walks up from the compiled `cli.js` looking for the nearest
 * `package.json` whose `name` is `"rskj-regression"`. We don't trust an
 * arbitrary `package.json` because in the installed-as-dependency case
 * we'd land on a consumer's manifest instead of ours.
 *
 * If the walk runs out of parents (e.g. when invoked from an unexpected
 * layout) we fall back to `process.cwd()` — at that point the
 * peer-directory convention won't help anyway and the caller should
 * pass `--hardhat-tests-path` / `--k6-tests-path` explicitly.
 *
 * Exposed for diagnostic logging and tests that want to override the
 * anchor without poking around in `import.meta.url`.
 */
export function defaultRepoRoot(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 10; i++) {
      const manifestPath = resolvePath(dir, "package.json");
      if (existsSync(manifestPath)) {
        try {
          // Cheap text-only check to avoid pulling in a JSON loader; the
          // manifest is small so reading it as a string is fine.
          const text = readFileSync(manifestPath, "utf8");
          if (text.includes('"name": "rskj-regression"')) {
            return dir;
          }
        } catch {
          // Ignore — keep walking up.
        }
      }
      const parent = resolvePath(dir, "..");
      if (parent === dir) break; // Hit the filesystem root.
      dir = parent;
    }
  } catch {
    // Fall through.
  }
  return process.cwd();
}
