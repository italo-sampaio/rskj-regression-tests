/**
 * Scenario primitives: mining loops, chain audits, and log scans.
 *
 * The single load-bearing oracle is `eth_blockNumber` sampled before and
 * after every `evm_mine` call — rskj's evm_mine returns null regardless
 * of outcome (rate-limit rejections, blocksWaitingForPoW cache misses,
 * PoW mismatches, and non-best imports are ALL swallowed at
 * MinerClientImpl.java:148), so per-call height delta is the only signal
 * that catches every silent failure mode at once.
 *
 * Audits layered on top:
 *   - block-range walk: lineage, per-block tx counts, uncle counts
 *     (a single-miner serialized chain must have ZERO uncles — any uncle
 *     is fingerprint evidence of a sibling produced by a race);
 *   - inclusion audit: every accepted tx mined exactly once, none lost;
 *   - rsk.log scan for the known swallowed-error signatures.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { BlockSummary, RpcClient, sleep } from "./rpc.js";

export interface PerCallRecord {
  index: number;
  before: number;
  after: number;
  delta: number;
  ms: number;
  pendingBefore: number | null;
}

export interface ConcurrentRoundRecord {
  callers: number;
  before: number;
  after: number;
  delta: number;
  ms: number;
  pendingBefore: number | null;
}

/** Serialized evm_mine x calls, asserting nothing — callers grade later. */
export async function mineSerialized(
  rpc: RpcClient,
  calls: number,
  callDelayMs: number,
): Promise<PerCallRecord[]> {
  const records: PerCallRecord[] = [];
  for (let i = 0; i < calls; i++) {
    const pendingBefore = (await rpc.txpoolStatus())?.pending ?? null;
    const before = await rpc.blockNumber();
    const startedAt = performance.now();
    await rpc.evmMine();
    const ms = performance.now() - startedAt;
    const after = await rpc.blockNumber();
    records.push({ index: i, before, after, delta: after - before, ms, pendingBefore });
    if (callDelayMs > 0) {
      await sleep(callDelayMs);
    }
  }
  return records;
}

/** One round of N parallel evm_mine calls; height sampled around the batch. */
export async function mineConcurrentRound(
  rpc: RpcClient,
  callers: number,
): Promise<ConcurrentRoundRecord> {
  const pendingBefore = (await rpc.txpoolStatus())?.pending ?? null;
  const before = await rpc.blockNumber();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: callers }, () => rpc.evmMine()));
  const ms = performance.now() - startedAt;
  const after = await rpc.blockNumber();
  return { callers, before, after, delta: after - before, ms, pendingBefore };
}

export interface BlockRangeAudit {
  fromExclusive: number;
  toInclusive: number;
  blockCount: number;
  totalTxs: number;
  nonEmptyBlocks: number;
  totalUncles: number;
  lineageBreaks: string[];
  /** txHash -> block numbers it appears in (canonical chain walk). */
  txLocations: Map<string, number[]>;
}

export async function auditBlockRange(
  rpc: RpcClient,
  fromExclusive: number,
  toInclusive: number,
): Promise<BlockRangeAudit> {
  const audit: BlockRangeAudit = {
    fromExclusive,
    toInclusive,
    blockCount: 0,
    totalTxs: 0,
    nonEmptyBlocks: 0,
    totalUncles: 0,
    lineageBreaks: [],
    txLocations: new Map(),
  };
  let previous: BlockSummary | null = await rpc.getBlockByNumber(fromExclusive);
  for (let height = fromExclusive + 1; height <= toInclusive; height++) {
    const block = await rpc.getBlockByNumber(height);
    if (block === null) {
      audit.lineageBreaks.push(`block ${height} missing from canonical chain`);
      previous = null;
      continue;
    }
    if (previous !== null && block.parentHash !== previous.hash) {
      audit.lineageBreaks.push(
        `block ${height} parentHash ${block.parentHash} != hash of ${height - 1}`,
      );
    }
    audit.blockCount++;
    audit.totalTxs += block.txHashes.length;
    if (block.txHashes.length > 0) {
      audit.nonEmptyBlocks++;
    }
    audit.totalUncles += block.uncleCount;
    for (const txHash of block.txHashes) {
      const locations = audit.txLocations.get(txHash) ?? [];
      locations.push(height);
      audit.txLocations.set(txHash, locations);
    }
    previous = block;
  }
  return audit;
}

export interface InclusionAudit {
  accepted: number;
  includedOnce: number;
  duplicated: { txHash: string; blocks: number[] }[];
  missing: { txHash: string; receiptBlock: number | null }[];
}

/**
 * Every accepted tx must appear exactly once in the audited range.
 * Missing txs get a receipt probe so "mined outside the scanned range"
 * is distinguishable from "lost".
 */
export async function auditInclusion(
  rpc: RpcClient,
  acceptedHashes: string[],
  txLocations: Map<string, number[]>,
): Promise<InclusionAudit> {
  const result: InclusionAudit = {
    accepted: acceptedHashes.length,
    includedOnce: 0,
    duplicated: [],
    missing: [],
  };
  const unresolved: string[] = [];
  for (const txHash of acceptedHashes) {
    const locations = txLocations.get(txHash);
    if (locations === undefined) {
      unresolved.push(txHash);
    } else if (locations.length === 1) {
      result.includedOnce++;
    } else {
      result.duplicated.push({ txHash, blocks: locations });
    }
  }
  const batchSize = 50;
  for (let i = 0; i < unresolved.length; i += batchSize) {
    const batch = unresolved.slice(i, i + batchSize);
    const receiptBlocks = await Promise.all(batch.map((txHash) => rpc.receiptBlockNumber(txHash)));
    for (let j = 0; j < batch.length; j++) {
      result.missing.push({ txHash: batch[j]!, receiptBlock: receiptBlocks[j] ?? null });
    }
  }
  return result;
}

/** Mine until the pool drains (or the budget runs out) so inclusion can settle. */
export async function drainPool(rpc: RpcClient, maxMines: number): Promise<number> {
  let mines = 0;
  while (mines < maxMines) {
    const status = await rpc.txpoolStatus();
    if (status === null) {
      // txpool module unavailable — mine a fixed cushion and stop.
      for (; mines < Math.min(maxMines, 5); mines++) {
        await rpc.evmMine();
      }
      return mines;
    }
    if (status.pending === 0 && status.queued === 0) {
      return mines;
    }
    await rpc.evmMine();
    mines++;
  }
  return mines;
}

export interface LogScan {
  file: string | null;
  errorLines: number;
  warnLines: number;
  cacheMissLines: number;
  invalidBlockLines: number;
  rateLimitLines: number;
}

/**
 * Scan the scenario's logback output for the swallowed-error signatures
 * surfaced by the source recon. Log-grep is NEVER the verdict (that was
 * the spike's instrumentation bug) — it is corroborating evidence only.
 */
export async function scanRskLog(logsDir: string): Promise<LogScan> {
  const scan: LogScan = {
    file: null,
    errorLines: 0,
    warnLines: 0,
    cacheMissLines: 0,
    invalidBlockLines: 0,
    rateLimitLines: 0,
  };
  const candidate = await findRskLog(logsDir);
  if (candidate === null) {
    return scan;
  }
  scan.file = candidate;
  const content = await fs.readFile(candidate, "utf8");
  for (const line of content.split("\n")) {
    if (line.includes("ERROR")) scan.errorLines++;
    if (line.includes("WARN")) scan.warnLines++;
    if (line.includes("could not find hash")) scan.cacheMissLines++;
    if (line.includes("Invalid block supplied by miner")) scan.invalidBlockLines++;
    if (line.toLowerCase().includes("rate limit")) scan.rateLimitLines++;
  }
  return scan;
}

async function findRskLog(root: string): Promise<string | null> {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name === "rsk.log") {
        return full;
      }
    }
  }
  return null;
}
