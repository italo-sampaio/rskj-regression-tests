/**
 * Full-topology smoke — the orchestrator's own acceptance test.
 *
 * Brings up the full regression topology (1 bitcoind + 3 genesis
 * federators + 1 vanilla rskj miner node) via `startFullTopology` and
 * proves the orchestrator-task acceptance criteria:
 *
 *   1. BOOT      — every process answers JSON-RPC; report wall-clock boot.
 *   2. FEDERATION — `getFederationAddress()` on all three federates equals
 *                   the genesis federation BTC address (they agree on, and
 *                   loaded, the genesis federation).
 *   3. VOTE      — `voteFeePerKbChange` from the authorizer key changes
 *                   `getFeePerKb()` after one mined block (the federation
 *                   can be governed).
 *   4. EXACT-K   — serialized `evm_mine` ×K on the miner advances its
 *                   height by exactly K (Model B; never concurrent), and
 *                   all federates + the miner converge on the same
 *                   height AND block hash (cross-node sync).
 *
 * Peg-in scope note: the authoritative peg-in/pegout proof is the RIT 2WP
 * suite (reproduced via the driver's RIT runner integration — the spike's
 * 31/31 baseline). This orchestrator smoke proves the federation is formed,
 * governable, and mines deterministically with the whole cluster in sync;
 * it does not re-implement RIT's BTC peg machinery (that overlaps Phase 5).
 *
 * Run:
 *   npx tsx spikes/full-topology/harness/smoke.ts \
 *     [--powpeg <jar>] [--rskj <jar>] [--btc-blocks N] [--k N] [--keep] [--out <dir>]
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFullTopology, type FullTopologyHandle } from "../../../src/orchestrator/index.js";
import {
  BRIDGE_ADDRESS,
  BRIDGE_SELECTORS,
  FEE_PER_KB_AUTHORIZER,
  GENESIS_FEDERATION,
  GENESIS_FEDERATION_BTC_ADDRESS,
  GENESIS_FEE_PER_KB_SATS,
} from "../../../src/orchestrator/index.js";
import { decodeAbiString, decodeUint256, encodeUint256, RpcClient, waitFor } from "./rpc.js";

const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POWPEG =
  "/home/italo/workspace/powpeg-node/build/libs/federate-node-gaslimit-RC1-9.1.0.0-all.jar";
const DEFAULT_RSKJ = "/home/italo/workspace/rskj/artifacts/rsk.jar";

interface Options {
  powpegJar: string;
  rskjJar: string;
  btcBlocks: number;
  k: number;
  keep: boolean;
  outDir: string;
}

interface Check {
  name: string;
  verdict: "PASS" | "FAIL";
  detail: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    powpegJar: DEFAULT_POWPEG,
    rskjJar: DEFAULT_RSKJ,
    btcBlocks: 400,
    k: 10,
    keep: false,
    outDir: path.join(SPIKE_ROOT, "results", new Date().toISOString().replace(/[:.]/g, "-")),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--powpeg") o.powpegJar = argv[++i]!;
    else if (a === "--rskj") o.rskjJar = argv[++i]!;
    else if (a === "--btc-blocks") o.btcBlocks = Number(argv[++i]);
    else if (a === "--k") o.k = Number(argv[++i]);
    else if (a === "--keep") o.keep = true;
    else if (a === "--out") o.outDir = path.resolve(argv[++i]!);
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await fs.mkdir(opts.outDir, { recursive: true });
  const logPath = path.join(opts.outDir, "topology.log");
  const logStream = await fs.open(logPath, "w");
  const log = (line: string): void => {
    void logStream.write(`${line}\n`);
  };

  console.log("full-topology smoke");
  console.log(`  powpeg jar: ${opts.powpegJar}`);
  console.log(`  rskj jar:   ${opts.rskjJar}`);
  console.log(`  out:        ${opts.outDir}`);

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  };

  let topology: FullTopologyHandle | null = null;
  const bootStart = performance.now();
  try {
    topology = await startFullTopology({
      powpegJarPath: opts.powpegJar,
      rskjJarPath: opts.rskjJar,
      initialBtcBlocks: opts.btcBlocks,
      dataRoot: path.join(opts.outDir, "data"),
      keepDataDirs: opts.keep,
      log,
    });
    const bootMs = Math.round(performance.now() - bootStart);
    add(
      "boot",
      true,
      `bitcoind + ${topology.federates.length} federates + miner ready in ${(bootMs / 1000).toFixed(1)}s`,
    );

    const miner = new RpcClient(topology.miningRpcUrl);
    const fedClients = topology.federates.map((f) => ({ id: f.id, rpc: new RpcClient(f.rpcUrl) }));

    // ---- 2. FEDERATION FORMED -------------------------------------------
    const fedAddrs: string[] = [];
    for (const f of fedClients) {
      const raw = await f.rpc.ethCall(BRIDGE_ADDRESS, BRIDGE_SELECTORS.getFederationAddress);
      fedAddrs.push(decodeAbiString(raw));
    }
    const allMatch =
      fedAddrs.every((a) => a === GENESIS_FEDERATION_BTC_ADDRESS) &&
      fedAddrs.length === GENESIS_FEDERATION.length;
    add(
      "federation-formed",
      allMatch,
      allMatch
        ? `all ${fedAddrs.length} federates report ${GENESIS_FEDERATION_BTC_ADDRESS}`
        : `federation address mismatch: ${JSON.stringify(fedAddrs)}`,
    );

    // ---- 3. FEDERATION VOTE (fee-per-kb governance) ---------------------
    // Import the single authorizer key on the miner and cast the vote;
    // gasPrice 0 is accepted on regtest so the (unfunded) authorizer can
    // send. One mined block applies it.
    const before = decodeUint256(await miner.ethCall(BRIDGE_ADDRESS, BRIDGE_SELECTORS.getFeePerKb));
    const newFeePerKb = BigInt(GENESIS_FEE_PER_KB_SATS) + 50_000n; // 150000 sat, within bounds
    const passphrase = "rskj-regression";
    const authAddr = await miner.importRawKey(
      FEE_PER_KB_AUTHORIZER.privateKey.replace(/^0x/, ""),
      passphrase,
    );
    await miner.unlockAccount(authAddr, passphrase);
    const voteData = BRIDGE_SELECTORS.voteFeePerKbChange + encodeUint256(newFeePerKb);
    await miner.sendTransaction({
      from: authAddr,
      to: BRIDGE_ADDRESS,
      data: voteData,
      gas: "0x100000",
      gasPrice: "0x0",
    });
    await miner.evmMine();
    const after = decodeUint256(await miner.ethCall(BRIDGE_ADDRESS, BRIDGE_SELECTORS.getFeePerKb));
    const voteOk = after === newFeePerKb;
    add(
      "federation-vote",
      voteOk,
      voteOk
        ? `feePerKb ${before} → ${after} (authorizer ${authAddr})`
        : `feePerKb unchanged: before=${before} after=${after} expected=${newFeePerKb}`,
    );

    // ---- 4. EXACT-K + CROSS-NODE SYNC -----------------------------------
    // Wait for the miner to have at least one peer so its blocks propagate.
    await waitFor("miner peers", async () => (await miner.peerCount()) >= 1, 60_000);
    const startHeight = await miner.blockNumber();
    for (let i = 0; i < opts.k; i++) {
      const h0 = await miner.blockNumber();
      await miner.evmMine(); // serialized — never concurrent (exact-K gate)
      const h1 = await miner.blockNumber();
      if (h1 - h0 !== 1) {
        add("exact-k", false, `evm_mine #${i} advanced ${h0}→${h1} (expected +1)`);
        break;
      }
    }
    const target = startHeight + opts.k;
    const minerHeight = await miner.blockNumber();
    const exactK = minerHeight === target;
    if (checks.find((c) => c.name === "exact-k") === undefined) {
      add(
        "exact-k",
        exactK,
        exactK
          ? `miner advanced exactly ${opts.k} blocks (${startHeight} → ${minerHeight})`
          : `miner height ${minerHeight} != expected ${target}`,
      );
    }

    // Cross-node sync: every federate reaches the target height with the
    // SAME block hash as the miner (proves they synced the miner's chain).
    const minerHashAtTarget = await miner.blockHashAt(target);
    const syncResults: string[] = [];
    let syncOk = true;
    for (const f of fedClients) {
      try {
        await waitFor(`${f.id} sync`, async () => (await f.rpc.blockNumber()) >= target, 60_000);
        const fedHash = await f.rpc.blockHashAt(target);
        const ok = fedHash === minerHashAtTarget;
        syncOk = syncOk && ok;
        syncResults.push(`${f.id}:${ok ? "match" : `MISMATCH(${fedHash})`}`);
      } catch (err) {
        syncOk = false;
        syncResults.push(`${f.id}:TIMEOUT`);
        log(`[smoke] ${f.id} sync error: ${String(err)}`);
      }
    }
    add(
      "cross-node-sync",
      syncOk,
      `target block ${target} hash ${minerHashAtTarget?.slice(0, 18)}… — ${syncResults.join(", ")}`,
    );
  } catch (err) {
    add("topology", false, `bring-up/smoke crashed: ${String(err)}`);
    log(`[smoke] crash: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    if (topology) {
      await topology.stop().catch((e) => log(`[smoke] teardown error: ${String(e)}`));
    }
    await logStream.close();
  }

  const passed = checks.filter((c) => c.verdict === "PASS").length;
  const verdict = checks.length > 0 && passed === checks.length ? "PASS" : "FAIL";
  const summary = {
    meta: {
      startedAt: new Date().toISOString(),
      host: os.hostname(),
      node: process.version,
      powpegJar: opts.powpegJar,
      rskjJar: opts.rskjJar,
      k: opts.k,
      btcBlocks: opts.btcBlocks,
    },
    checks,
    verdict,
  };
  await fs.writeFile(path.join(opts.outDir, "smoke.json"), JSON.stringify(summary, null, 2));

  console.log(`\n${"-".repeat(64)}`);
  console.log(`verdict: ${verdict} (${passed}/${checks.length})`);
  console.log(`log:     ${logPath}`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 3;
});
