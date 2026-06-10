/**
 * Concurrent transaction-load generator.
 *
 * Streams value transfers between the ten auto-unlocked regtest "cow"
 * accounts via `eth_sendTransaction` (zero signing deps — rskj regtest
 * seeds and unlocks cow..cow9 at startup, the same mechanism RIT and
 * the k6 suite rely on).
 *
 * Constraints baked in:
 *
 *   - rskj accepts pending/queued nonces only in
 *     `[stateNonce, stateNonce + 16)` (`transaction.accountSlots = 16`).
 *     Under Model B the state nonce only advances when a block is mined,
 *     so the stream caps in-flight txs per account below the slot limit
 *     and tops accounts back up as mining drains the pool.
 *   - Nonces are managed locally (seeded once from
 *     `eth_getTransactionCount(addr, "pending")`, incremented per accepted
 *     send, resynced on nonce errors) — the proven k6 pattern for
 *     sustained streams.
 *   - Errors are classified, counted, and never thrown: the load loop
 *     must keep running while the scenario mines.
 */

import { RpcClient, RpcError, numberToHex, sleep } from "./rpc.js";

export interface TxStreamOptions {
  /** Delay between top-up sweeps across all accounts. */
  intervalMs: number;
  /** Max in-flight (sent-but-unmined) txs per account; must stay < 16. */
  maxInFlightPerAccount: number;
}

export interface TxStreamStats {
  attempted: number;
  accepted: number;
  errorsByKind: Record<string, number>;
  acceptedHashes: string[];
}

function classifyError(error: unknown): string {
  const message = error instanceof RpcError ? error.rpcMessage : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("nonce too low")) return "nonce-too-low";
  if (lowered.includes("nonce too high")) return "nonce-too-high";
  if (lowered.includes("known transaction")) return "known-transaction";
  if (lowered.includes("exceeds quota")) return "account-quota";
  if (lowered.includes("gas price not enough")) return "gas-price-bump";
  return `other: ${message.slice(0, 80)}`;
}

export class TxStream {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly localNonce = new Map<string, number>();
  private readonly confirmedNonce = new Map<string, number>();
  private readonly acceptedHashes: string[] = [];
  private readonly errorsByKind: Record<string, number> = {};
  private attempted = 0;

  constructor(
    private readonly rpc: RpcClient,
    private readonly accounts: string[],
    private readonly options: TxStreamOptions,
  ) {
    if (accounts.length < 2) {
      throw new Error(`TxStream needs >= 2 accounts, got ${accounts.length}`);
    }
  }

  async start(): Promise<void> {
    for (const account of this.accounts) {
      this.localNonce.set(account, await this.rpc.transactionCount(account, "pending"));
      this.confirmedNonce.set(account, await this.rpc.transactionCount(account, "latest"));
    }
    this.running = true;
    this.loopPromise = this.loop();
  }

  /** Stop the stream and wait until no send is in flight. */
  async stop(): Promise<TxStreamStats> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    return this.stats();
  }

  stats(): TxStreamStats {
    return {
      attempted: this.attempted,
      accepted: this.acceptedHashes.length,
      errorsByKind: { ...this.errorsByKind },
      acceptedHashes: [...this.acceptedHashes],
    };
  }

  private async loop(): Promise<void> {
    let lastConfirmedRefresh = 0;
    while (this.running) {
      const now = Date.now();
      if (now - lastConfirmedRefresh > 200) {
        lastConfirmedRefresh = now;
        await this.refreshConfirmedNonces();
      }
      const sends: Promise<void>[] = [];
      for (let i = 0; i < this.accounts.length; i++) {
        const from = this.accounts[i]!;
        const inFlight = (this.localNonce.get(from) ?? 0) - (this.confirmedNonce.get(from) ?? 0);
        if (inFlight >= this.options.maxInFlightPerAccount) {
          continue;
        }
        const to = this.accounts[(i + 1) % this.accounts.length]!;
        sends.push(this.sendOne(from, to));
      }
      await Promise.all(sends);
      await sleep(this.options.intervalMs);
    }
  }

  private async refreshConfirmedNonces(): Promise<void> {
    await Promise.all(
      this.accounts.map(async (account) => {
        try {
          this.confirmedNonce.set(account, await this.rpc.transactionCount(account, "latest"));
        } catch {
          // transient RPC failure — keep the stale value, retry next sweep
        }
      }),
    );
  }

  private async sendOne(from: string, to: string): Promise<void> {
    const nonce = this.localNonce.get(from) ?? 0;
    this.attempted++;
    try {
      const hash = await this.rpc.call<string>("eth_sendTransaction", [
        {
          from,
          to,
          value: "0x1",
          gas: "0x5208",
          gasPrice: "0x1",
          nonce: numberToHex(nonce),
        },
      ]);
      this.acceptedHashes.push(hash);
      this.localNonce.set(from, nonce + 1);
    } catch (error) {
      const kind = classifyError(error);
      this.errorsByKind[kind] = (this.errorsByKind[kind] ?? 0) + 1;
      if (kind === "nonce-too-low" || kind === "nonce-too-high") {
        try {
          this.localNonce.set(from, await this.rpc.transactionCount(from, "pending"));
        } catch {
          // resync failed — next sweep will try again
        }
      }
    }
  }
}
