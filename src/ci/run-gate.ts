/**
 * Disk-backed entry for the CI verdict gate. Reads a run's `report.json`,
 * scans a logs directory for native-crash markers, then defers to the pure
 * {@link evaluateGate}. Kept thin so the decision logic stays unit-tested
 * without touching the filesystem.
 *
 * Usage (from the regression workflow, after the driver run):
 *
 *   node dist/src/ci/run-gate.js \
 *     --report reports/<run-id>/report.json \
 *     --logs-dir reports/<run-id> \
 *     --expect hardhat-smoke,k6-eth_blockNumber,rit-2wp-smoke \
 *     [--driver-exit <code>] [--summary-file $GITHUB_STEP_SUMMARY]
 *
 * Exit code: 0 when the gate passes, 1 when it fails, 2 on bad arguments.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnifiedReport } from "../report/schema.js";
import {
  CRASH_MARKERS,
  evaluateGate,
  type GateInput,
  type GateResult,
  type LogCrashScan,
  type ProcessExit,
} from "./gate.js";

export interface RunGateOptions {
  reportPath: string;
  logsDir?: string;
  expectedSuites: string[];
  processes?: ProcessExit[];
  /** Path to write a Markdown summary (e.g. `$GITHUB_STEP_SUMMARY`). */
  summaryFile?: string;
}

export interface RunGateSeams {
  readFileFn?: (p: string) => string;
  existsFn?: (p: string) => boolean;
  listLogFilesFn?: (dir: string) => string[];
  writeFileFn?: (p: string, contents: string) => void;
  log?: (line: string) => void;
}

/** Default: recursively collect readable text-log files under `dir`. */
function defaultListLogFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(log|txt|out)$/.test(entry.name) || entry.name.startsWith("hs_err_pid")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** Parse `report.json`, returning null on any read/parse failure. */
function loadReport(
  reportPath: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string,
): UnifiedReport | null {
  if (!existsFn(reportPath)) return null;
  let raw: string;
  try {
    raw = readFileFn(reportPath);
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as UnifiedReport;
  } catch {
    return null;
  }
}

/** Scan one file's content for any crash marker. */
function scanForCrashMarkers(content: string): string[] {
  return CRASH_MARKERS.filter((marker) => content.includes(marker));
}

/**
 * Collect inputs from disk and evaluate the gate. Also writes a Markdown
 * summary when `summaryFile` is given. Returns the structured result.
 */
export function runGate(options: RunGateOptions, seams: RunGateSeams = {}): GateResult {
  const readFileFn = seams.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const existsFn = seams.existsFn ?? existsSync;
  const listLogFilesFn = seams.listLogFilesFn ?? defaultListLogFiles;
  const writeFileFn =
    seams.writeFileFn ?? ((p: string, c: string): void => writeFileSync(p, c, "utf8"));
  const log = seams.log ?? ((line: string) => console.log(line));

  const report = loadReport(options.reportPath, existsFn, readFileFn);

  const logScans: LogCrashScan[] = [];
  if (options.logsDir && existsFn(options.logsDir)) {
    for (const file of listLogFilesFn(options.logsDir)) {
      let content: string;
      try {
        content = readFileFn(file);
      } catch {
        continue;
      }
      const markersFound = scanForCrashMarkers(content);
      if (markersFound.length > 0) {
        logScans.push({ file, markersFound });
      }
    }
  }

  const input: GateInput = {
    report,
    reportPath: options.reportPath,
    expectedSuites: options.expectedSuites,
    processes: options.processes,
    logScans,
  };
  const result = evaluateGate(input);

  log(result.summary);
  for (const failure of result.failures) {
    log(`  [${failure.gate}] ${failure.detail}`);
  }

  if (options.summaryFile) {
    writeFileFn(options.summaryFile, renderSummaryMarkdown(result, report));
  }
  return result;
}

/** Render a GitHub-step-summary-friendly Markdown block. */
export function renderSummaryMarkdown(result: GateResult, report: UnifiedReport | null): string {
  const lines: string[] = [];
  lines.push(`## Regression gate: ${result.passed ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");
  if (report) {
    const o = report.overall;
    lines.push(`| Suite | Total | Passed | Failed | Errored | Skipped |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const suite of report.suites) {
      const v = suite.verdict;
      lines.push(
        `| ${suite.name} | ${v.total} | ${v.passed} | ${v.failed} | ${v.errored} | ${v.skipped} |`,
      );
    }
    lines.push(
      `| **overall** | **${o.total}** | **${o.passed}** | **${o.failed}** | **${o.errored}** | **${o.skipped}** |`,
    );
    lines.push("");
    lines.push(`Run duration: ${Math.round(o.durationMs / 1000)}s`);
  } else {
    lines.push(`> No parseable report was produced.`);
  }
  if (result.failures.length > 0) {
    lines.push("");
    lines.push(`### Gate failures`);
    for (const failure of result.failures) {
      lines.push(`- **${failure.gate}** — ${failure.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- *
 * CLI
 * -------------------------------------------------------------------------- */

interface CliArgs {
  reportPath: string;
  logsDir?: string;
  expectedSuites: string[];
  processes: ProcessExit[];
  summaryFile?: string;
}

export function parseGateArgs(argv: string[]): CliArgs {
  const args: CliArgs = { reportPath: "", expectedSuites: [], processes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--report") args.reportPath = next();
    else if (arg === "--logs-dir") args.logsDir = next();
    else if (arg === "--expect") args.expectedSuites = next().split(",").filter(Boolean);
    else if (arg === "--driver-exit")
      args.processes.push({ name: "driver", exitCode: Number(next()) });
    else if (arg === "--process-exit") {
      // form: --process-exit name=code
      const [name, code] = next().split("=");
      args.processes.push({ name: name ?? "process", exitCode: Number(code) });
    } else if (arg === "--summary-file") args.summaryFile = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.reportPath) throw new Error("--report <path> is required");
  return args;
}

/** Process entry. Returns the process exit code. */
export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseGateArgs(argv);
  } catch (err) {
    console.error(`gate: ${(err as Error).message}`);
    return 2;
  }
  const result = runGate({
    reportPath: args.reportPath,
    logsDir: args.logsDir,
    expectedSuites: args.expectedSuites,
    processes: args.processes,
    summaryFile: args.summaryFile,
  });
  return result.passed ? 0 : 1;
}

// Executed directly (node dist/src/ci/run-gate.js ...).
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("run-gate.js")) {
  process.exitCode = main(process.argv.slice(2));
}
