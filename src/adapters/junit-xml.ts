/**
 * JUnit XML → {@link UnifiedSuite}[] adapter.
 *
 * Handles the Surefire / Maven flavour of JUnit XML that mocha's built-in
 * `xunit` reporter, `mocha-junit-reporter`, k6's `--out junit`, and most
 * pytest / Jest reporters emit. Recognised shapes:
 *
 *   - A single root `<testsuite>` element (mocha xunit).
 *   - A `<testsuites>` root wrapping one or more `<testsuite>` elements
 *     (mocha-junit-reporter, k6).
 *
 * Recognised child elements per `<testcase>`:
 *   - `<failure ...>...</failure>` — in-test assertion failure.
 *   - `<error ...>...</error>` — process-level error.
 *   - `<skipped/>` or `<skipped>...</skipped>` — skipped test.
 *
 * Times are normalised from JUnit's seconds-with-fractional to milliseconds.
 *
 * The adapter is dependency-free — we parse with a hand-rolled tokeniser
 * because the XML we consume is machine-generated and the surface is small.
 * If we ever need full XML 1.0 coverage we can swap in `fast-xml-parser`.
 */

import {
  computeSuiteVerdict,
  type SuiteKind,
  type UnifiedSuite,
  type UnifiedTestCase,
  type TestStatus,
  type UnifiedFailure,
} from "../report/schema.js";

interface JUnitFailureNode {
  tag: "failure" | "error" | "skipped";
  attrs: Record<string, string>;
  text: string;
}

interface JUnitTestCase {
  attrs: Record<string, string>;
  children: JUnitFailureNode[];
}

interface JUnitTestSuite {
  attrs: Record<string, string>;
  testcases: JUnitTestCase[];
}

/* -------------------------------------------------------------------------- *
 * Tokeniser
 * -------------------------------------------------------------------------- */

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match name="value" or name='value'
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const key = m[1] ?? "";
    const value = m[3] ?? m[4] ?? "";
    attrs[key] = decodeXmlEntities(value);
  }
  return attrs;
}

interface OpenTag {
  type: "open";
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}
interface CloseTag {
  type: "close";
  name: string;
}
interface TextNode {
  type: "text";
  text: string;
}
type Token = OpenTag | CloseTag | TextNode;

function tokenise(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== "<") {
      // Text until next "<"
      const start = i;
      while (i < n && xml[i] !== "<") i++;
      const text = xml.slice(start, i);
      if (text.trim().length > 0) {
        tokens.push({ type: "text", text: decodeXmlEntities(text) });
      }
      continue;
    }
    // Skip XML declaration / comments / doctype
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0) break;
      const text = xml.slice(i + 9, end);
      tokens.push({ type: "text", text });
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i + 2);
      if (end < 0) break;
      const name = xml.slice(i + 2, end).trim();
      tokens.push({ type: "close", name });
      i = end + 1;
      continue;
    }
    // Open / self-closing tag
    const end = xml.indexOf(">", i + 1);
    if (end < 0) break;
    const inner = xml.slice(i + 1, end);
    const selfClosing = inner.endsWith("/");
    const head = selfClosing ? inner.slice(0, -1) : inner;
    const spaceIdx = head.search(/\s/);
    let name: string;
    let attrText: string;
    if (spaceIdx < 0) {
      name = head.trim();
      attrText = "";
    } else {
      name = head.slice(0, spaceIdx);
      attrText = head.slice(spaceIdx + 1);
    }
    tokens.push({
      type: "open",
      name,
      attrs: parseAttributes(attrText),
      selfClosing,
    });
    i = end + 1;
  }
  return tokens;
}

/* -------------------------------------------------------------------------- *
 * Tree builder — small and tailored to JUnit shape (testsuites / testsuite /
 * testcase / failure|error|skipped|system-out|system-err).
 * -------------------------------------------------------------------------- */

interface ParseResult {
  suites: JUnitTestSuite[];
}

/**
 * Parse a JUnit XML string into intermediate {@link JUnitTestSuite}s.
 *
 * @throws Error if the document doesn't contain at least one `<testsuite>`.
 */
export function parseJUnitXml(xml: string): ParseResult {
  const tokens = tokenise(xml);
  const suites: JUnitTestSuite[] = [];
  let currentSuite: JUnitTestSuite | null = null;
  let currentCase: JUnitTestCase | null = null;
  let currentFailure: JUnitFailureNode | null = null;

  for (const tok of tokens) {
    if (tok.type === "open") {
      switch (tok.name) {
        case "testsuite":
          currentSuite = { attrs: tok.attrs, testcases: [] };
          suites.push(currentSuite);
          if (tok.selfClosing) currentSuite = null;
          break;
        case "testcase":
          if (currentSuite) {
            currentCase = { attrs: tok.attrs, children: [] };
            currentSuite.testcases.push(currentCase);
            if (tok.selfClosing) currentCase = null;
          }
          break;
        case "failure":
        case "error":
        case "skipped":
          if (currentCase) {
            currentFailure = { tag: tok.name, attrs: tok.attrs, text: "" };
            currentCase.children.push(currentFailure);
            if (tok.selfClosing) currentFailure = null;
          }
          break;
        // system-out / system-err / properties: ignored
        default:
          break;
      }
    } else if (tok.type === "text") {
      if (currentFailure) {
        currentFailure.text += tok.text;
      }
    } else if (tok.type === "close") {
      switch (tok.name) {
        case "testsuite":
          currentSuite = null;
          break;
        case "testcase":
          currentCase = null;
          break;
        case "failure":
        case "error":
        case "skipped":
          currentFailure = null;
          break;
        default:
          break;
      }
    }
  }

  if (suites.length === 0) {
    throw new Error("JUnit XML adapter: no <testsuite> elements found in input");
  }
  return { suites };
}

/* -------------------------------------------------------------------------- *
 * Intermediate → Unified
 * -------------------------------------------------------------------------- */

function secondsToMs(seconds: string | undefined): number {
  if (!seconds) return 0;
  const n = Number(seconds);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

function pickStatus(testcase: JUnitTestCase): TestStatus {
  for (const child of testcase.children) {
    if (child.tag === "error") return "error";
    if (child.tag === "failure") return "failed";
    if (child.tag === "skipped") return "skipped";
  }
  return "passed";
}

function buildFailure(testcase: JUnitTestCase): UnifiedFailure | undefined {
  const child = testcase.children.find((c) => c.tag === "failure" || c.tag === "error");
  if (!child) return undefined;
  const message = child.attrs["message"] ?? (child.text.split("\n")[0] || "").trim();
  const type = child.attrs["type"];
  const stack = child.text.trim() || undefined;
  return {
    message: message || "(no message)",
    ...(type ? { type } : {}),
    ...(stack ? { stack } : {}),
  };
}

function convertTestCase(tc: JUnitTestCase): UnifiedTestCase {
  const status = pickStatus(tc);
  const test: UnifiedTestCase = {
    name: tc.attrs["name"] ?? "(unnamed)",
    status,
    durationMs: secondsToMs(tc.attrs["time"]),
  };
  if (tc.attrs["classname"]) test.classname = tc.attrs["classname"];
  if (tc.attrs["file"]) test.file = tc.attrs["file"];
  if (status === "failed" || status === "error") {
    const failure = buildFailure(tc);
    if (failure) test.failure = failure;
  }
  return test;
}

/**
 * Options for {@link adaptJUnitXml}. Used to attach driver-level metadata
 * that JUnit XML itself doesn't carry.
 */
export interface JUnitAdapterOptions {
  /** Override the suite name (defaults to the `<testsuite name>` attribute). */
  suiteName?: string;
  /** Suite kind tag, default `"mocha"`. */
  kind?: SuiteKind;
  /** Optional description carried into the unified suite. */
  description?: string;
  /**
   * If multiple `<testsuite>` elements are present, the adapter normally
   * emits one {@link UnifiedSuite} per element. Set this to true to merge
   * them all into a single suite (named via `suiteName`) — useful when
   * a single logical suite (e.g. one hardhat run) emits multiple
   * `<testsuite>` nodes split by file.
   */
  merge?: boolean;
  /** Extra metadata attached to every emitted suite. */
  extras?: Record<string, unknown>;
}

/**
 * Adapt a JUnit XML document into {@link UnifiedSuite} objects.
 *
 * @param xml - The raw XML string.
 * @param options - Driver-level overrides for naming / kind / extras.
 * @returns One or more unified suites. The driver decides whether to
 *   embed them in a single report or split them by run.
 */
export function adaptJUnitXml(xml: string, options: JUnitAdapterOptions = {}): UnifiedSuite[] {
  const { suites } = parseJUnitXml(xml);
  const kind: SuiteKind = options.kind ?? "mocha";

  if (options.merge) {
    const allCases: UnifiedTestCase[] = [];
    let totalDuration = 0;
    let timestamp: string | undefined;
    for (const s of suites) {
      for (const tc of s.testcases) allCases.push(convertTestCase(tc));
      totalDuration += secondsToMs(s.attrs["time"]);
      if (!timestamp && s.attrs["timestamp"]) timestamp = s.attrs["timestamp"];
    }
    const suite: UnifiedSuite = {
      name: options.suiteName ?? suites[0]?.attrs["name"] ?? "junit",
      kind,
      verdict: computeSuiteVerdict(allCases, totalDuration),
      tests: allCases,
    };
    if (options.description) suite.description = options.description;
    if (timestamp) suite.startedAt = timestamp;
    if (options.extras) suite.extras = options.extras;
    return [suite];
  }

  return suites.map((s): UnifiedSuite => {
    const tests = s.testcases.map(convertTestCase);
    const durationMs = secondsToMs(s.attrs["time"]);
    const suite: UnifiedSuite = {
      name: options.suiteName ?? s.attrs["name"] ?? "junit",
      kind,
      verdict: computeSuiteVerdict(tests, durationMs),
      tests,
    };
    if (options.description) suite.description = options.description;
    if (s.attrs["timestamp"]) suite.startedAt = s.attrs["timestamp"];
    if (options.extras) suite.extras = options.extras;
    return suite;
  });
}

/**
 * Convenience: adapt a hardhat `mocha-junit-reporter` / `xunit` XML output.
 * The hardhat suites are kept as one logical {@link UnifiedSuite} so the
 * driver gets a single "hardhat-smoke" entry in the report.
 *
 * @param xml - Raw XML from `results/result.xml`.
 * @param suiteName - Defaults to `"hardhat-smoke"`. Override when running
 *   a different hardhat slice.
 */
export function adaptHardhatJUnit(
  xml: string,
  suiteName = "hardhat-smoke",
  extras?: Record<string, unknown>,
): UnifiedSuite {
  const [suite] = adaptJUnitXml(xml, {
    suiteName,
    kind: "hardhat",
    merge: true,
    extras,
  });
  if (!suite) {
    throw new Error("adaptHardhatJUnit: no suites produced");
  }
  return suite;
}
