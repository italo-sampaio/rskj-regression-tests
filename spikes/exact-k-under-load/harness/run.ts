/**
 * Exact-K-under-load validation harness — the Model B gate.
 *
 * Question under test: does `evm_mine` advance the chain by EXACTLY one
 * block per call while transactions are streaming in — the condition RIT
 * and the regression harness rely on, which the mining-model spike only
 * proved on an idle node?
 *
 * Source-level recon (2026-06-10) sharpened the risk model:
 *   - evm_mine consumes the SHARED volatile currentWork (no private
 *     snapshot), so the refresh race applies — but for SERIALIZED calls
 *     every racing rebuild shares the same parent, so the import should
 *     still be IMPORTED_BEST (+1). Empirical scenarios verify this.
 *   - CONCURRENT evm_mine calls share MinerClientImpl's `work` field and
 *     have no synchronization anywhere on the path — static analysis
 *     predicts siblings / swallowed PoW mismatches (height advances by
 *     less than the number of calls). Captured here as a reproducer.
 *   - All failures are SILENT (evm_mine returns null regardless), so a
 *     negative control forces a swallowed failure via the submission
 *     rate limiter and proves the per-call height oracle detects it.
 *
 * Run:  npx tsx spikes/exact-k-under-load/harness/run.ts [--jar <fatJar>]
 *         [--out <dir>] [--only <substring>] [--quick]
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRskjNode } from "../../../src/orchestrator/index.js";
import type { RskjNodeHandle } from "../../../src/orchestrator/index.js";
import { TxStream, type TxStreamStats } from "./load.js";
import { RpcClient, sleep } from "./rpc.js";
import {
  auditBlockRange,
  auditInclusion,
  drainPool,
  mineConcurrentRound,
  mineSerialized,
  scanRskLog,
  type ConcurrentRoundRecord,
  type InclusionAudit,
  type LogScan,
  type PerCallRecord,
} from "./scenario.js";

const DEFAULT_JAR = "/home/italo/workspace/rskj/artifacts/rsk.jar";
const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Baseline node config for Model B. The orchestrator's own default turns
 * the autominer ON (its baseline targets the driver's auto-node use case),
 * so `miner.client.enabled=false` here is load-bearing — the idle-drift
 * guard in every scenario verifies it took effect.
 */
const MODEL_B_OVERRIDES: Record<string, unknown> = {
  "miner.client.enabled": false,
  "miner.client.autoMine": false,
  "miner.server.enabled": true,
  "miner.server.updateWorkOnNewTransaction": false,
  "miner.server.workSubmissionRateLimitInMills": 0,
  "miner.minGasPrice": 0,
  "transaction.accountTxRateLimit.enabled": false,
};

type ScenarioKind =
  | { kind: "serialized"; trials: number; callsPerTrial: number; callDelayMs: number }
  | { kind: "soak"; durationMs: number; callIntervalMs: number }
  | { kind: "concurrent"; rounds: { callers: number; repeats: number }[]; tailSerialized: number }
  | { kind: "ratelimit"; calls: number };

type Expectation = "exact" | "informational" | "detects-silent-failure";

interface ScenarioDef {
  name: string;
  description: string;
  overrides: Record<string, unknown>;
  load: { intervalMs: number; maxInFlightPerAccount: number } | null;
  expectation: Expectation;
  shape: ScenarioKind;
}

function scenarioMatrix(quick: boolean): ScenarioDef[] {
  const trials = quick ? 1 : 5;
  const k = quick ? 10 : 50;
  const load = { intervalMs: 25, maxInFlightPerAccount: 14 };
  return [
    {
      name: "baseline-idle",
      description: "Spike-T4 parity: serialized exact-K on an idle node.",
      overrides: {},
      load: null,
      expectation: "exact",
      shape: { kind: "serialized", trials: quick ? 1 : 3, callsPerTrial: 20, callDelayMs: 0 },
    },
    {
      name: "negative-control-ratelimit",
      description:
        "Forces the swallowed-failure mode (submission rate limiter) to prove the " +
        "per-call height oracle detects silent +0 mines. PASSES when +0 calls are observed.",
      overrides: { "miner.server.workSubmissionRateLimitInMills": 60000 },
      load: null,
      expectation: "detects-silent-failure",
      shape: { kind: "ratelimit", calls: 4 },
    },
    {
      name: "load-serial-refresh-off",
      description: "Serialized exact-K under steady tx load, updateWorkOnNewTransaction=false.",
      overrides: {},
      load,
      expectation: "exact",
      shape: { kind: "serialized", trials, callsPerTrial: k, callDelayMs: 50 },
    },
    {
      name: "load-serial-refresh-on",
      description:
        "Serialized exact-K under steady tx load with updateWorkOnNewTransaction=true — " +
        "every accepted tx rebuilds currentWork on the async EventDispatchThread.",
      overrides: { "miner.server.updateWorkOnNewTransaction": true },
      load,
      expectation: "exact",
      shape: { kind: "serialized", trials, callsPerTrial: k, callDelayMs: 50 },
    },
    {
      name: "load-rapidfire-refresh-on",
      description:
        "Zero inter-call delay + max flood: densest interleaving of work rebuilds with " +
        "the buildBlockToMine -> getWork -> submit window.",
      overrides: { "miner.server.updateWorkOnNewTransaction": true },
      load: { intervalMs: 5, maxInFlightPerAccount: 14 },
      expectation: "exact",
      shape: {
        kind: "serialized",
        trials: quick ? 1 : 3,
        callsPerTrial: quick ? 20 : 100,
        callDelayMs: 0,
      },
    },
    {
      name: "soak-refresh-tick",
      description:
        "Soak past the hardcoded 60s RefreshBlock timer (2+ ticks) with a non-empty txpool, " +
        "updateWorkOnNewTransaction=true.",
      overrides: { "miner.server.updateWorkOnNewTransaction": true },
      load,
      expectation: "exact",
      shape: {
        kind: "soak",
        durationMs: quick ? 70_000 : 150_000,
        callIntervalMs: 1_500,
      },
    },
    {
      name: "concurrent-callers",
      description:
        "Parallel evm_mine callers (no load). Static analysis predicts exact-K violations " +
        "(shared MinerClientImpl.work field) — this scenario captures the reproducer.",
      overrides: {},
      load: null,
      expectation: "informational",
      shape: {
        kind: "concurrent",
        rounds: quick
          ? [
              { callers: 2, repeats: 5 },
              { callers: 4, repeats: 5 },
            ]
          : [
              { callers: 2, repeats: 15 },
              { callers: 4, repeats: 15 },
              { callers: 8, repeats: 10 },
            ],
        tailSerialized: 3,
      },
    },
    {
      name: "concurrent-callers-load",
      description: "Parallel evm_mine callers with tx load and updateWorkOnNewTransaction=true.",
      overrides: { "miner.server.updateWorkOnNewTransaction": true },
      load,
      expectation: "informational",
      shape: {
        kind: "concurrent",
        rounds: [{ callers: 4, repeats: quick ? 5 : 15 }],
        tailSerialized: 3,
      },
    },
  ];
}

interface ScenarioOutcome {
  name: string;
  description: string;
  expectation: Expectation;
  verdict: "PASS" | "FAIL" | "INFO";
  failures: string[];
  observations: string[];
  idleDriftBlocks: number | null;
  serializedRecords?: PerCallRecord[][];
  concurrentRounds?: ConcurrentRoundRecord[];
  loadStats?: Omit<TxStreamStats, "acceptedHashes">;
  inclusion?: InclusionAudit;
  blockAudit?: {
    blockCount: number;
    totalTxs: number;
    nonEmptyBlocks: number;
    totalUncles: number;
    lineageBreaks: string[];
  };
  drainMines?: number;
  logScan?: LogScan;
  durationMs: number;
  crash?: string;
}

interface HarnessOptions {
  jar: string;
  outDir: string;
  only: string | null;
  quick: boolean;
}

function parseArgs(argv: string[]): HarnessOptions {
  const options: HarnessOptions = {
    jar: DEFAULT_JAR,
    outDir: path.join(SPIKE_ROOT, "results", new Date().toISOString().replace(/[:.]/g, "-")),
    only: null,
    quick: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--jar") options.jar = argv[++i] ?? options.jar;
    else if (arg === "--out") options.outDir = path.resolve(argv[++i] ?? options.outDir);
    else if (arg === "--only") options.only = argv[++i] ?? null;
    else if (arg === "--quick") options.quick = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

async function runScenario(def: ScenarioDef, options: HarnessOptions): Promise<ScenarioOutcome> {
  const startedAt = performance.now();
  const outcome: ScenarioOutcome = {
    name: def.name,
    description: def.description,
    expectation: def.expectation,
    verdict: "FAIL",
    failures: [],
    observations: [],
    idleDriftBlocks: null,
    durationMs: 0,
  };
  const scenarioDir = path.join(options.outDir, def.name);
  const logsDir = path.join(scenarioDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  let node: RskjNodeHandle | null = null;
  let nodeLog: WriteStream | null = null;
  let stream: TxStream | null = null;
  try {
    nodeLog = createWriteStream(path.join(scenarioDir, "node.log"));
    node = await startRskjNode({
      jarPath: options.jar,
      configOverrides: { ...MODEL_B_OVERRIDES, ...def.overrides },
      jvmArgs: [`-Dlogging.dir=${logsDir}`],
      log: (line) => {
        nodeLog?.write(`${line}\n`);
      },
    });
    await node.ready();
    const rpc = new RpcClient(node.rpcUrl);

    // Idle-drift guard: with the autominer overridden OFF, height must not
    // move on its own. A drifting node invalidates every assertion below.
    const driftStart = await rpc.blockNumber();
    await sleep(5_000);
    outcome.idleDriftBlocks = (await rpc.blockNumber()) - driftStart;
    if (outcome.idleDriftBlocks !== 0) {
      outcome.failures.push(
        `idle drift: height moved by ${outcome.idleDriftBlocks} with no evm_mine — ` +
          "autominer override did not take effect",
      );
      return outcome;
    }

    const accounts = await rpc.accounts();
    if (def.load !== null) {
      if (accounts.length < 2) {
        outcome.failures.push(`expected unlocked cow accounts, eth_accounts -> ${accounts.length}`);
        return outcome;
      }
      stream = new TxStream(rpc, accounts, def.load);
      await stream.start();
    }

    const scenarioStartHeight = await rpc.blockNumber();

    if (def.shape.kind === "serialized") {
      const allTrials: PerCallRecord[][] = [];
      for (let t = 0; t < def.shape.trials; t++) {
        allTrials.push(await mineSerialized(rpc, def.shape.callsPerTrial, def.shape.callDelayMs));
      }
      outcome.serializedRecords = allTrials;
    } else if (def.shape.kind === "soak") {
      const records: PerCallRecord[] = [];
      const soakStart = performance.now();
      while (performance.now() - soakStart < def.shape.durationMs) {
        records.push(...(await mineSerialized(rpc, 1, 0)));
        await sleep(def.shape.callIntervalMs);
      }
      outcome.serializedRecords = [records];
      outcome.observations.push(
        `soak covered ${Math.round((performance.now() - soakStart) / 1000)}s ` +
          `(${records.length} mines) — >=2 RefreshBlock ticks interleaved`,
      );
    } else if (def.shape.kind === "concurrent") {
      const rounds: ConcurrentRoundRecord[] = [];
      for (const spec of def.shape.rounds) {
        for (let r = 0; r < spec.repeats; r++) {
          rounds.push(await mineConcurrentRound(rpc, spec.callers));
        }
      }
      outcome.concurrentRounds = rounds;
      // Tail mines give any sibling a chance to surface as an uncle.
      outcome.serializedRecords = [await mineSerialized(rpc, def.shape.tailSerialized, 0)];
    } else {
      // ratelimit negative control: rapid serialized calls against a 60s limiter.
      outcome.serializedRecords = [await mineSerialized(rpc, def.shape.calls, 0)];
    }

    if (stream !== null) {
      const stats = await stream.stop();
      stream = null;
      outcome.loadStats = {
        attempted: stats.attempted,
        accepted: stats.accepted,
        errorsByKind: stats.errorsByKind,
      };
      outcome.drainMines = await drainPool(rpc, 80);
      const endHeight = await rpc.blockNumber();
      const audit = await auditBlockRange(rpc, scenarioStartHeight, endHeight);
      outcome.blockAudit = {
        blockCount: audit.blockCount,
        totalTxs: audit.totalTxs,
        nonEmptyBlocks: audit.nonEmptyBlocks,
        totalUncles: audit.totalUncles,
        lineageBreaks: audit.lineageBreaks,
      };
      outcome.inclusion = await auditInclusion(rpc, stats.acceptedHashes, audit.txLocations);
    } else {
      const endHeight = await rpc.blockNumber();
      const audit = await auditBlockRange(rpc, scenarioStartHeight, endHeight);
      outcome.blockAudit = {
        blockCount: audit.blockCount,
        totalTxs: audit.totalTxs,
        nonEmptyBlocks: audit.nonEmptyBlocks,
        totalUncles: audit.totalUncles,
        lineageBreaks: audit.lineageBreaks,
      };
    }
  } catch (error) {
    outcome.crash = error instanceof Error ? (error.stack ?? error.message) : String(error);
    outcome.failures.push(`scenario crashed: ${String(error)}`);
  } finally {
    if (stream !== null) {
      await stream.stop().catch(() => undefined);
    }
    if (node !== null) {
      await node.stop().catch(() => undefined);
    }
    nodeLog?.end();
  }

  outcome.logScan = await scanRskLog(logsDir);
  grade(def, outcome);
  outcome.durationMs = Math.round(performance.now() - startedAt);
  return outcome;
}

function grade(def: ScenarioDef, outcome: ScenarioOutcome): void {
  if (outcome.crash !== undefined) {
    outcome.verdict = "FAIL";
    return;
  }
  const serialized = outcome.serializedRecords?.flat() ?? [];
  const nonPlusOne = serialized.filter((record) => record.delta !== 1);

  if (def.expectation === "detects-silent-failure") {
    // The limiter must produce at least one silently-swallowed +0 mine,
    // and the oracle must see it. If every call advanced, the control
    // failed to demonstrate detection.
    const zeroes = serialized.filter((record) => record.delta === 0).length;
    if (zeroes > 0) {
      outcome.observations.push(
        `oracle detected ${zeroes}/${serialized.length} silently swallowed mines (expected)`,
      );
      outcome.verdict = "PASS";
    } else {
      outcome.failures.push(
        "rate limiter did not produce a detectable +0 mine — control is inconclusive",
      );
      outcome.verdict = "FAIL";
    }
    return;
  }

  if (def.expectation === "informational") {
    const rounds = outcome.concurrentRounds ?? [];
    const lost = rounds.reduce((sum, round) => sum + (round.callers - round.delta), 0);
    const totalCalls = rounds.reduce((sum, round) => sum + round.callers, 0);
    outcome.observations.push(
      `concurrent rounds: ${rounds.length}, calls ${totalCalls}, blocks lost ${lost}` +
        ` (${rounds.filter((round) => round.delta !== round.callers).length} rounds violated exact-K)`,
    );
    if ((outcome.blockAudit?.totalUncles ?? 0) > 0) {
      outcome.observations.push(
        `uncles observed: ${outcome.blockAudit?.totalUncles} — sibling blocks were produced`,
      );
    }
    outcome.verdict = "INFO";
    return;
  }

  // expectation === "exact"
  if (nonPlusOne.length > 0) {
    const sample = nonPlusOne
      .slice(0, 5)
      .map((record) => `#${record.index}: ${record.before}->${record.after}`)
      .join(", ");
    outcome.failures.push(
      `${nonPlusOne.length}/${serialized.length} serialized evm_mine calls did not advance ` +
        `height by exactly 1 (${sample})`,
    );
  }
  if ((outcome.blockAudit?.lineageBreaks.length ?? 0) > 0) {
    outcome.failures.push(`lineage breaks: ${outcome.blockAudit?.lineageBreaks.join("; ")}`);
  }
  if ((outcome.blockAudit?.totalUncles ?? 0) > 0) {
    outcome.failures.push(
      `${outcome.blockAudit?.totalUncles} uncles in a serialized single-miner chain — ` +
        "evidence of sibling blocks from a silent race",
    );
  }
  if (def.load !== null) {
    // Validity guards: the scenario must actually have exercised
    // mining-with-txs-in-flight, or a green result is vacuous.
    const pendingSamples = serialized
      .map((record) => record.pendingBefore)
      .filter((value): value is number => value !== null);
    const meanPending =
      pendingSamples.length > 0
        ? pendingSamples.reduce((a, b) => a + b, 0) / pendingSamples.length
        : 0;
    if (meanPending < 1) {
      outcome.failures.push(
        `load did not materialize: mean pending-before-mine ${meanPending.toFixed(2)} < 1`,
      );
    }
    const ratio =
      (outcome.blockAudit?.nonEmptyBlocks ?? 0) / Math.max(1, outcome.blockAudit?.blockCount ?? 0);
    if (ratio < 0.3) {
      outcome.failures.push(
        `only ${(ratio * 100).toFixed(0)}% of mined blocks contained txs — load too thin`,
      );
    }
    if (outcome.inclusion !== undefined) {
      if (outcome.inclusion.duplicated.length > 0) {
        outcome.failures.push(`${outcome.inclusion.duplicated.length} txs double-included`);
      }
      const lost = outcome.inclusion.missing.filter((entry) => entry.receiptBlock === null);
      if (lost.length > 0) {
        outcome.failures.push(`${lost.length} accepted txs never mined (post-drain)`);
      }
    }
    outcome.observations.push(
      `load: accepted ${outcome.loadStats?.accepted}/${outcome.loadStats?.attempted} txs, ` +
        `mean pending-before-mine ${meanPending.toFixed(1)}, ` +
        `${outcome.blockAudit?.nonEmptyBlocks}/${outcome.blockAudit?.blockCount} blocks non-empty`,
    );
  }
  const latencies = serialized.map((record) => record.ms).sort((a, b) => a - b);
  if (latencies.length > 0) {
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
    const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))]!;
    outcome.observations.push(
      `evm_mine latency: p50 ${p50.toFixed(1)}ms, p99 ${p99.toFixed(1)}ms over ` +
        `${latencies.length} calls`,
    );
  }
  outcome.verdict = outcome.failures.length === 0 ? "PASS" : "FAIL";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outDir, { recursive: true });
  const jarSha256 = await sha256File(options.jar);
  console.log(`exact-K-under-load harness`);
  console.log(`  jar: ${options.jar}`);
  console.log(`  jar sha256: ${jarSha256}`);
  console.log(`  out: ${options.outDir}`);
  console.log(`  mode: ${options.quick ? "quick" : "full"}`);

  const matrix = scenarioMatrix(options.quick).filter(
    (def) => options.only === null || def.name.includes(options.only),
  );
  if (matrix.length === 0) {
    throw new Error(`--only ${options.only} matched no scenarios`);
  }

  const outcomes: ScenarioOutcome[] = [];
  for (const def of matrix) {
    console.log(`\n=== ${def.name} ===`);
    const outcome = await runScenario(def, options);
    outcomes.push(outcome);
    console.log(`  verdict: ${outcome.verdict} (${Math.round(outcome.durationMs / 1000)}s)`);
    for (const observation of outcome.observations) {
      console.log(`  note: ${observation}`);
    }
    for (const failure of outcome.failures) {
      console.log(`  FAILURE: ${failure}`);
    }
  }

  const gating = outcomes.filter((outcome) => outcome.expectation !== "informational");
  const failed = gating.filter((outcome) => outcome.verdict !== "PASS");
  const metrics = {
    meta: {
      startedAt: new Date().toISOString(),
      host: os.hostname(),
      node: process.version,
      jar: options.jar,
      jarSha256,
      quick: options.quick,
    },
    scenarios: outcomes,
    gateVerdict: failed.length === 0 ? "PASS" : "FAIL",
  };
  const metricsPath = path.join(options.outDir, "metrics.json");
  await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));

  console.log(`\n${"-".repeat(72)}`);
  for (const outcome of outcomes) {
    console.log(`${outcome.verdict.padEnd(5)} ${outcome.name}`);
  }
  console.log(`\ngate verdict: ${metrics.gateVerdict}`);
  console.log(`metrics: ${metricsPath}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 3;
});
