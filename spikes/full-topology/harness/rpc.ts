/**
 * Minimal fetch-based JSON-RPC + ABI helpers for the full-topology smoke.
 *
 * Zero runtime deps (the repo's stance): just `fetch`. Only the handful of
 * methods the smoke needs are typed. ABI helpers cover the three Bridge
 * calls — `getFederationAddress()` (returns an ABI-encoded string),
 * `getFeePerKb()` (uint), and `voteFeePerKbChange(int256)`.
 */

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`${method} failed (code ${code}): ${rpcMessage}`);
    this.name = "RpcError";
  }
}

export class RpcClient {
  private nextId = 1;

  constructor(readonly url: string) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (!response.ok) {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new RpcError(method, body.error.code, body.error.message);
    }
    return body.result as T;
  }

  async blockNumber(): Promise<number> {
    return Number.parseInt(await this.call<string>("eth_blockNumber"), 16);
  }

  async blockHashAt(height: number): Promise<string | null> {
    const block = await this.call<{ hash: string } | null>("eth_getBlockByNumber", [
      `0x${height.toString(16)}`,
      false,
    ]);
    return block?.hash ?? null;
  }

  async peerCount(): Promise<number> {
    return Number.parseInt(await this.call<string>("net_peerCount"), 16);
  }

  async evmMine(): Promise<void> {
    await this.call("evm_mine");
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async importRawKey(privateKeyNo0x: string, passphrase: string): Promise<string> {
    return this.call<string>("personal_importRawKey", [privateKeyNo0x, passphrase]);
  }

  async unlockAccount(address: string, passphrase: string, durationSec = 6000): Promise<boolean> {
    // rskj types the duration as HexDurationParam — a hex-quantity STRING,
    // not a JSON number (a number yields HTTP 400 at param binding).
    return this.call<boolean>("personal_unlockAccount", [
      address,
      passphrase,
      `0x${durationSec.toString(16)}`,
    ]);
  }

  async sendTransaction(tx: Record<string, string>): Promise<string> {
    return this.call<string>("eth_sendTransaction", [tx]);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Encode a non-negative integer as a 32-byte (64-hex) big-endian word. */
export function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** Decode a uint256 returned by `eth_call` (single 32-byte word). */
export function decodeUint256(returnData: string): bigint {
  const hex = returnData.startsWith("0x") ? returnData.slice(2) : returnData;
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

/**
 * Decode an ABI-encoded dynamic `string` return (offset word, length
 * word, then UTF-8 bytes right-padded to 32). Used for
 * `getFederationAddress()`.
 */
export function decodeAbiString(returnData: string): string {
  const hex = returnData.startsWith("0x") ? returnData.slice(2) : returnData;
  if (hex.length < 128) return "";
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`)) * 2;
  const bytesHex = hex.slice(offset + 64, offset + 64 + length);
  return Buffer.from(bytesHex, "hex").toString("utf8");
}

/**
 * Poll `fn` until it resolves truthy or the timeout elapses.
 * Returns the satisfying value, or throws with `label` on timeout.
 */
export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms (last: ${String(last)})`);
}
