/**
 * Free-port allocation utilities for the orchestrator.
 *
 * Ported from RIT's `lib/port-utils.js` (private:
 * `/home/italo/workspace/rootstock-integration-tests/lib/port-utils.js`)
 * — same approach (probe each port in a range with a short TCP connect
 * timeout), rewritten in TypeScript and with the API tightened up for
 * single-process callers.
 *
 * Why a probe-loop rather than `server.listen(0)`:
 *
 *   `server.listen(0)` asks the kernel for an ephemeral port, but it's
 *   racy: by the time the rskj JVM tries to `bind()` the port we returned,
 *   another process on the box (or the kernel itself, allocating to a
 *   new ephemeral socket) may have taken it. The probe-loop is slower but
 *   stable — we open a connection to each port in the range, and if it
 *   refuses we treat that as "free enough". Same heuristic RIT has been
 *   using for years.
 *
 *   In a multi-tenant CI runner you'd want to follow up with a real
 *   `bind()`-and-hold pattern (allocate, hold the socket while you launch
 *   the JVM, release after the JVM has bound). For now we match RIT's
 *   behaviour — the regression flow always runs against one fresh
 *   topology per invocation and the window for collision is small.
 */

import net from "node:net";

/** Default range mirrors RIT's `20000–20100` window. */
export const DEFAULT_PORT_RANGE = { start: 30000, end: 30200 } as const;

/** Public surface of {@link findFreePorts}. */
export interface FindFreePortsOptions {
  /** Inclusive start of the range to probe. */
  rangeStart?: number;
  /** Inclusive end of the range to probe. */
  rangeEnd?: number;
  /** Host to probe — defaults to `127.0.0.1`. */
  host?: string;
  /** Per-port connect timeout in milliseconds. Defaults to 250 ms. */
  timeoutMs?: number;
  /**
   * Override the per-port availability check (tests inject a stub). The
   * default uses a real `net.Socket` connect.
   */
  isAvailable?: (port: number, host: string, timeoutMs: number) => Promise<boolean>;
}

/**
 * Probe `port` on `host`: returns `true` if a TCP connect attempt is
 * rejected (port appears free), `false` if anything answers.
 *
 * Mirrors RIT's behaviour: refused connections / timeouts both count as
 * "free", any successful handshake counts as "in use". The timeout
 * doubles as a cap on how long we wait for slow lo-iface responses.
 */
export function isPortAvailable(
  port: number,
  host: string = "127.0.0.1",
  timeoutMs: number = 250,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    let settled = false;
    const free = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(true);
    };
    const occupied = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(false);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", free);
    socket.once("timeout", free);
    socket.connect(port, host, occupied);
  });
}

/**
 * Find `count` free TCP ports in `[rangeStart..rangeEnd]` on `host`.
 *
 * @throws Error when the range can't supply `count` free ports.
 *
 * Returns the ports in ascending order — callers that want fresh-per-call
 * randomness should shuffle the result themselves.
 */
export async function findFreePorts(
  count: number,
  options: FindFreePortsOptions = {},
): Promise<number[]> {
  const rangeStart = options.rangeStart ?? DEFAULT_PORT_RANGE.start;
  const rangeEnd = options.rangeEnd ?? DEFAULT_PORT_RANGE.end;
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 250;
  const isAvailable = options.isAvailable ?? isPortAvailable;
  if (count < 1) return [];
  if (rangeEnd < rangeStart) {
    throw new Error(`Invalid port range: end (${rangeEnd}) < start (${rangeStart}).`);
  }

  const found: number[] = [];
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isAvailable(port, host, timeoutMs)) {
      found.push(port);
      if (found.length === count) return found;
    }
  }
  throw new Error(
    `Could not find ${count} free ports in [${rangeStart}..${rangeEnd}] on ${host}. ` +
      `Found ${found.length}: ${JSON.stringify(found)}.`,
  );
}

/** A single host:port pair, used by {@link waitForPort}. */
export interface HostPort {
  host: string;
  port: number;
}

/** Tunables for {@link waitForPort}. */
export interface WaitForPortOptions {
  /** Total number of probe attempts. Default 60. */
  attempts?: number;
  /** Delay between attempts in milliseconds. Default 1000. */
  intervalMs?: number;
  /** Per-attempt connect timeout. Default 500 ms. */
  timeoutMs?: number;
  /**
   * Override the availability probe (tests inject a stub). The default
   * uses {@link isPortAvailable} but inverted: we wait until the port is
   * *not* available (i.e., something is listening).
   */
  isAvailable?: (port: number, host: string, timeoutMs: number) => Promise<boolean>;
}

/**
 * Block until `host:port` accepts TCP connections (i.e., the underlying
 * process has bound the port). Resolves once a connect succeeds. Rejects
 * if `attempts × intervalMs` elapses without a successful connect.
 */
export async function waitForPort(
  target: HostPort,
  options: WaitForPortOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 500;
  const isAvailable = options.isAvailable ?? isPortAvailable;

  for (let i = 0; i < attempts; i++) {
    const free = await isAvailable(target.port, target.host, timeoutMs);
    if (!free) return;
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${target.host}:${target.port} after ${attempts} attempts ` +
      `(~${(attempts * intervalMs) / 1000}s).`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
