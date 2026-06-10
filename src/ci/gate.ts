/**
 * CI verdict gate — the structured pass/fail decision a regression run is
 * gated on, enforcing the four hardening rules the mining-model spike
 * surfaced. These exist because the spike showed a run can "complete" while
 * being silently broken:
 *
 *   1. GATE ON PROCESS HEALTH, NOT JUST THE SUITE VERDICT. A candidate
 *      SIGSEGV'd in librocksdbjni (exit 1, metrics missing) yet the run
 *      still reported "completed". So: fail on a non-zero process exit, on
 *      native crashes (SIGSEGV/SIGABRT/hs_err), and on missing/empty report
 *      artifacts — independently of test pass/fail.
 *   2. DON'T TRUST LOG-GREP FOR HEALTH. `log_errors=0` was a grep artifact
 *      that missed 1,982 baseEvent WARNs. Health is judged from STRUCTURED
 *      signals — the report's `errored`/`failed` counts and artifact
 *      presence — never from grepping logs for " ERROR ". (We DO scan logs,
 *      but only for unambiguous native-CRASH markers, a different thing from
 *      using a log line as a health proxy.)
 *   3. REPORT ASSEMBLY MUST BE LOSS-LESS. The spike's combine step silently
 *      dropped 1 of 4 candidates when one crashed. So: every suite the
 *      preset was expected to produce MUST be present in the report; a
 *      missing suite fails the gate loudly rather than passing a partial
 *      (green-looking) report.
 *   4. EXACT-K is enforced upstream (the orchestrator mines serialized and
 *      asserts +1 per call; the exact-K spike is the gate for Model B). The
 *      CI gate's contribution is to confirm the run that depends on it
 *      actually produced every expected suite and crashed nowhere.
 *
 * `evaluateGate` is a pure function over already-collected inputs so it is
 * exhaustively unit-testable; the disk/scan I/O lives in `runGate`.
 */

import type { UnifiedReport } from "../report/schema.js";

/** JVM/native crash signatures scanned for in captured process logs. */
export const CRASH_MARKERS = [
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "hs_err_pid",
  "A fatal error has been detected by the Java Runtime",
  "# Native frames:",
] as const;

export interface ProcessExit {
  name: string;
  /** Exit code; null means "not captured" (skipped, not a failure). */
  exitCode: number | null;
}

export interface LogCrashScan {
  file: string;
  /** Crash markers found in this file (empty = clean). */
  markersFound: string[];
}

export interface GateInput {
  /** Parsed report, or null when the artifact is missing/empty/unparseable. */
  report: UnifiedReport | null;
  /** Where the report was expected — surfaced in the failure message. */
  reportPath: string;
  /**
   * Suite names the preset was expected to produce. A run that is missing
   * any of these failed loss-lessly (rule 3) even if the suites it DID
   * produce all passed.
   */
  expectedSuites: string[];
  /** Process exits to gate on (rule 1). Non-zero fails. */
  processes?: ProcessExit[];
  /** Pre-scanned crash markers from captured logs (rule 1). */
  logScans?: LogCrashScan[];
}

export interface GateFailure {
  /** Which hardening rule tripped. */
  gate: "artifact" | "loss-less" | "structured-health" | "process-health" | "native-crash";
  detail: string;
}

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  summary: string;
}

/**
 * Decide the gate verdict from collected inputs. Pure — no I/O.
 *
 * The checks are independent and ALL run (we don't short-circuit) so the
 * failure list names every problem at once, not just the first.
 */
export function evaluateGate(input: GateInput): GateResult {
  const failures: GateFailure[] = [];

  // Rule 1a — artifact presence. A missing/empty/unparseable report is a
  // hard fail regardless of anything else (a green run with no report is
  // the silent-failure mode we most want to catch).
  if (input.report === null) {
    failures.push({
      gate: "artifact",
      detail: `no parseable report at ${input.reportPath} (missing, empty, or invalid JSON)`,
    });
  } else if (input.report.suites.length === 0) {
    failures.push({
      gate: "artifact",
      detail: `report at ${input.reportPath} contains zero suites`,
    });
  }

  // Rule 3 — loss-less assembly. Every expected suite must be present.
  if (input.report !== null) {
    const present = new Set(input.report.suites.map((s) => s.name));
    const missing = input.expectedSuites.filter((name) => !present.has(name));
    if (missing.length > 0) {
      failures.push({
        gate: "loss-less",
        detail:
          `expected suite(s) absent from the report: ${missing.join(", ")} ` +
          `(present: ${[...present].join(", ") || "none"})`,
      });
    }
  }

  // Rule 2 — structured health (NOT log-grep). Judge from the report's own
  // counts: any errored or failed test, or a non-passing overall verdict.
  if (input.report !== null) {
    for (const suite of input.report.suites) {
      if (suite.verdict.errored > 0) {
        failures.push({
          gate: "structured-health",
          detail: `suite "${suite.name}" reports ${suite.verdict.errored} errored test(s)`,
        });
      }
      if (suite.verdict.failed > 0) {
        failures.push({
          gate: "structured-health",
          detail: `suite "${suite.name}" reports ${suite.verdict.failed} failed test(s)`,
        });
      }
    }
    if (!input.report.overall.passed_overall) {
      failures.push({
        gate: "structured-health",
        detail: "report overall verdict is not passed_overall",
      });
    }
  }

  // Rule 1b — process health. Any non-zero exit fails (a crashed JVM at
  // teardown must fail the run even if its suite "passed").
  for (const proc of input.processes ?? []) {
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      failures.push({
        gate: "process-health",
        detail: `process "${proc.name}" exited with code ${proc.exitCode}`,
      });
    }
  }

  // Rule 1c — native crashes. Any crash marker in captured logs fails the
  // run independently of the suite verdict.
  for (const scan of input.logScans ?? []) {
    if (scan.markersFound.length > 0) {
      failures.push({
        gate: "native-crash",
        detail: `native crash signature(s) in ${scan.file}: ${[...new Set(scan.markersFound)].join(", ")}`,
      });
    }
  }

  const passed = failures.length === 0;
  const summary = passed
    ? `GATE PASS — report present, ${input.report?.suites.length ?? 0} suite(s), all expected suites produced, no errored/failed tests, no crashes`
    : `GATE FAIL — ${failures.length} problem(s): ${failures.map((f) => f.gate).join(", ")}`;
  return { passed, failures, summary };
}
