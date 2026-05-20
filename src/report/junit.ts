/**
 * JUnit XML emitter for the unified report.
 *
 * Renders a {@link UnifiedReport} as a JUnit-compatible `<testsuites>` /
 * `<testsuite>` / `<testcase>` document. The shape matches what most CI
 * gating tools (GitHub Actions test-summary, Jenkins, GitLab, Buildkite,
 * etc.) consume by default — closest to the Jenkins / Surefire schema.
 *
 * JUnit is a lossier projection of the unified report:
 *   - Suite-level `extras` and per-test `extras` are dropped.
 *   - Skipped tests are represented by an empty `<skipped/>` child.
 *   - Process-level errors are represented by `<error/>` children;
 *     in-test failures use `<failure/>`. This matches the convention
 *     established by Surefire / Maven and respected by GitHub's
 *     test-summary action.
 *
 * Whitespace is normalised: the emitter writes pretty-printed XML so
 * checked-in samples diff cleanly across runs.
 */

import type { UnifiedReport, UnifiedSuite, UnifiedTestCase } from "./schema.js";

/** Format a duration in ms as JUnit's "seconds with fractional" form. */
function durationToSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3);
}

/** Escape a string for safe insertion into XML attribute values or text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render the body of a `<testcase>` (failure / error / skipped children). */
function renderTestCaseBody(test: UnifiedTestCase, indent: string): string {
  if (test.status === "passed") return "";
  if (test.status === "skipped") {
    return `\n${indent}<skipped/>`;
  }
  const failure = test.failure;
  const tag = test.status === "error" ? "error" : "failure";
  const attrs: string[] = [];
  if (failure?.message) {
    attrs.push(`message="${escapeXml(failure.message)}"`);
  }
  if (failure?.type) {
    attrs.push(`type="${escapeXml(failure.type)}"`);
  }
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  const inner = failure?.stack ? escapeXml(failure.stack) : "";
  return `\n${indent}<${tag}${attrStr}>${inner}</${tag}>`;
}

/** Render a single `<testcase>` element. */
function renderTestCase(test: UnifiedTestCase, indent: string): string {
  const attrs: string[] = [
    `name="${escapeXml(test.name)}"`,
    `time="${durationToSeconds(test.durationMs)}"`,
  ];
  if (test.classname) attrs.push(`classname="${escapeXml(test.classname)}"`);
  if (test.file) attrs.push(`file="${escapeXml(test.file)}"`);

  const body = renderTestCaseBody(test, indent + "  ");
  if (body === "") {
    return `${indent}<testcase ${attrs.join(" ")}/>`;
  }
  return `${indent}<testcase ${attrs.join(" ")}>${body}\n${indent}</testcase>`;
}

/** Render one `<testsuite>` element including its `<testcase>` children. */
function renderSuite(suite: UnifiedSuite, indent: string): string {
  const attrs: string[] = [
    `name="${escapeXml(suite.name)}"`,
    `tests="${suite.verdict.total}"`,
    `failures="${suite.verdict.failed}"`,
    `errors="${suite.verdict.errored}"`,
    `skipped="${suite.verdict.skipped}"`,
    `time="${durationToSeconds(suite.verdict.durationMs)}"`,
  ];
  if (suite.startedAt) attrs.push(`timestamp="${escapeXml(suite.startedAt)}"`);

  const cases = suite.tests.map((t) => renderTestCase(t, indent + "  ")).join("\n");
  if (cases === "") {
    return `${indent}<testsuite ${attrs.join(" ")}/>`;
  }
  return [`${indent}<testsuite ${attrs.join(" ")}>`, cases, `${indent}</testsuite>`].join("\n");
}

/**
 * Render a {@link UnifiedReport} as a JUnit XML document.
 *
 * @returns A pretty-printed XML string ending in a single trailing newline.
 *   Safe to write directly to disk; CI consumers don't care about
 *   leading whitespace.
 */
export function renderJUnitXml(report: UnifiedReport): string {
  const overall = report.overall;
  const rootAttrs: string[] = [
    `tests="${overall.total}"`,
    `failures="${overall.failed}"`,
    `errors="${overall.errored}"`,
    `skipped="${overall.skipped}"`,
    `time="${durationToSeconds(overall.durationMs)}"`,
  ];
  if (report.metadata.runId) rootAttrs.push(`name="${escapeXml(report.metadata.runId)}"`);

  const suites = report.suites.map((s) => renderSuite(s, "  ")).join("\n");

  return (
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites ${rootAttrs.join(" ")}>`,
      suites,
      `</testsuites>`,
    ].join("\n") + "\n"
  );
}
