/**
 * bitcoind (Bitcoin Core 0.18.1, regtest) process runner.
 *
 * Ported from rootstock-integration-tests' `lib/bitcoin-runner.js` — the
 * spawn argv, dynamic-port allocation, TCP-port readiness wait, and
 * data-dir teardown are the same shape, adapted to TypeScript with the
 * orchestrator's injection-seam convention so the config/argv logic is
 * unit-testable without forking a real daemon.
 *
 * Why 0.18.1 specifically: it is the version RIT and the PowPeg pin, and
 * the federate's BTC-light-client logic and the regtest peg use its
 * `generate`/`signrawtransaction` RPCs, which were deprecated and gated
 * behind `-deprecatedrpc=` flags in 0.18. Newer Core drops them entirely.
 *
 * Block production: `mine(n)` calls the deprecated `generate` RPC, which
 * mines `n` blocks to the daemon's own wallet — the regtest coinbase. The
 * topology mines ~400 blocks at bootstrap so the wallet has spendable
 * (mature, >100-confirmation) coins before any peg-in funding.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findFreePorts, waitForPort } from "./port-utils.js";

/** Bitcoin Core 0.18.1 binary. Overridable via `BITCOIND_BIN_PATH`. */
const DEFAULT_BITCOIND = process.env.BITCOIND_BIN_PATH ?? "bitcoind";

/**
 * Dynamic-port pool for bitcoind. Deliberately disjoint from the
 * federation band (30000–30005) and the orchestrator's rskj default
 * (30000–30200) — RIT uses this same 20000–20100 range.
 */
const BITCOIND_PORT_RANGE = { start: 20000, end: 20100 } as const;

const SHUTDOWN_GRACE_MS = 15_000;

export interface BitcoindConfig {
  /** P2P port. Free-port picked from 20000–20100 when omitted. */
  p2pPort?: number;
  /** JSON-RPC port. Free-port picked when omitted. */
  rpcPort?: number;
  rpcUser?: string;
  rpcPassword?: string;
  /** Data dir. Fresh tmpdir when omitted (and removed on stop). */
  dataDir?: string;
  keepDataDir?: boolean;
  /** Line logger for the daemon's stdout/stderr. Discarded when omitted. */
  log?: (line: string) => void;
  /** Readiness timeout (ms). Default 60s. */
  readinessTimeoutMs?: number;
}

export interface BitcoindRunnerHooks {
  spawnFn?: typeof spawn;
  mkdirFn?: (p: string) => void;
  mkdtempFn?: (prefix: string) => string;
  rmFn?: (p: string) => void;
  findFreePortsFn?: typeof findFreePorts;
  waitForPortFn?: typeof waitForPort;
  /** Override the JSON-RPC transport (unit tests inject a fake). */
  rpcFn?: (url: string, auth: string, method: string, params: unknown[]) => Promise<unknown>;
  bitcoindBin?: string;
}

export interface BitcoindHandle {
  /** `http://127.0.0.1:<rpcPort>` with basic-auth baked into calls. */
  rpcUrl: string;
  rpcPort: number;
  p2pPort: number;
  rpcUser: string;
  rpcPassword: string;
  /** `127.0.0.1:<p2pPort>` — what a federate's `bitcoinPeerAddresses` wants. */
  peerAddress: string;
  dataDir: string;
  pid: number | null;
  ready(): Promise<void>;
  /** Mine `n` blocks to the daemon wallet (deprecated `generate` RPC). */
  mine(n: number): Promise<string[]>;
  /** Raw JSON-RPC call against the daemon. */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

/** Default JSON-RPC transport: HTTP basic auth, regtest daemon. */
async function defaultRpc(
  url: string,
  auth: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      authorization: `Basic ${Buffer.from(auth).toString("base64")}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "rskj-regression", method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } | null };
  if (body.error) {
    throw new Error(`bitcoind ${method}: ${body.error.message}`);
  }
  return body.result;
}

/**
 * Spawn a regtest bitcoind. Resolves once the process is spawned and the
 * data dir exists; call `handle.ready()` to await RPC availability.
 */
export async function spawnBitcoind(
  config: BitcoindConfig = {},
  hooks: BitcoindRunnerHooks = {},
): Promise<BitcoindHandle> {
  const spawnFn = hooks.spawnFn ?? spawn;
  const mkdirFn =
    hooks.mkdirFn ??
    ((p: string): void => {
      mkdirSync(p, { recursive: true });
    });
  const mkdtempFn = hooks.mkdtempFn ?? ((prefix: string): string => mkdtempSync(prefix));
  const rmFn = hooks.rmFn ?? ((p: string): void => rmSync(p, { recursive: true, force: true }));
  const findFreePortsFn = hooks.findFreePortsFn ?? findFreePorts;
  const waitForPortFn = hooks.waitForPortFn ?? waitForPort;
  const rpcFn = hooks.rpcFn ?? defaultRpc;
  const bitcoindBin = hooks.bitcoindBin ?? DEFAULT_BITCOIND;
  const log = config.log ?? ((): void => undefined);

  const rpcUser = config.rpcUser ?? "rsk";
  const rpcPassword = config.rpcPassword ?? "rsk";

  const portsNeeded =
    (config.rpcPort === undefined ? 1 : 0) + (config.p2pPort === undefined ? 1 : 0);
  let freePorts: number[] = [];
  if (portsNeeded > 0) {
    freePorts = await findFreePortsFn(portsNeeded, {
      rangeStart: BITCOIND_PORT_RANGE.start,
      rangeEnd: BITCOIND_PORT_RANGE.end,
    });
  }
  let freeIndex = 0;
  const rpcPort = config.rpcPort ?? freePorts[freeIndex++]!;
  const p2pPort = config.p2pPort ?? freePorts[freeIndex++]!;

  const dataDir = config.dataDir
    ? resolveAndEnsure(config.dataDir, mkdirFn)
    : mkdtempFn(join(tmpdir(), "rskj-regression-btc-"));

  const args = [
    "-regtest",
    "-printtoconsole",
    "-bind=127.0.0.1",
    "-rpcbind=127.0.0.1",
    "-rpcallowip=127.0.0.1",
    "-txindex",
    "-deprecatedrpc=signrawtransaction",
    "-deprecatedrpc=generate",
    `-port=${p2pPort}`,
    `-rpcport=${rpcPort}`,
    `-rpcuser=${rpcUser}`,
    `-rpcpassword=${rpcPassword}`,
    `-datadir=${dataDir}`,
  ];
  log(`[bitcoind] spawn: ${bitcoindBin} ${args.join(" ")}`);

  const child = spawnFn(bitcoindBin, args, { cwd: dataDir, stdio: ["ignore", "pipe", "pipe"] });
  pipeLines(child, log);

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const auth = `${rpcUser}:${rpcPassword}`;
  let stopped = false;
  let exited = false;
  let readyDone = false;
  child.on("exit", (code, signal) => {
    exited = true;
    log(`[bitcoind] exited code=${code} signal=${signal}`);
  });

  const onParentTerminate = (): void => {
    if (!stopped && child.pid) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  process.once("SIGINT", onParentTerminate);
  process.once("SIGTERM", onParentTerminate);
  process.once("beforeExit", onParentTerminate);

  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> =>
    rpcFn(rpcUrl, auth, method, params) as Promise<T>;

  const handle: BitcoindHandle = {
    rpcUrl,
    rpcPort,
    p2pPort,
    rpcUser,
    rpcPassword,
    peerAddress: `127.0.0.1:${p2pPort}`,
    dataDir,
    get pid(): number | null {
      return child.pid && !exited ? child.pid : null;
    },
    async ready(): Promise<void> {
      if (readyDone) return;
      const timeoutMs = config.readinessTimeoutMs ?? 60_000;
      await waitForPortFn(
        { host: "127.0.0.1", port: rpcPort },
        { attempts: Math.ceil(timeoutMs / 1000), intervalMs: 1000 },
      );
      // Port-open is not enough: the RPC handler comes up a beat later and
      // the wallet must be loadable. Poll getblockchaininfo until it answers.
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          await rpc("getblockchaininfo");
          readyDone = true;
          return;
        } catch (err) {
          lastErr = err;
          await delay(500);
        }
      }
      throw new Error(`bitcoind RPC not ready within ${timeoutMs}ms: ${String(lastErr)}`);
    },
    async mine(n: number): Promise<string[]> {
      return rpc<string[]>("generate", [n]);
    },
    rpc,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      process.removeListener("SIGINT", onParentTerminate);
      process.removeListener("SIGTERM", onParentTerminate);
      process.removeListener("beforeExit", onParentTerminate);
      await terminateChild(child, log);
      if (!config.keepDataDir && !config.dataDir) {
        try {
          rmFn(dataDir);
          log(`[bitcoind] removed data dir ${dataDir}`);
        } catch (err) {
          log(`[bitcoind] failed to remove ${dataDir}: ${(err as Error).message}`);
        }
      }
    },
  };

  return handle;
}

/* -------------------------------------------------------------------------- */

function resolveAndEnsure(p: string, mkdirFn: (p: string) => void): string {
  const abs = resolve(p);
  mkdirFn(abs);
  return abs;
}

function pipeLines(child: ChildProcess, log: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        log(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
  }
}

async function terminateChild(child: ChildProcess, log: (l: string) => void): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = new Promise<"timeout">((res) =>
    setTimeout(() => res("timeout"), SHUTDOWN_GRACE_MS),
  );
  const outcome = await Promise.race([exited.then(() => "exited" as const), timer]);
  if (outcome === "timeout") {
    log(`[bitcoind] SIGTERM timeout; sending SIGKILL`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await exited;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
