/**
 * Markdown summary emitter for the unified report.
 *
 * Produces a single Markdown document suitable for:
 *   - Pasting into a GitHub PR comment.
 *   - Rendering as `$GITHUB_STEP_SUMMARY` in GitHub Actions.
 *   - Reading directly in a terminal (no HTML fallbacks, no inline styling).
 *
 * Document layout:
 *   1. Title with overall pass / fail badge.
 *   2. Metadata block (rskj version, network, RPC URL, timestamps).
 *   3. Per-suite table (verdict, counts, duration).
 *   4. Failure detail section — one block per failing test, with file,
 *      classname, error message, and stack (truncated to a sensible
 *      line cap to keep PR comments readable).
 */

import type { UnifiedReport, UnifiedSuite, UnifiedTestCase } from "./schema.js";

const STACK_LINE_CAP = 20;

/** Render a duration in ms as a short, human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/** "PASSED" / "FAILED" badge with an emoji. */
function verdictBadge(passed: boolean): string {
  return passed ? "✅ PASSED" : "❌ FAILED";
}

/** Escape pipe characters that would break a Markdown table cell. */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render the run-level metadata block as a bullet list. */
function renderMetadata(report: UnifiedReport): string {
  const lines: string[] = [];
  const meta = report.metadata;
  if (meta.runId) lines.push(`- **Run ID:** \`${meta.runId}\``);
  if (meta.rskjVersion) lines.push(`- **rskj version:** \`${meta.rskjVersion}\``);
  if (meta.network) lines.push(`- **Network:** \`${meta.network}\``);
  if (meta.rpcUrl) lines.push(`- **RPC URL:** \`${meta.rpcUrl}\``);
  lines.push(`- **Started:** \`${meta.startedAt}\``);
  if (meta.endedAt) lines.push(`- **Ended:** \`${meta.endedAt}\``);
  lines.push(`- **Duration:** ${formatDuration(report.overall.durationMs)}`);
  if (meta.labels && Object.keys(meta.labels).length > 0) {
    const labels = Object.entries(meta.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`- **Labels:** ${labels}`);
  }
  return lines.join("\n");
}

/** Render the per-suite table. */
function renderSuiteTable(suites: UnifiedSuite[]): string {
  const header = [
    "| Suite | Kind | Verdict | Total | Passed | Failed | Skipped | Errored | Duration |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const rows = suites.map((s) => {
    const v = s.verdict;
    return [
      `| ${tableCell(s.name)}`,
      `${s.kind}`,
      verdictBadge(v.passed_overall),
      `${v.total}`,
      `${v.passed}`,
      `${v.failed}`,
      `${v.skipped}`,
      `${v.errored}`,
      `${formatDuration(v.durationMs)} |`,
    ].join(" | ");
  });
  return [...header, ...rows].join("\n");
}

/** Truncate a stack trace to keep PR comments compact. */
function truncateStack(stack: string): string {
  const lines = stack.split("\n");
  if (lines.length <= STACK_LINE_CAP) return stack;
  return (
    lines.slice(0, STACK_LINE_CAP).join("\n") +
    `\n... (${lines.length - STACK_LINE_CAP} more lines)`
  );
}

/** Render one failing-test detail block. */
function renderFailure(suite: UnifiedSuite, test: UnifiedTestCase): string {
  const lines: string[] = [];
  const label = test.status === "error" ? "ERROR" : "FAILURE";
  lines.push(
    `### ${label}: \`${suite.name}\` › ${test.classname ? `${test.classname} › ` : ""}${test.name}`,
  );
  if (test.file) lines.push(`- **File:** \`${test.file}\``);
  lines.push(`- **Duration:** ${formatDuration(test.durationMs)}`);
  if (test.failure?.type) lines.push(`- **Type:** \`${test.failure.type}\``);
  if (test.failure?.message) {
    lines.push("");
    lines.push("```");
    lines.push(test.failure.message);
    lines.push("```");
  }
  if (test.failure?.stack) {
    lines.push("");
    lines.push("<details><summary>Stack trace</summary>");
    lines.push("");
    lines.push("```");
    lines.push(truncateStack(test.failure.stack));
    lines.push("```");
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n");
}

/**
 * Render a {@link UnifiedReport} as a Markdown document.
 *
 * @returns A Markdown string ending in a single trailing newline.
 */
export function renderMarkdown(report: UnifiedReport): string {
  const sections: string[] = [];

  // Title + overall badge
  sections.push(`# Regression report — ${verdictBadge(report.overall.passed_overall)}`);
  sections.push("");

  // Run-level metadata
  sections.push("## Run");
  sections.push("");
  sections.push(renderMetadata(report));
  sections.push("");

  // Overall counts
  const o = report.overall;
  sections.push("## Overall verdict");
  sections.push("");
  sections.push(
    `**${verdictBadge(o.passed_overall)}** — ${o.passed}/${o.total} passed, ${o.failed} failed, ${o.errored} errored, ${o.skipped} skipped.`,
  );
  sections.push("");

  // Per-suite table
  sections.push("## Suites");
  sections.push("");
  if (report.suites.length === 0) {
    sections.push("_No suites were executed._");
  } else {
    sections.push(renderSuiteTable(report.suites));
  }
  sections.push("");

  // Failure detail
  const failures: Array<{ suite: UnifiedSuite; test: UnifiedTestCase }> = [];
  for (const suite of report.suites) {
    for (const test of suite.tests) {
      if (test.status === "failed" || test.status === "error") {
        failures.push({ suite, test });
      }
    }
  }
  if (failures.length > 0) {
    sections.push("## Failures");
    sections.push("");
    for (const { suite, test } of failures) {
      sections.push(renderFailure(suite, test));
      sections.push("");
    }
  }

  return sections.join("\n").replace(/\n+$/u, "") + "\n";
}
