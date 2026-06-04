/**
 * Single-rskj-node JVM spawner.
 *
 * This module's job is to:
 *
 *   1. Resolve effective config — RPC + P2P ports (free-port pick if the
 *      caller didn't pin them), data dir (fresh tmpdir if none supplied),
 *      and a merged HOCON file under the data dir.
 *   2. Spawn `java <jvmArgs> -jar <jarPath> --regtest`.
 *   3. Wait for the RPC port to bind, then for `eth_blockNumber` to
 *      answer.
 *   4. Expose a tidy {@link RskjNodeHandle} so the driver can `stop()`
 *      cleanly.
 *
 * Inspired by RIT's `lib/federate-runner.js` (the JVM-spawning pattern —
 * cwd, classpath, `-D` JVM args, port-readiness loop, shutdown). We
 * adapted rather than copy-pasted because:
 *
 *   - This is a *plain* rskj node, not a powpeg JVM. Different main class
 *     (`co.rsk.Start` vs `co.rsk.federate.FederateRunner`).
 *   - No federation keys, no bookkeeping config, no HSM wiring.
 *   - We use `-jar <fatJar>` instead of `-cp <fatJar> co.rsk.Start` —
 *     rskj's fat JAR sets `Main-Class: co.rsk.Start` in its manifest,
 *     so `-jar` is the canonical invocation. Less surface for typos.
 *   - HOCON file generated on disk rather than `-D` flag soup — easier
 *     to inspect in a postmortem.
 *   - Readiness check is JSON-RPC level (`eth_blockNumber`), not just a
 *     bound port. RIT's federate-runner stops at port-bind because the
 *     suite that comes next exercises every wire-level RPC anyway; we
 *     want the JSON-RPC handler guaranteed live before hardhat / k6
 *     starts hitting it.
 *
 * Process-management notes:
 *
 *   - We attach `process.exit` and `SIGINT` / `SIGTERM` handlers so a
 *     Ctrl-C in the driver tears the JVM down. Without these, the JVM
 *     keeps running after the driver dies and leaks ports / data dirs.
 *   - `stop()` first sends SIGTERM (clean shutdown), then SIGKILL after
 *     a grace period — rskj installs a JVM shutdown hook that flushes
 *     the trie, and SIGKILL would corrupt the database.
 *   - The data dir is removed on `stop()` unless `keepDataDir: true`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultRskjConfig, mergeConfig, renderHocon } from "./regtest-config.js";
import { findFreePorts, waitForPort } from "./port-utils.js";
import { waitForRpcReady } from "./rpc-readiness.js";
import type { RskjNodeConfig, RskjNodeHandle } from "./topology.js";

/** Default Java executable. Tests / callers override via `JAVA_BIN_PATH`. */
const DEFAULT_JAVA = process.env.JAVA_BIN_PATH ?? "java";

/** Grace period between SIGTERM and SIGKILL in `stop()`. */
const SHUTDOWN_GRACE_MS = 15_000;

/**
 * Side-channel hooks the driver injects so we can unit-test without
 * forking a real JVM or writing real files.
 */
export interface RskjRunnerHooks {
  spawnFn?: typeof spawn;
  mkdirFn?: (p: string) => void;
  mkdtempFn?: (prefix: string) => string;
  writeFileFn?: (p: string, contents: string) => void;
  rmFn?: (p: string) => void;
  /** Override `findFreePorts` so port allocation is deterministic in tests. */
  findFreePortsFn?: typeof findFreePorts;
  /** Override the TCP port-bind wait. */
  waitForPortFn?: typeof waitForPort;
  /** Override the JSON-RPC readiness probe. */
  waitForRpcReadyFn?: typeof waitForRpcReady;
  /** Override the java binary (in addition to `JAVA_BIN_PATH`). */
  javaBin?: string;
}

/**
 * Spawn one rskj node according to `config`. Returns a handle the
 * caller uses to `await ready()` and `stop()`.
 *
 * The returned promise resolves as soon as the child process is
 * spawned and the data dir / config file are written. It does *not*
 * wait for the RPC port to come up — call `handle.ready()` for that.
 * Splitting the spawn from the readiness wait keeps the failure
 * surface visible: a spawn-time failure (missing JAR, bad java
 * binary) throws here, a readiness-time failure throws from
 * `handle.ready()`.
 */
export async function spawnRskjNode(
  config: RskjNodeConfig,
  hooks: RskjRunnerHooks = {},
): Promise<RskjNodeHandle> {
  const spawnFn = hooks.spawnFn ?? spawn;
  const mkdirFn =
    hooks.mkdirFn ??
    ((p: string): void => {
      mkdirSync(p, { recursive: true });
    });
  const mkdtempFn = hooks.mkdtempFn ?? ((prefix: string): string => mkdtempSync(prefix));
  const writeFileFn =
    hooks.writeFileFn ?? ((p: string, c: string): void => writeFileSync(p, c, "utf8"));
  const rmFn = hooks.rmFn ?? ((p: string): void => rmSync(p, { recursive: true, force: true }));
  const findFreePortsFn = hooks.findFreePortsFn ?? findFreePorts;
  const waitForPortFn = hooks.waitForPortFn ?? waitForPort;
  const waitForRpcReadyFn = hooks.waitForRpcReadyFn ?? waitForRpcReady;
  const javaBin = hooks.javaBin ?? DEFAULT_JAVA;
  const log = config.log ?? ((): void => undefined);

  // 1. Resolve ports.
  const portsNeeded =
    (config.rpcPort === undefined ? 1 : 0) + (config.p2pPort === undefined ? 1 : 0);
  let freePorts: number[] = [];
  if (portsNeeded > 0) {
    freePorts = await findFreePortsFn(portsNeeded);
  }
  let freeIndex = 0;
  const rpcPort = config.rpcPort ?? freePorts[freeIndex++]!;
  const p2pPort = config.p2pPort ?? freePorts[freeIndex++]!;

  // 2. Resolve data dir + write config file.
  const dataDir = config.dataDir
    ? resolveAndEnsure(config.dataDir, mkdirFn)
    : mkdtempFn(join(tmpdir(), "rskj-regression-"));
  const configPath = join(dataDir, "rskj.conf");
  const baseline = defaultRskjConfig({ dataDir, rpcPort, p2pPort });
  const merged = mergeConfig(baseline, config.configOverrides ?? {});
  writeFileFn(configPath, renderHocon(merged));
  log(`[rskj-runner] wrote config → ${configPath}`);
  log(`[rskj-runner] rpcPort=${rpcPort} p2pPort=${p2pPort} dataDir=${dataDir}`);

  // 3. Build the spawn command.
  //
  //   java <jvmArgs> -Drsk.conf.file=<path> -cp <fatJar> co.rsk.Start --regtest
  //
  // We use `-cp ... co.rsk.Start` rather than `-jar <fatJar>` because
  // rskj's `build.gradle` is currently building the fat JAR with a
  // broken manifest:
  //
  //   Main-Class: extension 'application' property 'mainClass'
  //
  // (literal unevaluated Gradle expression instead of `co.rsk.Start`).
  // `-jar` would refuse to start; `-cp` + explicit main class works on
  // every rskj fat JAR we've checked and matches RIT's
  // `federate-runner.js` invocation style. If/when rskj fixes the
  // manifest we can switch to `-jar` for the cleaner CLI surface.
  // `--regtest` selects genesis + hard-fork heights; our config file
  // layers on top.
  const args: string[] = [
    ...(config.jvmArgs ?? []),
    `-Drsk.conf.file=${configPath}`,
    "-cp",
    config.jarPath,
    "co.rsk.Start",
    "--regtest",
  ];
  log(`[rskj-runner] spawn: ${javaBin} ${args.join(" ")}`);

  const child = spawnFn(javaBin, args, {
    cwd: dataDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Stream child stdout / stderr line-by-line through the log hook.
  pipeLines(child, log);

  // Crash-safety: if anything between here and the handle returning
  // throws, we still want to kill the JVM and remove the dir.
  let cleanupOnEarlyFailure: (() => void) | null = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    if (!config.keepDataDir && !config.dataDir) {
      try {
        rmFn(dataDir);
      } catch {
        /* ignore */
      }
    }
  };

  // 4. Build the handle.
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  let readyCalled = false;
  let readyResolved = false;
  let readyError: Error | null = null;
  let stopped = false;
  let exitedNaturally = false;
  child.on("exit", (code, signal) => {
    exitedNaturally = true;
    log(`[rskj-runner] child exited code=${code} signal=${signal}`);
  });

  // Install signal handlers so a Ctrl-C / SIGTERM on the parent process
  // tears the JVM down. We attach lazily and remove them in `stop()` so
  // multiple orchestrator instances in the same process don't leak
  // listeners.
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

  const handle: RskjNodeHandle = {
    rpcUrl,
    rpcPort,
    p2pPort,
    dataDir,
    get pid(): number | null {
      return child.pid && !exitedNaturally ? child.pid : null;
    },
    async ready(): Promise<void> {
      if (readyResolved) return;
      if (readyError) throw readyError;
      if (readyCalled) {
        // Concurrent readiness call — wait by polling the resolution
        // markers. Cheap because the readiness probe itself is bounded.
        while (!readyResolved && !readyError) {
          await delay(50);
        }
        if (readyError) throw readyError;
        return;
      }
      readyCalled = true;
      try {
        await waitForPortFn(
          { host: "127.0.0.1", port: rpcPort },
          {
            attempts: Math.ceil((config.readinessTimeoutMs ?? 60_000) / 1000),
            intervalMs: 1000,
          },
        );
        await waitForRpcReadyFn(rpcUrl, {
          timeoutMs: config.readinessTimeoutMs ?? 60_000,
          log,
        });
        readyResolved = true;
        cleanupOnEarlyFailure = null;
      } catch (err) {
        readyError = err as Error;
        if (cleanupOnEarlyFailure) cleanupOnEarlyFailure();
        throw err;
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      process.removeListener("SIGINT", onParentTerminate);
      process.removeListener("SIGTERM", onParentTerminate);
      process.removeListener("beforeExit", onParentTerminate);
      cleanupOnEarlyFailure = null;
      await terminateChild(child, log);
      if (!config.keepDataDir && !config.dataDir) {
        try {
          rmFn(dataDir);
          log(`[rskj-runner] removed data dir ${dataDir}`);
        } catch (err) {
          log(`[rskj-runner] failed to remove ${dataDir}: ${(err as Error).message}`);
        }
      } else {
        log(`[rskj-runner] keeping data dir ${dataDir}`);
      }
    },
  };

  return handle;
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

function resolveAndEnsure(p: string, mkdirFn: (p: string) => void): string {
  const abs = resolve(p);
  mkdirFn(abs);
  return abs;
}

function pipeLines(child: ChildProcess, log: (line: string) => void): void {
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      log(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    let nl: number;
    while ((nl = stderrBuf.indexOf("\n")) !== -1) {
      const line = stderrBuf.slice(0, nl);
      stderrBuf = stderrBuf.slice(nl + 1);
      log(line);
    }
  });
}

async function terminateChild(child: ChildProcess, log: (l: string) => void): Promise<void> {
  if (child.exitCode !== null || !child.pid) {
    return; // Already gone.
  }
  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = new Promise<"timeout">((resolvePromise) =>
    setTimeout(() => resolvePromise("timeout"), SHUTDOWN_GRACE_MS),
  );
  const outcome = await Promise.race([exited.then(() => "exited" as const), timer]);
  if (outcome === "timeout") {
    log(`[rskj-runner] SIGTERM timeout after ${SHUTDOWN_GRACE_MS}ms; sending SIGKILL`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await exited;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
