/**
 * Minimal JSON-RPC client for the exact-K harness.
 *
 * Plain `fetch` against the node's HTTP endpoint — no web3/ethers
 * dependency, mirroring the repo's zero-runtime-deps stance. The
 * harness only needs a handful of methods, all typed here.
 *
 * Design note: `evm_mine` returns `null` unconditionally on rskj —
 * there is no per-call success signal (the import result is discarded
 * at MinerClientImpl.java:148). The ONLY reliable oracle is
 * `eth_blockNumber` before/after, which is what the scenario layer
 * leans on.
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

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

export interface BlockSummary {
  number: number;
  hash: string;
  parentHash: string;
  txHashes: string[];
  uncleCount: number;
  gasUsed: number;
}

interface RawBlock {
  number: string;
  hash: string;
  parentHash: string;
  transactions: string[];
  uncles: string[];
  gasUsed: string;
}

interface RawReceipt {
  transactionHash: string;
  blockNumber: string | null;
}

export function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

export function numberToHex(value: number): string {
  return `0x${value.toString(16)}`;
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
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) {
      throw new RpcError(method, body.error.code, body.error.message);
    }
    return body.result as T;
  }

  async blockNumber(): Promise<number> {
    return hexToNumber(await this.call<string>("eth_blockNumber"));
  }

  /** One mining round. Returns nothing by design — see module header. */
  async evmMine(): Promise<void> {
    await this.call("evm_mine");
  }

  async accounts(): Promise<string[]> {
    return this.call<string[]>("eth_accounts");
  }

  async clientVersion(): Promise<string> {
    return this.call<string>("web3_clientVersion");
  }

  async transactionCount(address: string, tag: "latest" | "pending"): Promise<number> {
    return hexToNumber(await this.call<string>("eth_getTransactionCount", [address, tag]));
  }

  /**
   * Pending/queued pool sizes, or `null` when the txpool module is
   * unavailable — callers must treat `null` as "unknown", not zero.
   */
  async txpoolStatus(): Promise<{ pending: number; queued: number } | null> {
    try {
      const status = await this.call<{ pending: string; queued: string }>("txpool_status");
      return { pending: hexToNumber(status.pending), queued: hexToNumber(status.queued) };
    } catch {
      return null;
    }
  }

  async getBlockByNumber(height: number): Promise<BlockSummary | null> {
    const raw = await this.call<RawBlock | null>("eth_getBlockByNumber", [
      numberToHex(height),
      false,
    ]);
    if (raw === null) {
      return null;
    }
    return {
      number: hexToNumber(raw.number),
      hash: raw.hash,
      parentHash: raw.parentHash,
      txHashes: raw.transactions,
      uncleCount: raw.uncles.length,
      gasUsed: hexToNumber(raw.gasUsed),
    };
  }

  /** Receipt block number, or `null` when the tx is not mined (or unknown). */
  async receiptBlockNumber(txHash: string): Promise<number | null> {
    const receipt = await this.call<RawReceipt | null>("eth_getTransactionReceipt", [txHash]);
    if (receipt === null || receipt.blockNumber === null) {
      return null;
    }
    return hexToNumber(receipt.blockNumber);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
