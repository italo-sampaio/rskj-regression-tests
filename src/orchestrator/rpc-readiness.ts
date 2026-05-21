/**
 * JSON-RPC readiness probe.
 *
 * The port-level wait in `port-utils.ts` only proves the JVM has *bound*
 * the RPC port — it doesn't prove the HTTP RPC handler is wired and
 * answering. To get the latter, we poll `eth_blockNumber` until it
 * returns a successful response.
 *
 * We use the global `fetch` (Node 22+, see `engines` in package.json)
 * with a per-attempt `AbortController` timeout so the loop doesn't hang
 * on a half-dead node that accepts TCP but never replies.
 */

/** Options accepted by {@link waitForRpcReady}. */
export interface RpcReadinessOptions {
  /** Maximum total wait in milliseconds. Default 60 000. */
  timeoutMs?: number;
  /** Delay between attempts in milliseconds. Default 500. */
  pollIntervalMs?: number;
  /** Per-attempt fetch timeout. Default 1500 ms. */
  perAttemptTimeoutMs?: number;
  /** Override `fetch` (tests inject a stub). Default `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /** Optional logger; defaults to a no-op. */
  log?: (line: string) => void;
}

/**
 * Block until `<rpcUrl>` answers `eth_blockNumber` with a JSON-RPC
 * success envelope (`result` is a 0x-prefixed hex string).
 *
 * Rejects with a descriptive error if the timeout elapses.
 */
export async function waitForRpcReady(
  rpcUrl: string,
  options: RpcReadinessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? 1_500;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const log = options.log ?? ((): void => undefined);

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const ok = await probeOnce(fetchFn, rpcUrl, perAttemptTimeoutMs);
      if (ok) {
        log(`[rpc-readiness] ${rpcUrl} ready after ${attempt} attempt(s)`);
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(pollIntervalMs);
  }
  const detail = lastError ? `; last error: ${(lastError as Error).message}` : "";
  throw new Error(`RPC at ${rpcUrl} did not answer eth_blockNumber within ${timeoutMs}ms` + detail);
}

async function probeOnce(
  fetchFn: typeof fetch,
  rpcUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) return false;
    return typeof body.result === "string" && body.result.startsWith("0x");
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
