/**
 * High-level entry point for the single-node orchestrator.
 *
 * `startRskjNode(config)` is the canonical API surface for v1:
 *
 *   const node = await startRskjNode({ jarPath: "/abs/to/fatJar.jar" });
 *   await node.ready();
 *   // ...point your tests at node.rpcUrl...
 *   await node.stop();
 *
 * It's a thin shim over {@link spawnRskjNode} that:
 *
 *   - Validates the JAR path up front so the error surface is clearer
 *     than "java: file not found".
 *   - Returns the same {@link RskjNodeHandle} as the lower-level
 *     `spawnRskjNode`. Splitting spawn from "spawn + validate" keeps
 *     the unit tests simple — they can poke the lower entry directly
 *     without filesystem stubs.
 *
 * For multi-node topologies (task #6), this module will grow a
 * `startTopology(topology)` factory; the v1 surface stays
 * single-node-only on purpose to keep the API focused.
 */

import { existsSync, statSync } from "node:fs";
import { spawnRskjNode, type RskjRunnerHooks } from "./rskj-runner.js";
import type { RskjNodeConfig, RskjNodeHandle } from "./topology.js";

/**
 * Options accepted by {@link startRskjNode} — superset of
 * {@link RskjNodeConfig} with optional test-injection hooks.
 */
export interface StartRskjNodeOptions extends RskjNodeConfig {
  /** Test seams — production callers omit these. */
  hooks?: RskjRunnerHooks;
  /**
   * Override the JAR existence check (defaults to `existsSync` +
   * `statSync().isFile()`). Tests inject a stub to avoid touching disk.
   */
  jarExistsFn?: (p: string) => boolean;
}

/**
 * Spawn one isolated rskj regtest node and return a handle.
 *
 * Throws synchronously (well, rejects the returned promise) when the
 * JAR path doesn't point at a regular file — catching that here gives
 * the caller a stack trace that mentions `startRskjNode` rather than
 * a low-level spawn error.
 */
export async function startRskjNode(options: StartRskjNodeOptions): Promise<RskjNodeHandle> {
  validateJarPath(options.jarPath, options.jarExistsFn);
  const { hooks, jarExistsFn: _jarExistsFn, ...config } = options;
  return spawnRskjNode(config, hooks);
}

function validateJarPath(jarPath: string | undefined, jarExistsFn?: (p: string) => boolean): void {
  if (!jarPath || typeof jarPath !== "string" || jarPath.trim() === "") {
    throw new Error("startRskjNode: jarPath is required.");
  }
  const check =
    jarExistsFn ??
    ((p: string): boolean => {
      if (!existsSync(p)) return false;
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  if (!check(jarPath)) {
    throw new Error(`startRskjNode: jar not found at ${jarPath} (or not a regular file).`);
  }
}
